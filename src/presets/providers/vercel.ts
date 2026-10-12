import { definePreset, type PresetOptions } from "../../config";
import type { CheckOutcome } from "../../types";
import { bearer, call, round } from "./shared";

export type VercelAiGatewayOptions = PresetOptions & {
  secrets: { apiKey: string | undefined };
  track?: {
    /** Warn when the credit balance drops below this amount in USD (default 5). `false` skips the balance. */
    credits?: { warnBelow?: number } | false;
  };
};

/**
 * Vercel AI Gateway. Reads the credit balance, which validates the key.
 * - up: the key works
 * - degraded: balance below `track.credits.warnBelow`
 * - down: the gateway rejects the key or errors
 *
 * Reports `metrics.balance` and `metrics.used`. With `track.credits: false` it lists models
 * instead, which only proves the gateway is reachable: that route needs no key.
 */
const aiGateway = definePreset<VercelAiGatewayOptions>()({
  kind: "vercel.aiGateway",
  requiredSecrets: ["apiKey"],
  derive: (options) => ({
    name: "Vercel AI Gateway",
    identity: "vercel.aiGateway",
    description: options.track?.credits === false ? "Lists models" : "Reads the credit balance",
  }),
  check: ({ options, secrets, http }) => {
    const headers = bearer(secrets.apiKey);
    if (options.track?.credits === false) return call(http, "https://ai-gateway.vercel.sh/v1/models", { headers });
    const warnBelow = options.track?.credits?.warnBelow ?? 5;
    return call(http, "https://ai-gateway.vercel.sh/v1/credits", { headers }, (res): CheckOutcome | undefined => {
      const body = (res.json as { balance?: string | number; total_used?: string | number }) ?? {};
      // The gateway gives amounts as strings
      const balance = Number(body.balance);
      if (body.balance === undefined || !Number.isFinite(balance)) return undefined;
      const used = Number(body.total_used);
      const low = balance < warnBelow;
      return {
        status: low ? "degraded" : "up",
        error: low ? "Low credit balance" : undefined,
        metrics: {
          balance: `${round(balance, 2)} USD`,
          ...(body.total_used !== undefined && Number.isFinite(used) ? { used: `${round(used, 2)} USD` } : {}),
        },
      };
    });
  },
});

export type VercelBlobOptions = PresetOptions & {
  secrets: { token: string | undefined };
};

/** Vercel Blob. Lists one blob of the store, which validates the read-write token. */
const blob = definePreset<VercelBlobOptions>()({
  kind: "vercel.blob",
  requiredSecrets: ["token"],
  derive: () => ({ name: "Vercel Blob", identity: "vercel.blob", description: "Lists one blob of the store" }),
  check: ({ secrets, http }) =>
    call(http, "https://vercel.com/api/blob?limit=1", {
      headers: { ...bearer(secrets.token), "x-api-version": "12" },
    }),
});

/** Presets for Vercel products */
export const vercel = { aiGateway, blob };
