import type { CheckOutcome, CheckReturn, HttpInit, HttpResult, OutcomeStatus, Status } from "./types";

const SEVERITY: Record<Status, number> = { up: 0, sleeping: 0, unconfigured: 0, degraded: 1, down: 2 };

/** Human message for anything thrown, surfacing the real network reason when there is one */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "Timed out";
    // fetch implementations hide the reason (ECONNREFUSED, ENOTFOUND, TLS…) in `cause`
    const cause = (error as Error & { cause?: unknown }).cause as
      | (Error & { code?: string; errors?: Array<Error & { code?: string }> })
      | undefined;
    const detail = cause?.code ?? cause?.errors?.[0]?.code ?? cause?.message;
    return detail ? `${error.message}: ${detail}` : error.message;
  }
  return String(error);
}

function snippet(text: string) {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
}

/**
 * The public error for a failed HTTP answer. Bodies of rejected credentials are left out:
 * providers echo the key back there, often only partly masked.
 */
function httpError({ status, text }: { status: number; text: string }) {
  if (status === 401 || status === 407) return `HTTP ${status}: credentials rejected`;
  if (status === 403) return "HTTP 403: access denied";
  return `HTTP ${status}${text ? `: ${snippet(text)}` : ""}`;
}

/** `true`/nothing → up, `false` → down, outcomes pass through */
export function normalizeReturn(value: CheckReturn): CheckOutcome {
  if (value === undefined || value === null || value === true) return { status: "up" };
  if (value === false) return { status: "down" };
  return value;
}

/**
 * Timed `fetch` that never throws. Redirects are not followed by default, so a 3xx
 * counts as a healthy answer from the target itself.
 */
export function createHttp({
  timeoutMs,
  signal,
  fetch: fetchImpl = fetch,
  redact = (text) => text,
}: {
  timeoutMs: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Removes secrets from response bodies before they are cut into error messages */
  redact?: (text: string) => string;
}) {
  return async function http(url: string, init: HttpInit = {}): Promise<HttpResult> {
    const { okStatuses, ...requestInit } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();

    const start = performance.now();
    const elapsed = () => Math.round(performance.now() - start);
    try {
      const res = await fetchImpl(url, {
        redirect: "manual",
        ...requestInit,
        signal: controller.signal,
      });
      const text = await res.text();
      const latencyMs = elapsed();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      const ok = res.status < 400 || !!okStatuses?.includes(res.status);
      const outcome: CheckOutcome = ok
        ? { status: "up", latencyMs, httpStatus: res.status }
        : {
            status: res.status === 429 ? "degraded" : "down",
            latencyMs,
            httpStatus: res.status,
            error: httpError({ status: res.status, text: redact(text) }),
          };
      return { ok, status: res.status, latencyMs, text, json, headers: res.headers, outcome };
    } catch (error) {
      const latencyMs = elapsed();
      return {
        ok: false,
        latencyMs,
        text: "",
        json: undefined,
        outcome: { status: "down", error: errorMessage(error) },
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** Times any async call; a throw becomes a down outcome */
export async function measure(fn: () => Promise<CheckReturn>): Promise<CheckOutcome> {
  const start = performance.now();
  try {
    const outcome = normalizeReturn(await fn());
    return { ...outcome, latencyMs: outcome.latencyMs ?? Math.round(performance.now() - start) };
  } catch (error) {
    return { status: "down", latencyMs: Math.round(performance.now() - start), error: errorMessage(error) };
  }
}

/**
 * Merges several probes of the same service run in parallel:
 * worst status wins, latency is the slowest call, metrics/usage/errors are merged.
 */
export function combine(outcomes: CheckOutcome[]): CheckOutcome {
  if (outcomes.length === 0) return { status: "up" };
  const worst = outcomes.reduce((a, b) => (SEVERITY[b.status] > SEVERITY[a.status] ? b : a));
  const latencies = outcomes.map((o) => o.latencyMs).filter((l): l is number => l !== undefined);
  const errors = outcomes.map((o) => o.error).filter((e): e is string => !!e);
  const usage = outcomes.flatMap((o) => o.usage ?? []);
  const instances = outcomes.flatMap((o) => o.instances ?? []);
  const metrics = Object.assign({}, ...outcomes.map((o) => o.metrics ?? {})) as CheckOutcome["metrics"];
  return {
    status: worst.status as OutcomeStatus,
    latencyMs: latencies.length ? Math.max(...latencies) : undefined,
    httpStatus: worst.httpStatus,
    error: errors.length ? errors.join("; ") : undefined,
    metrics: metrics && Object.keys(metrics).length ? metrics : undefined,
    usage: usage.length ? usage : undefined,
    instances: instances.length ? instances : undefined,
    probed: outcomes.some((o) => o.probed !== false),
  };
}
