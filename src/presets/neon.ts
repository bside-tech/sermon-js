import { definePreset, type PresetOptions } from "../config";
import type { CheckOutcome, Instance, Usage } from "../types";
import { bearer, round } from "./providers/shared";

export type NeonProjectOptions = PresetOptions & {
  projectId: string | undefined;
  /** A Neon API key (account, organization or project-scoped) */
  secrets: { apiKey: string | undefined };
  /**
   * Runs one statement with the driver you already use, e.g. `(sql) => pool.query(sql)`.
   * `select 1` is only sent while the compute is active, so a check never wakes the database.
   */
  query?: (sql: string) => Promise<unknown>;
  /**
   * The compute `query` connects to: the `ep-…` part of the connection host.
   * Default: the read-write compute of the default branch.
   */
  endpoint?: string;
  track?: {
    /** Your plan's compute allowance for the billing period, in CU-hours: adds a usage bar */
    compute?: { maxHours: number; warnAbovePct?: number };
    /** Your plan's storage allowance in GB: adds a usage bar (sum of the branches' logical sizes) */
    storage?: { maxGb: number; warnAbovePct?: number };
  };
};

type NeonEndpoint = {
  id: string;
  branch_id: string;
  region_id?: string;
  type: "read_write" | "read_only";
  current_state: "init" | "active" | "idle";
  disabled?: boolean;
};
type NeonBranch = { id: string; name: string; default?: boolean; logical_size?: number };
type NeonProject = {
  pg_version?: number;
  region_id?: string;
  compute_time_seconds?: number;
  consumption_period_end?: string;
};

const API = "https://console.neon.tech/api/v2";
const GB = 1024 ** 3;

/** One key per compute, stable across restarts: the branch name, suffixed for replicas */
function withKeys(endpoints: NeonEndpoint[], branches: Map<string, NeonBranch>) {
  const seen = new Map<string, number>();
  return endpoints.map((endpoint) => {
    const name = branches.get(endpoint.branch_id)?.name ?? endpoint.branch_id;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    return { endpoint, key: count === 1 ? name : `${name}#${count}` };
  });
}

/**
 * A Neon project, checked **without ever waking a compute**: states come from the Neon API
 * (control plane), and `query` only runs while its compute is already active.
 * - up: the compute is active (and answers `select 1` when `query` is given)
 * - sleeping: the compute is suspended (scale to zero)
 * - degraded: a compute is starting, a usage bar is near its limit, or the Neon API can't be read
 * - down: the project doesn't exist, it has no compute, or an active compute doesn't answer
 *
 * Reports one `instances` row per compute (branch, region, state), `metrics.postgres`,
 * `metrics.region`, `metrics.branches`, `metrics.computes`, and `usage` bars for the
 * allowances given in `track`.
 */
