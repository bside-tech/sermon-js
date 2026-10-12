import { definePreset, type PresetOptions } from "../../config";
import type { CheckOutcome } from "../../types";
import { bearer, call, quota, round } from "./shared";

type ApiKey = { secrets: { apiKey: string | undefined } };

export type DeepgramOptions = PresetOptions &
  ApiKey & {
    track?: {
      /** Warn when the prepaid balance drops below this amount (default 20). `false` skips the balance. */
      balance?: { warnBelow?: number } | false;
    };
  };

/**
 * Deepgram. Lists projects, then reads the balance of the first one.
 * - up: the key works
 * - degraded: balance below `track.balance.warnBelow`, or the key sees no project
 * - down: the API rejects the key or errors
 *
 * Reports `metrics.balance`. Keys without billing scope still count as up.
 */
export const deepgram = definePreset<DeepgramOptions>()({
  kind: "deepgram",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Deepgram", identity: "deepgram", description: "Lists projects, then reads the account balance" }),
  check: async ({ options, secrets, http }): Promise<CheckOutcome> => {
    const headers = { Authorization: `Token ${secrets.apiKey}` };
    const projects = await http("https://api.deepgram.com/v1/projects", { headers });
    if (!projects.ok) return projects.outcome;
    const projectId = (projects.json as { projects?: Array<{ project_id: string }> })?.projects?.[0]?.project_id;
    if (!projectId) return { ...projects.outcome, status: "degraded", error: "No project visible to this key" };
    if (options.track?.balance === false) return projects.outcome;

    const warnBelow = options.track?.balance?.warnBelow ?? 20;
    const balances = await http(`https://api.deepgram.com/v1/projects/${projectId}/balances`, { headers });
    const balance = (balances.json as { balances?: Array<{ amount: number; units: string }> })?.balances?.[0];
    // The balance is informative: a key that can't read it is still a working key
    if (!balances.ok || !balance) return projects.outcome;
    const low = balance.amount < warnBelow;
    return {
      ...projects.outcome,
      latencyMs: Math.max(projects.latencyMs, balances.latencyMs),
      status: low ? "degraded" : "up",
      error: low ? "Low balance" : undefined,
      metrics: { balance: `${round(balance.amount, 2)} ${balance.units}` },
    };
  },
});

/** Gladia. Lists live sessions (limit 1). up when the key works; down when rejected. */
export const gladia = definePreset<PresetOptions & ApiKey>()({
  kind: "gladia",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Gladia", identity: "gladia", description: "Lists live sessions (limit 1)" }),
  check: ({ secrets, http }) =>
    call(http, "https://api.gladia.io/v2/live?limit=1", { headers: { "x-gladia-key": secrets.apiKey } }),
});

export type SpeechmaticsOptions = PresetOptions &
  ApiKey & {
    /** API base URL, e.g. the EU endpoint (default "https://asr.api.speechmatics.com") */
    baseUrl?: string;
  };

/** Speechmatics. Lists batch jobs (limit 1), which validates the API key. */
export const speechmatics = definePreset<SpeechmaticsOptions>()({
  kind: "speechmatics",
  requiredSecrets: ["apiKey"],
  derive: () => ({
    name: "Speechmatics",
    identity: "speechmatics",
    description: "Lists batch jobs (limit 1), validating the API key",
  }),
  check: ({ options, secrets, http }) =>
    call(http, `${(options.baseUrl ?? "https://asr.api.speechmatics.com").replace(/\/+$/, "")}/v2/jobs?limit=1`, {
      headers: bearer(secrets.apiKey),
    }),
});

export type OpenAIOptions = PresetOptions &
  ApiKey & {
    /** Sent as the `OpenAI-Organization` header */
    organization?: string;
    track?: {
      /** Also check that the key can use this model (`GET /v1/models/{model}`) */
      model?: string;
    };
  };

/**
 * OpenAI. Lists models, or reads one model when `track.model` is set (both free).
 * It proves the key works; it can't see billing problems, which only show on real requests.
 */
