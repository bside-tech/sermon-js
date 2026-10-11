import { definePreset, type PresetOptions } from "../config";
import type { CheckOutcome, Instance, OutcomeStatus } from "../types";

export type FlyAppOptions = PresetOptions & {
  /** The Fly app name, e.g. "my-api" */
  app: string;
  secrets: {
    /** A Fly API token. A read-only one is enough: `fly tokens create readonly` */
    token: string | undefined;
  };
  track?: {
    /**
     * Health path probed on each machine that is already running (default "/").
     * Pass `false` to only read machine states. `anyStatus` accepts any HTTP answer,
     * e.g. for servers that answer 404 on their root.
     */
    health?: string | false | { path?: string; anyStatus?: boolean };
    /** Report every machine individually (default true) */
    machines?: boolean;
  };
};

type FlyMachineEvent = {
  type?: string;
  timestamp?: number;
  request?: { exit_event?: { exit_code?: number; oom_killed?: boolean; requested_stop?: boolean } };
};

type FlyMachine = {
  id: string;
  state: string;
  region?: string;
  checks?: Array<{ name: string; status: string }>;
  events?: FlyMachineEvent[];
};

const MACHINES_API = "https://api.machines.dev/v1";
const GONE_STATES = new Set(["destroyed", "destroying"]);
/** Asleep on purpose (scale to zero), or getting there, or waking up: never probed */
const RESTING_STATES = new Set(["stopped", "suspended", "stopping", "suspending", "starting", "created"]);

/** Last exit of a stopped machine, if it was a crash rather than a scale-to-zero stop */
export function crashReason(machine: { events?: FlyMachineEvent[] }): string | undefined {
  const exit = [...(machine.events ?? [])]
    .filter((event) => event.type === "exit")
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0]?.request?.exit_event;
  if (!exit || exit.requested_stop) return undefined;
  if (exit.oom_killed) return "Out of memory";
  if (exit.exit_code !== undefined && exit.exit_code !== 0) return `Crashed (exit code ${exit.exit_code})`;
  return undefined;
}

/** Region code as key, suffixed (#2, #3…) when a region runs several machines */
function withKeys(machines: FlyMachine[]) {
  const seen = new Map<string, number>();
  return [...machines]
    .sort((a, b) => (a.region ?? "").localeCompare(b.region ?? "") || a.id.localeCompare(b.id))
    .map((machine) => {
      const region = machine.region ?? "unknown";
      const count = (seen.get(region) ?? 0) + 1;
      seen.set(region, count);
      return { machine, region, key: count === 1 ? region : `${region}#${count}` };
    });
}

function median(values: number[]) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * A Fly.io app, checked without ever waking it:
 * 1. Machine states come from the Machines API (control plane: it never starts anything).
 * 2. Each machine that is already `started` gets its health path probed, pinned to that
 *    machine with `fly-force-instance-id`, so the Fly proxy never starts another one.
 * 3. A stopped machine whose last exit was a crash or an out-of-memory kill is down, not asleep.
 *
 * | Status | When |
 * |---|---|
 * | up | every running machine is healthy |
 * | sleeping | all machines are stopped or suspended, without a crash |
 * | degraded | some machines are down, a Fly health check fails, one is slow, or the Machines API can't be read |
 * | down | no machines, the app doesn't exist, or every machine is down |
 *
 * Reports `metrics.machines` ("2/5 running") and one `instances` row per machine.
 */