const project = definePreset<NeonProjectOptions>()({
  kind: "neon.project",
  requiredFields: ["projectId"],
  requiredSecrets: ["apiKey"],
  defaults: { slowMs: 1000 },
  derive: (options) => ({
    name: "Neon",
    identity: `neon.project:${options.projectId ?? ""}`,
    description: "Compute states from the Neon API, then `select 1` on an active compute only",
  }),
  check: async ({ options, secrets, http, measure }): Promise<CheckOutcome> => {
    const base = `${API}/projects/${encodeURIComponent(options.projectId as string)}`;
    const headers = { ...bearer(secrets.apiKey), accept: "application/json" };
    const [list, info, branchList] = await Promise.all([
      http(`${base}/endpoints`, { headers }),
      http(base, { headers }),
      http(`${base}/branches`, { headers }),
    ]);

    if (list.status === 404) {
      return { status: "down", probed: false, httpStatus: 404, error: `Project "${options.projectId}" not found on Neon` };
    }
    const endpoints = (list.json as { endpoints?: NeonEndpoint[] })?.endpoints;
    if (!list.ok || !Array.isArray(endpoints)) {
      // Our view of Neon is broken, not necessarily the database
      return {
        status: "degraded",
        probed: false,
        httpStatus: list.status,
        error: list.status ? `Neon API HTTP ${list.status}` : `Neon API unreachable: ${list.outcome.error ?? "no response"}`,
      };
    }
    if (endpoints.length === 0) return { status: "down", probed: false, error: "No compute: nothing can connect" };

    // Informative only: a key that can't read them still gives the compute states
    const branches = ((branchList.json as { branches?: NeonBranch[] })?.branches ?? []) as NeonBranch[];
    const details = (info.json as { project?: NeonProject })?.project;
    const byId = new Map(branches.map((branch) => [branch.id, branch]));
    const defaultBranch = branches.find((branch) => branch.default)?.id;

    const keyed = withKeys(endpoints, byId);
    const target =
      keyed.find(({ endpoint }) => endpoint.id === options.endpoint) ??
      (options.endpoint
        ? undefined
        : (keyed.find(({ endpoint }) => endpoint.type === "read_write" && endpoint.branch_id === defaultBranch) ??
          keyed.find(({ endpoint }) => endpoint.type === "read_write")));

    const ping =
      options.query && target?.endpoint.current_state === "active" && !target.endpoint.disabled
        ? await measure(async () => void (await (options.query as (sql: string) => Promise<unknown>)("select 1")))
        : undefined;

    const instances = keyed.map(({ endpoint, key }): Instance => {
      const row = { key, region: endpoint.region_id, id: endpoint.id };
      if (endpoint.disabled) return { ...row, state: "disabled", status: "sleeping" };
      if (endpoint.current_state === "idle") return { ...row, state: "idle", status: "sleeping" };
      if (endpoint.current_state !== "active") return { ...row, state: endpoint.current_state, status: "degraded" };
      if (ping && endpoint.id === target?.endpoint.id) {
        return { ...row, state: "active", status: ping.status, latencyMs: ping.latencyMs, error: ping.error };
      }
      return { ...row, state: "active", status: "up" };
    });

    const usage: Usage[] = [];
    const warnings: string[] = [];
    const bar = (entry: Usage, warnAbovePct = 90) => {
      usage.push(entry);
      if (entry.limit > 0 && (entry.used / entry.limit) * 100 >= warnAbovePct) warnings.push(`${entry.label} close to the plan limit`);
    };
    const compute = options.track?.compute;
    if (compute && typeof details?.compute_time_seconds === "number") {
      bar(
        {
          label: "Compute this period",
          used: round(details.compute_time_seconds / 3600),
          limit: compute.maxHours,
          unit: "CU-hours",
          resetsAt: details.consumption_period_end ? Date.parse(details.consumption_period_end) || undefined : undefined,
        },
        compute.warnAbovePct
      );
    }
    const storage = options.track?.storage;
    if (storage && branches.length > 0) {
      const bytes = branches.reduce((sum, branch) => sum + (branch.logical_size ?? 0), 0);
      bar({ label: "Storage", used: round(bytes / GB, 2), limit: storage.maxGb, unit: "GB" }, storage.warnAbovePct);
    }

    // The compute applications connect to decides; the others only show on their rows
    const main = instances.find((instance) => instance.id === target?.endpoint.id) ?? instances[0]!;
    const active = instances.filter((instance) => instance.state === "active").length;
    let status = main.status;
    let error = main.error;
    if (status === "degraded" && !error) error = `Compute is ${main.state}`;
    if ((status === "up" || status === "sleeping") && warnings.length) {
      status = "degraded";
      error = warnings.join("; ");
    }

    return {
      status,
      probed: !!ping,
      latencyMs: ping?.latencyMs ?? list.latencyMs,
      error,
      metrics: {
        ...(details?.pg_version ? { postgres: details.pg_version } : {}),
        ...(details?.region_id ? { region: details.region_id } : {}),
        ...(branches.length ? { branches: branches.length } : {}),
        computes: `${active}/${instances.length} active`,
      },
      usage: usage.length ? usage : undefined,
      instances,
      instanceLabels: { key: "Compute", detail: "Endpoint" },
    };
  },
});

/** Presets for Neon */
export const neon = { project };
