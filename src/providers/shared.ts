import { normalizeReturn } from "../probe";
import type { CheckOutcome, CheckReturn, HttpInit, HttpResult, ProbeHelpers } from "../types";

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