export const openai = definePreset<OpenAIOptions>()({
  kind: "openai",
  requiredSecrets: ["apiKey"],
  derive: (options) => ({
    name: "OpenAI",
    identity: "openai",
    description: options.track?.model ? `Checks access to ${options.track.model}` : "Lists models",
  }),
  check: ({ options, secrets, http }) =>
    call(
      http,
      options.track?.model
        ? `https://api.openai.com/v1/models/${encodeURIComponent(options.track.model)}`
        : "https://api.openai.com/v1/models",
      {
        headers: {
          ...bearer(secrets.apiKey),
          ...(options.organization ? { "OpenAI-Organization": options.organization } : {}),
        },
      }
    ),
});

/** Anthropic. Lists models (limit 1). up when the key works; down when rejected. */
export const anthropic = definePreset<PresetOptions & ApiKey>()({
  kind: "anthropic",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Anthropic", identity: "anthropic", description: "Lists models" }),
  check: ({ secrets, http }) =>
    call(http, "https://api.anthropic.com/v1/models?limit=1", {
      headers: { "x-api-key": secrets.apiKey, "anthropic-version": "2023-06-01" },
    }),
});

/** Google Gemini. Lists models (page size 1). */
export const gemini = definePreset<PresetOptions & ApiKey>()({
  kind: "gemini",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Google Gemini", identity: "gemini", description: "Lists models" }),
  check: ({ secrets, http }) =>
    call(http, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      headers: { "x-goog-api-key": secrets.apiKey },
    }),
});

/** CAMB.AI. Lists source languages. */
export const cambai = definePreset<PresetOptions & ApiKey>()({
  kind: "cambai",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "CAMB.AI", identity: "cambai", description: "Lists source languages" }),
  check: ({ secrets, http }) =>
    call(http, "https://client.camb.ai/apis/source-languages", { headers: { "x-api-key": secrets.apiKey } }),
});

export type ElevenLabsOptions = PresetOptions &
  ApiKey & {
    track?: {
      /** Warn when less than this share of the period's credits is left (default 10) */
      quota?: { warnBelowPct?: number };
    };
  };

/**
 * ElevenLabs. Reads the subscription, which validates the API key.
 * - up: the key works. A key without the user scope is refused with `missing_permissions`,
 *   which still proves it is valid.
 * - degraded: less than `track.quota.warnBelowPct` of the credits left
 * - down: the API rejects the key or errors
 *
 * Reports a `usage` bar (credits used this period, with the reset time) and `metrics.tier`.
 */
export const elevenlabs = definePreset<ElevenLabsOptions>()({
  kind: "elevenlabs",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "ElevenLabs", identity: "elevenlabs", description: "Reads the subscription" }),
  check: async ({ options, secrets, http }): Promise<CheckOutcome> => {
    const res = await http("https://api.elevenlabs.io/v1/user/subscription", {
      headers: { "xi-api-key": secrets.apiKey },
    });
    const body =
      (res.json as {
        detail?: { status?: string };
        tier?: string;
        character_count?: number;
        character_limit?: number;
        next_character_count_reset_unix?: number;
      }) ?? {};
    if (res.status === 401 && body.detail?.status === "missing_permissions") {
      return { status: "up", latencyMs: res.latencyMs, httpStatus: 401, metrics: { key: "restricted" } };
    }
    if (!res.ok) return res.outcome;
    const metrics = body.tier ? { tier: body.tier } : undefined;
    const { character_count: used, character_limit: limit } = body;
    if (typeof used !== "number" || !limit) return { ...res.outcome, metrics };
    return {
      ...res.outcome,
      ...quota({
        label: "Credits",
        used,
        limit,
        unit: "credits",
        // ElevenLabs gives the reset as epoch seconds
        resetsAt: body.next_character_count_reset_unix ? body.next_character_count_reset_unix * 1000 : undefined,
        warnAbovePct: 100 - (options.track?.quota?.warnBelowPct ?? 10),
        warning: "Credits almost exhausted",
      }),
      metrics,
    };
  },
});
