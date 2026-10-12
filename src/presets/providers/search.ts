import { definePreset, type PresetOptions } from "../../config";
import type { CheckOutcome } from "../../types";
import { bearer, emptyPost, keyAccepted, quota } from "./shared";

type ApiKey = { secrets: { apiKey: string | undefined } };

/**
 * Exa. Sends an empty search, which Exa refuses for validation once the key is accepted:
 * nothing is searched or billed.
 * - up: the key is accepted
 * - degraded: rate limited, or out of credits (HTTP 402)
 * - down: the API rejects the key or errors
 */
export const exa = definePreset<PresetOptions & ApiKey>()({
  kind: "exa",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Exa", identity: "exa", description: "Validates the API key (no search is run)" }),
  check: async ({ secrets, http }) =>
    keyAccepted(await http("https://api.exa.ai/search", emptyPost({ "x-api-key": secrets.apiKey }))),
});

/**
 * Nimble. Sends an empty search, which Nimble refuses for validation once the key is
 * accepted: nothing is searched or billed.
 * - up: the key is accepted
 * - degraded: rate limited, or out of credits (HTTP 402)
 * - down: the API rejects the key or errors
 */
export const nimble = definePreset<PresetOptions & ApiKey>()({
  kind: "nimble",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Nimble", identity: "nimble", description: "Validates the API key (no search is run)" }),
  check: async ({ secrets, http }) =>
    keyAccepted(await http("https://sdk.nimbleway.com/v1/search", emptyPost(bearer(secrets.apiKey)))),
});

export type TavilyOptions = PresetOptions &
  ApiKey & {
    track?: {
      /** Warn when this share of the credits is used (default 90) */
      quota?: { warnAbovePct?: number };
    };
  };

type TavilyUsage = {
  key?: { usage?: number; limit?: number | null };
  account?: { current_plan?: string; plan_usage?: number; plan_limit?: number | null };
};

/**
 * Tavily. Reads `/usage`, which validates the API key.
 * - up: the key works
 * - degraded: `track.quota.warnAbovePct` of the credits are used
 * - down: the API rejects the key or errors
 *
 * Reports a `usage` bar (the key's own limit when it has one, otherwise the plan's) and
 * `metrics.plan`.
 */
export const tavily = definePreset<TavilyOptions>()({
  kind: "tavily",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Tavily", identity: "tavily", description: "Reads the credits used this period" }),
  check: async ({ options, secrets, http }): Promise<CheckOutcome> => {
    const res = await http("https://api.tavily.com/usage", { headers: bearer(secrets.apiKey) });
    if (!res.ok) return res.outcome;
    const { key, account } = (res.json as TavilyUsage) ?? {};
    const metrics = account?.current_plan ? { plan: account.current_plan } : undefined;
    const [used, limit] = key?.limit ? [key.usage, key.limit] : [account?.plan_usage, account?.plan_limit];
    if (typeof used !== "number" || !limit) return { ...res.outcome, metrics };
    return {
      ...res.outcome,
      ...quota({
        label: "Credits",
        used,
        limit,
        unit: "credits",
        warnAbovePct: options.track?.quota?.warnAbovePct ?? 90,
        warning: "Credits almost exhausted",
      }),
      metrics,
    };
  },
});

export type EmeliaOptions = PresetOptions &
  ApiKey & {
    /** API base URL (default "https://api.emelia.io") */
    baseUrl?: string;
  };

/**
 * Emelia. Sends an empty email-finder request, which Emelia refuses for validation once the
 * key is accepted: nothing is looked up or billed.
 * - up: the key is accepted
 * - degraded: rate limited, or out of credits (HTTP 402)
 * - down: the API rejects the key or errors
 */
export const emelia = definePreset<EmeliaOptions>()({
  kind: "emelia",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Emelia", identity: "emelia", description: "Validates the API key (no lookup is run)" }),
  check: async ({ options, secrets, http }) =>
    keyAccepted(
      await http(
        `${(options.baseUrl ?? "https://api.emelia.io").replace(/\/+$/, "")}/tools/find/email`,
        // Emelia takes the bare key, without a scheme
        emptyPost({ Authorization: secrets.apiKey })
      )
    ),
});