const app = definePreset<FlyAppOptions>()({
  kind: "fly.app",
  requiredFields: ["app"],
  requiredSecrets: ["token"],
  defaults: { slowMs: 1500 },
  derive: (options) => ({
    name: options.app,
    identity: `fly.app:${options.app}`,
    description: `Fly app "${options.app}": machine states, then health on running machines only`,
  }),
  check: async ({ options, secrets, http, slowMs }): Promise<CheckOutcome> => {
    const health = options.track?.health ?? "/";
    const healthPath = health === false ? undefined : typeof health === "string" ? health : (health.path ?? "/");
    const anyStatus = typeof health === "object" && !!health.anyStatus;

    const list = await http(`${MACHINES_API}/apps/${encodeURIComponent(options.app)}/machines`, {
      headers: { Authorization: `Bearer ${secrets.token}` },
    });
    if (list.status === 404) {
      return { status: "down", probed: false, httpStatus: 404, error: `App "${options.app}" not found on Fly` };
    }
    if (!list.ok || !Array.isArray(list.json)) {
      // Our view of Fly is broken, not necessarily the app
      return {
        status: "degraded",
        probed: false,
        httpStatus: list.status,
        error: list.status
          ? `Fly Machines API HTTP ${list.status}`
          : `Fly Machines API unreachable: ${list.outcome.error ?? "no response"}`,
      };
    }

    const machines = (list.json as FlyMachine[]).filter((machine) => !GONE_STATES.has(machine.state));
    if (machines.length === 0) {
      return { status: "down", probed: false, error: "No machines: the app has no capacity at all" };
    }

    const instances: Instance[] = await Promise.all(
      withKeys(machines).map(async ({ machine, region, key }): Promise<Instance> => {
        const base = { key, region, id: machine.id, state: machine.state };

        if (machine.state === "failed") return { ...base, status: "down", error: "Machine failed" };
        if (machine.state !== "started") {
          const crash = machine.state === "stopped" ? crashReason(machine) : undefined;
          if (crash) return { ...base, status: "down", error: crash };
          return { ...base, status: RESTING_STATES.has(machine.state) ? "sleeping" : "degraded" };
        }

        const failingChecks = (machine.checks ?? []).filter((c) => c.status !== "passing").map((c) => c.name);
        const checksError = failingChecks.length ? `Fly health checks failing: ${failingChecks.join(", ")}` : undefined;
        if (!healthPath) {
          return { ...base, status: checksError ? "degraded" : "up", error: checksError };
        }

        const probe = await http(`https://${options.app}.fly.dev${healthPath}`, {
          headers: { "fly-force-instance-id": machine.id },
          okStatuses: anyStatus ? [400, 401, 403, 404, 405, 421] : undefined,
        });
        let status: OutcomeStatus = probe.outcome.status;
        let error = probe.outcome.error;
        if (status === "up" && checksError) {
          status = "degraded";
          error = checksError;
        } else if (status === "up" && probe.latencyMs > slowMs) {
          status = "degraded";
          error = `Slow response: ${probe.latencyMs} ms`;
        }
        return {
          ...base,
          status,
          latencyMs: probe.status === undefined ? undefined : probe.latencyMs,
          httpStatus: probe.status,
          error,
        };
      })
    );

    const down = instances.filter((instance) => instance.status === "down");
    const degraded = instances.filter((instance) => instance.status === "degraded");
    const awake = instances.filter((instance) => instance.status === "up" || instance.status === "degraded");
    const keysOf = (items: Instance[]) => items.map((instance) => instance.key).join(", ");

    let status: OutcomeStatus;
    let error: string | undefined;
    if (down.length === instances.length) {
      status = "down";
      error = `All ${instances.length} machine(s) down`;
    } else if (down.length > 0) {
      status = "degraded";
      error = `${down.length}/${instances.length} machine(s) down: ${keysOf(down)}`;
    } else if (degraded.length > 0) {
      status = "degraded";
      error = `Degraded in ${keysOf(degraded)}`;
    } else {
      status = awake.length ? "up" : "sleeping";
    }

    const probed = instances.some((instance) => instance.httpStatus !== undefined || instance.latencyMs !== undefined);
    return {
      status,
      probed,
      // Median of the machines we probed; each machine keeps its own latency
      latencyMs: median(instances.map((i) => i.latencyMs).filter((l): l is number => l !== undefined)),
      error,
      metrics: { machines: `${awake.length}/${instances.length} running` },
      instances: options.track?.machines === false ? undefined : instances,
    };
  },
});

/** Presets for Fly.io */
export const fly = { app };
