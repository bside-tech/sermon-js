/** The five statuses every service reports */
export type Status = "up" | "degraded" | "down" | "sleeping" | "unconfigured";

/** What a check itself can report: "unconfigured" is decided by the library, never by a check */
export type OutcomeStatus = Exclude<Status, "unconfigured">;

export type ScoreLabel = "operational" | "degraded" | "outage" | "unknown";

/** Small labelled values shown as chips (balance, machine count, VM state…) */
export type Metrics = Record<string, string | number>;

/** A consumable quota, rendered as a usage bar */
export type Usage = {
  label: string;
  used: number;
  limit: number;
  unit?: string;
  /** When the quota resets (ms epoch), if the provider says */
  resetsAt?: number;
};

/** One machine/region of a multi-instance service, tracked individually */
export type Instance = {
  /** Stable across deploys (e.g. the region, suffixed when a region runs several machines) */
  key: string;
  region?: string;
  /** Platform identifier of the machine/instance */
  id?: string;
  /** Raw platform state: started, suspended, RUNNING… */
  state?: string;
  status: OutcomeStatus;
  latencyMs?: number;
  httpStatus?: number;
  error?: string;
};

/** What a check returns */
export type CheckOutcome = {
  status: OutcomeStatus;
  /** Measured for you (wall time of the check) when omitted */
  latencyMs?: number;
  httpStatus?: number;
  /** Shown publicly: secrets are redacted and long text is truncated */
  error?: string;
  metrics?: Metrics;
  usage?: Usage[];
  instances?: Instance[];
  /**
   * What the instances are, for the headings of their table: `key` names the first column
   * (default "Region"), `detail` the one showing each instance's id and state (default
   * "Machine"; left blank when only `key` is given).
   */
  instanceLabels?: { key: string; detail?: string };
  /** Set to false when the target was deliberately not touched (e.g. a sleeping machine) */
  probed?: boolean;
};

/** `true`/nothing → up, `false` → down, or a full outcome */
export type CheckReturn = CheckOutcome | boolean | void;

/** The stored result of one check run */
export type CheckResult = Omit<CheckOutcome, "status" | "probed"> & {
  key: string;
  status: Status;
  checkedAt: number;
  probed: boolean;
};

export type HttpInit = RequestInit & {
  /** Extra statuses that mean "reachable and healthy" besides 2xx/3xx */
  okStatuses?: number[];
};

export type HttpResult = {
  /** 2xx/3xx, or one of `okStatuses` */
  ok: boolean;
  /** Undefined when the request never got a response (network error, timeout) */
  status?: number;
  latencyMs: number;
  text: string;
  /** Parsed body, or undefined when it isn't JSON */
  json: unknown;
  headers?: Headers;
  /** Ready-made outcome: 2xx/3xx up, 429 degraded, anything else down */
  outcome: CheckOutcome;
};

export type ProbeHelpers = {
  /** Timed `fetch` that never throws */
  http: (url: string, init?: HttpInit) => Promise<HttpResult>;
  /** Times any async call (SDK, database, TCP…); a throw becomes a down outcome */
  measure: (fn: () => Promise<CheckReturn>) => Promise<CheckOutcome>;
  /** Merges several probes of the same service: worst status wins */
  combine: (outcomes: CheckOutcome[]) => CheckOutcome;
};

/** Small key/value cache backed by the store, for checks that keep state between runs */
export type CheckCache = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlMs: number) => Promise<void>;
};

export type CheckContext<Secrets extends SecretsInput = SecretsInput> = ProbeHelpers & {
  /** The secrets given to the service; every key is guaranteed non-empty */
  secrets: { [K in keyof Secrets]-?: string };
  /** Aborted when the check's time budget is over */
  signal: AbortSignal;
  timeoutMs: number;
  /** Latency above this turns "up" into "degraded" */
  slowMs: number;
  cache: CheckCache;
  now: number;
};

export type SecretsInput = Record<string, string | undefined>;

/** Options shared by every service (the five concerns, minus what the preset defines) */
export type CommonOptions = {
  /** How to call it */
  name?: string;
  description?: string;
  /** Critical services weigh more in the score, and one being down means "outage" */
  critical?: boolean;
  /** Latency above this turns "up" into "degraded" (default 2000) */
  slowMs?: number;
  /** Hard cap for one check (default 10000) */
  timeoutMs?: number;
};

/** Per-service statistics computed from history */
export type InstanceStats = { uptime24h: number | null; p50: number | null; samples24h: number };

export type ServiceStats = {
  /** Share of runs that were not "down", in percent */
  uptime24h: number | null;
  uptime7d: number | null;
  p50: number | null;
  p95: number | null;
  samples24h: number;
  /** Latency series over the last 24h, oldest first (for sparklines) */
  latency: Array<number | null>;
  lastFailure?: { at: number; status: Status; error?: string };
  instances?: Record<string, InstanceStats>;
};

export type ServiceSnapshot = {
  type: "service";
  /** Derived, internal: only used for anchors, single-service runs and history routes */
  key: string;
  /** The preset kind: "custom", "generic.http", "fly.app"… */
  kind: string;
  name: string;
  description?: string;
  critical: boolean;
  slowMs: number;
  configured: boolean;
  /** Which required secrets/fields are missing when not configured */
  missing?: string[];
  result?: CheckResult;
  stats?: ServiceStats;
};

export type GroupSnapshot = {
  type: "group";
  key: string;
  title: string;
  description?: string;
  children: SnapshotNode[];
};

export type SnapshotNode = GroupSnapshot | ServiceSnapshot;

export type Trigger = "scheduled" | "manual";

export type StatusSnapshot = {
  schemaVersion: 1;
  /**
   * "public" when the snapshot was reduced for an anonymous viewer: the tree then holds one row
   * per top-level group (services of kind "group") and nothing about individual services.
   * Absent or "full" otherwise.
   */
  view?: "full" | "public";
  generatedAt: number;
  /** Most recent check of any service */
  lastCheckedAt: number | null;
  /** Last run of every service, and how it was triggered */
  lastRunAt: number | null;
  lastRunTrigger: Trigger | null;
  /** When the next full run is due, based on `interval` */
  nextDueAt: number | null;
  intervalMs: number;
  /** How long history is kept */
  retentionMs: number;
  score: number | null;
  label: ScoreLabel;
  counts: Record<Status, number>;
  tree: SnapshotNode[];
  /**
   * Set on a snapshot of the past (`snapshotAt`): the period it covers and how many runs
   * happened in it. Each service then shows its worst result of the period.
   */
  period?: { start: number; end: number; runs: number };
};

export type HistoryRange = "24h" | "7d";

export type HistoryBar = {
  start: number;
  /** Worst score in the bucket; null when no run happened */
  score: number | null;
  label: ScoreLabel;
  runs: number;
  /** Services that were degraded or down in the bucket ("down" wins) */
  failing: Record<string, Status>;
};

export type HistoryPayload = { schemaVersion: 1; range: HistoryRange; bucketMs: number; bars: HistoryBar[] };
