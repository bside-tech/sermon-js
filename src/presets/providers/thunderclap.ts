import { definePreset, type PresetOptions } from "../../config";
import type { CheckOutcome, CheckReturn, Metrics, Usage } from "../../types";
import { bearer, call } from "./shared";

export type ThunderclapOptions = PresetOptions & {
  /** The realtime server (default "https://realtime.thunderclap.dev"), e.g. Thunderclap Local's URL */
  url?: string;
  /** Where the Usage API lives (default "https://thunderclap.dev") */
  apiUrl?: string;
  /**
   * The app's public key (`pk_…`, safe in client code). Given, the check also opens a client
   * WebSocket connection and waits for the server to accept it.
   */
  key?: string;
  /**
   * `orgApiKey`: an organisation API key (`tc_org_…`) with the `usage:read` scope, created on the
   * organisation's API keys page (app secrets don't work). Without it, only `/health` is checked.
   */
  secrets?: { orgApiKey?: string | undefined };
  track?: {
    /** Usage against the plan's included amounts, for the current UTC month. `false` skips the Usage API */
    usage?:
      | false
      | {
          /** Warn when connections or messages reach this share of the plan (default 90) */
          warnAbovePct?: number;
        };
  };
};

const DEFAULT_URL = "https://realtime.thunderclap.dev";
const DEFAULT_API_URL = "https://thunderclap.dev";

type Summary = {
  period?: { from?: string; to?: string };
  plan?: { id?: string; name?: string; connections?: number | null; messages?: number | null } | null;
  connections?: { peak?: number; p95?: number };
  messages?: { total?: number };
};

function parse(text: unknown): unknown {
  try {
    return JSON.parse(String(text));
  } catch {
    return undefined;
  }
}

/** Opens a client connection over the Pusher-compatible protocol and waits for the handshake */
function connect(base: string, key: string, signal: AbortSignal): Promise<CheckReturn> {
  if (typeof WebSocket === "undefined") {
    return Promise.resolve({ status: "degraded", error: "No WebSocket in this runtime: client connection not checked" });
  }
  const url = `${base.replace(/^http/, "ws")}/app/${encodeURIComponent(key)}?protocol=7&client=sermon-js&version=1`;
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(url);
    const finish = (outcome: CheckReturn) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000);
      resolve(outcome);
    };
    const onAbort = () => finish({ status: "down", error: "Client connection timed out" });
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort);

    socket.addEventListener("message", (event) => {
      const message = parse(event.data) as { event?: string; data?: unknown } | undefined;
      if (message?.event === "pusher:connection_established") return finish({ status: "up" });
      if (message?.event === "pusher:error") {
        // Pusher servers may send `data` as a JSON string
        const data = (typeof message.data === "string" ? parse(message.data) : message.data) as
          | { code?: number; message?: string }
          | undefined;
        finish({ status: "down", error: `Client connection refused: ${data?.message ?? "error"} (${data?.code ?? "?"})` });
      }
    });
    socket.addEventListener("close", (event) =>
      finish({ status: "down", error: `Client connection closed before the handshake (${event.code})` })
    );
    socket.addEventListener("error", () => finish({ status: "down", error: "Client connection failed" }));
  });
}

function usageOutcome(summary: Summary, warnAbovePct: number): CheckReturn {
  const peak = summary.connections?.peak ?? 0;
  const p95 = summary.connections?.p95 ?? 0;
  const messages = summary.messages?.total ?? 0;
  const resetsAt = summary.period?.to ? Date.parse(summary.period.to) : undefined;
  const plan = summary.plan;

  const metrics: Metrics = { connectionsP95: p95 };
  if (plan?.name) metrics.plan = plan.name;
  const usage: Usage[] = [];
  const warnings: string[] = [];
  const track = (label: string, used: number, limit: number | null | undefined, unit: string, key: string) => {
    if (!limit) {
      metrics[key] = used;
      return;
    }
    usage.push({ label, used, limit, unit, resetsAt });
    if ((used / limit) * 100 >= warnAbovePct) warnings.push(`${label} close to the plan limit`);
  };
  // The peak, not the billed p95: it is what the free plan caps, and it errs on the safe side
  track("Peak connections this month", peak, plan?.connections, "connections", "peakConnections");
  track("Messages this month", messages, plan?.messages, "messages", "messages");

  return {
    status: warnings.length ? "degraded" : "up",
    error: warnings.join("; ") || undefined,
    metrics,
    usage: usage.length ? usage : undefined,
  };
}

/**
 * Thunderclap realtime. Calls the realtime server's `/health`; with `key`, opens a client
 * WebSocket connection (Pusher-compatible protocol) and waits for `pusher:connection_established`;
 * with `secrets.orgApiKey`, reads the Usage API's monthly summary. All in parallel.
 * - up: `/health` answers `{"status":"ok"}`, the client connection is accepted, and usage is
 *   under the threshold
 * - degraded: `/health` answers something else (it isn't documented, so it may change), usage
 *   reaches `warnAbovePct` of the plan, or the Usage API rate-limits the key
 * - down: the server is unreachable or errors, the client connection is refused (unknown or
 *   disabled key, over the connection limit) or doesn't complete, or the Usage API rejects the key
 *
 * The client connection is closed as soon as it is accepted, and counts toward your connections
 * for that moment. Runtimes without a global `WebSocket` (Node 20) skip it, as degraded.
 *
 * Reports `metrics.plan` and `metrics.connectionsP95` (the billed figure); `usage` bars for peak
 * connections and messages against the plan, reset at the end of the UTC month. Custom plans
 * have no included amounts, so the counts become `metrics.peakConnections` and `metrics.messages`.
 * Usage is rolled up every 10 minutes and the API allows 60 requests a minute per key.
 */
export const thunderclap = definePreset<ThunderclapOptions>()({
  kind: "thunderclap",
  defaults: { slowMs: 1500 },
  derive: (options) => {
    let host = options.url || DEFAULT_URL;
    try {
      host = new URL(host).host;
    } catch {
      // Keep the raw value: the check will report the bad URL
    }
    return {
      name: "Thunderclap",
      identity: `thunderclap:${host}`,
      description: options.key
        ? "Checks the realtime server's health, a client connection, and the month's usage"
        : "Checks the realtime server's health and the month's usage against the plan",
    };
  },
  check: async ({ options, secrets, http, measure, combine, signal }): Promise<CheckOutcome> => {
    const base = (options.url || DEFAULT_URL).replace(/\/+$/, "");
    const health = call(http, `${base}/health`, undefined, (res) =>
      (res.json as { status?: string })?.status === "ok"
        ? undefined
        : { status: "degraded", error: "Unexpected answer from /health" }
    );
    const probes = [health];
    if (options.key) probes.push(measure(() => connect(base, options.key as string, signal)));

    const tracked = options.track?.usage;
    if (secrets.orgApiKey && tracked !== false) {
      const apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
      probes.push(
        call(http, `${apiUrl}/api/v1/usage/summary`, { headers: bearer(secrets.orgApiKey) }, (res) =>
          usageOutcome(res.json as Summary, tracked?.warnAbovePct ?? 90)
        )
      );
    }
    return probes.length === 1 ? health : combine(await Promise.all(probes));
  },
});
