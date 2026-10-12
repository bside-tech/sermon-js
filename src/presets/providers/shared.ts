import { normalizeReturn } from "../../probe";
import type { CheckOutcome, CheckReturn, HttpInit, HttpResult, Instance, ProbeHelpers } from "../../types";

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

export const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Base64 of a UTF-8 string, without Node's Buffer */
export function base64(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * One API call: its outcome when it fails, otherwise the outcome refined by `refine`
 * (metrics, usage, a warning…). Most provider presets are exactly this.
 */
export async function call(
  http: ProbeHelpers["http"],
  url: string,
  init?: HttpInit,
  refine?: (response: HttpResult) => CheckReturn
): Promise<CheckOutcome> {
  const response = await http(url, init);
  if (!response.ok || !refine) return response.outcome;
  return { ...response.outcome, ...normalizeReturn(refine(response)) };
}

/** A used/limit pair with the threshold from which it becomes a warning */
export function quota({
  label,
  used,
  limit,
  unit,
  resetsAt,
  warnAbovePct,
  warning,
}: {
  label: string;
  used: number;
  limit: number;
  unit?: string;
  resetsAt?: number;
  warnAbovePct: number;
  warning: string;
}): CheckOutcome {
  const pct = limit > 0 ? (used / limit) * 100 : 0;
  const over = pct >= warnAbovePct;
  return {
    status: over ? "degraded" : "up",
    error: over ? warning : undefined,
    usage: [{ label, used, limit, unit, resetsAt }],
  };
}

/**
 * The status of a service made of instances (models, endpoints…), with the same rule as
 * `fly.app`: all failing is down, some failing or degraded is degraded, all resting is sleeping.
 */
export function summarize(instances: Instance[], noun: string): Pick<CheckOutcome, "status" | "error" | "latencyMs"> {
  const down = instances.filter((instance) => instance.status === "down");
  const degraded = instances.filter((instance) => instance.status === "degraded");
  const awake = instances.filter((instance) => instance.status === "up" || instance.status === "degraded");
  const keysOf = (items: Instance[]) => items.map((instance) => instance.key).join(", ");
  const latencies = instances.map((instance) => instance.latencyMs).filter((l): l is number => l !== undefined);
  const latencyMs = latencies.length ? Math.max(...latencies) : undefined;

  if (instances.length > 0 && down.length === instances.length) {
    return { status: "down", latencyMs, error: `All ${instances.length} ${noun}(s) failing` };
  }
  if (down.length > 0) {
    return { status: "degraded", latencyMs, error: `${down.length}/${instances.length} ${noun}(s) failing: ${keysOf(down)}` };
  }
  if (degraded.length > 0) return { status: "degraded", latencyMs, error: `Degraded: ${keysOf(degraded)}` };
  return { status: awake.length || instances.length === 0 ? "up" : "sleeping", latencyMs };
}

/**
 * For APIs with no free read call: an empty request is refused for validation, which only
 * happens after the key was accepted. Nothing is searched, so nothing is billed.
 */
export function keyAccepted(res: HttpResult): CheckOutcome {
  if (res.status === 400 || res.status === 422) return { status: "up", latencyMs: res.latencyMs, httpStatus: res.status };
  if (res.status === 402) {
    return { status: "degraded", latencyMs: res.latencyMs, httpStatus: 402, error: "Out of credits, or payment required" };
  }
  return res.outcome;
}

export const emptyPost = (headers: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: "{}",
});
