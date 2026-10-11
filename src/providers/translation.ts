import { definePreset, type PresetOptions } from "../config";
import { googleServiceAccountToken, parseServiceAccount } from "../google-auth";
import type { CheckOutcome } from "../types";
import { bearer, call, quota } from "./shared";

export type DeepLOptions = PresetOptions & {
  secrets: { apiKey: string | undefined };
  track?: {
    /** Warn when this share of the character quota is used (default 90) */
    quota?: { warnAbovePct?: number };
  };
};

/**
 * DeepL. Reads `/v2/usage` (free and paid keys are detected from the key).
 * - up: quota available
 * - degraded: usage at or above `track.quota.warnAbovePct`
 * - down: the API rejects the key or errors
 *
 * Reports a `usage` bar: characters used of the limit.
 */
export const deepl = definePreset<DeepLOptions>()({
  kind: "deepl",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "DeepL", identity: "deepl", description: "Reads character usage for the billing period" }),
  check: ({ options, secrets, http }) => {
    const host = secrets.apiKey.endsWith(":fx") ? "api-free.deepl.com" : "api.deepl.com";
    return call(http, `https://${host}/v2/usage`, { headers: { Authorization: `DeepL-Auth-Key ${secrets.apiKey}` } }, (res) => {
      const { character_count: used, character_limit: limit } =
        (res.json as { character_count?: number; character_limit?: number }) ?? {};
      if (typeof used !== "number" || !limit) return undefined;
      return quota({
        label: "Characters",
        used,
        limit,
        unit: "characters",
        warnAbovePct: options.track?.quota?.warnAbovePct ?? 90,
        warning: "Character quota almost exhausted",
      });
    });
  },
});

export type AzureTranslatorOptions = PresetOptions & {
  secrets: { apiKey: string | undefined };
  /** Region of the Translator resource (default "westeurope") */
  region?: string;
};

/** Azure Translator. Translates a single character, which proves the key and region work. */
export const azureTranslator = definePreset<AzureTranslatorOptions>()({
  kind: "azure.translator",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Azure Translator", identity: "azure.translator", description: "Translates a single character" }),
  check: ({ options, secrets, http }) =>
    call(http, "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=fr", {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": secrets.apiKey,
        "Ocp-Apim-Subscription-Region": options.region ?? "westeurope",
        "content-type": "application/json",
      },
      body: JSON.stringify([{ Text: "a" }]),
    }),
});

export type GoogleTranslateOptions = PresetOptions & {
  secrets: {
    /** The service-account JSON key (the whole file content), not an API key */
    serviceAccount: string | undefined;
  };
  /** Translation location (default "global") */
  location?: string;
};

/**
 * Google Cloud Translation v3, with a service account. Gets a token, then lists supported
 * languages (free: Google bills by characters translated).
 * - up: languages returned
 * - down: the key isn't valid JSON, or auth or the API fails
 *
 * Reports `metrics.languages`.
 */
export const googleTranslate = definePreset<GoogleTranslateOptions>()({
  kind: "google.translate",
  requiredSecrets: ["serviceAccount"],
  derive: () => ({
    name: "Google Translate",
    identity: "google.translate",
    description: "Lists supported languages with Cloud Translation v3",
  }),
  check: async ({ options, secrets, http, now }): Promise<CheckOutcome> => {
    const account = parseServiceAccount(secrets.serviceAccount);
    if (!account?.project_id) {
      return { status: "down", probed: false, error: "The service account secret is not a service-account JSON key" };
    }
    const token = await googleServiceAccountToken({
      account,
      scope: "https://www.googleapis.com/auth/cloud-translation",
      http,
      now,
    });
    return call(
      http,
      `https://translation.googleapis.com/v3/projects/${account.project_id}/locations/${options.location ?? "global"}/supportedLanguages`,
      { headers: bearer(token) },
      (res) => {
        const languages = (res.json as { languages?: unknown[] })?.languages;
        return languages ? { status: "up", metrics: { languages: languages.length } } : undefined;
      }
    );
  },
});
