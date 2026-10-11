import { definePreset, type PresetOptions } from "../config";
import type { CheckOutcome } from "../types";
import { bearer, call, quota } from "./shared";

export type MailerSendOptions = PresetOptions & {
  secrets: { apiKey: string | undefined };
  track?: {
    /** Warn when less than this share of the API quota is left (default 10) */
    quota?: { warnBelowPct?: number };
  };
};

/**
 * MailerSend. Reads `/v1/api-quota`.
 * - up: quota available
 * - degraded: less than `track.quota.warnBelowPct` of the requests left
 * - down: the API rejects the key or errors
 *
 * Reports a `usage` bar: API requests used, with the reset time.
 */
export const mailersend = definePreset<MailerSendOptions>()({
  kind: "mailersend",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "MailerSend", identity: "mailersend", description: "Reads the API quota" }),
  check: ({ options, secrets, http }) =>
    call(http, "https://api.mailersend.com/v1/api-quota", { headers: bearer(secrets.apiKey) }, (res) => {
      const { quota: limit, remaining, reset } =
        (res.json as { quota?: number; remaining?: number; reset?: string }) ?? {};
      if (!limit || typeof remaining !== "number") return undefined;
      const resetsAt = reset ? Date.parse(reset) : NaN;
      return quota({
        label: "API requests",
        used: limit - remaining,
        limit,
        unit: "requests",
        resetsAt: Number.isNaN(resetsAt) ? undefined : resetsAt,
        warnAbovePct: 100 - (options.track?.quota?.warnBelowPct ?? 10),
        warning: "API quota almost exhausted",
      });
    }),
});

export type GitHubOptions = PresetOptions & {
  secrets: { token: string | undefined };
  track?: {
    /** Also check that the token can read this repository's releases, e.g. "owner/name" */
    repo?: string;
    /** Warn when less than this share of the hourly rate limit is left (default 10) */
    rateLimit?: { warnBelowPct?: number };
  };
};

/**
 * GitHub. Reads `/rate_limit` (free: it doesn't count against the limit), and optionally
 * checks access to a repository's releases.
 * - up: the token works (and can read the repository)
 * - degraded: less than `track.rateLimit.warnBelowPct` of the hourly requests left
 * - down: bad credentials, or the repository can't be read
 *
 * Reports a `usage` bar: requests this hour, with the reset time.
 */
export const github = definePreset<GitHubOptions>()({
  kind: "github",
  requiredSecrets: ["token"],
  derive: (options) => ({
    name: "GitHub",
    identity: options.track?.repo ? `github:${options.track.repo}` : "github",
    description: options.track?.repo
      ? `Reads the API rate limit and the releases of ${options.track.repo}`
      : "Reads the API rate limit",
  }),
  check: async ({ options, secrets, http, combine }): Promise<CheckOutcome> => {
    const headers = { ...bearer(secrets.token), "user-agent": "sermon-js", accept: "application/vnd.github+json" };
    const limit = call(http, "https://api.github.com/rate_limit", { headers }, (res) => {
      const core = (res.json as { resources?: { core?: { limit: number; remaining: number; reset: number } } })
        ?.resources?.core;
      if (!core) return undefined;
      return quota({
        label: "API requests this hour",
        used: core.limit - core.remaining,
        limit: core.limit,
        unit: "requests",
        // GitHub gives the reset as epoch seconds
        resetsAt: core.reset * 1000,
        warnAbovePct: 100 - (options.track?.rateLimit?.warnBelowPct ?? 10),
        warning: "Rate limit almost exhausted",
      });
    });
    if (!options.track?.repo) return limit;
    const repo = call(http, `https://api.github.com/repos/${options.track.repo}/releases?per_page=1`, { headers });
    return combine(await Promise.all([limit, repo]));
  },
});

export type RevolutOptions = PresetOptions & {
  secrets: { apiKey: string | undefined };
  /** Which Merchant API to call (default "production") */
  environment?: "production" | "sandbox";
};

/** Revolut Merchant. Lists orders (limit 1). up when the secret key works; down when rejected. */
export const revolut = definePreset<RevolutOptions>()({
  kind: "revolut",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Revolut Merchant", identity: "revolut", description: "Lists orders (limit 1)" }),
  check: ({ options, secrets, http }) => {
    const host = options.environment === "sandbox" ? "sandbox-merchant.revolut.com" : "merchant.revolut.com";
    // Order listing only exists on the legacy 1.0 path
    return call(http, `https://${host}/api/1.0/orders?limit=1`, {
      headers: { ...bearer(secrets.apiKey), "Revolut-Api-Version": "2023-09-01" },
    });
  },
});

export type AttendeeOptions = PresetOptions & {
  secrets: { apiKey: string | undefined };
  /** API base URL (default "https://app.attendee.dev") */
  baseUrl?: string;
};

/** Attendee (meeting bots). Lists bots (page size 1). */
export const attendee = definePreset<AttendeeOptions>()({
  kind: "attendee",
  requiredSecrets: ["apiKey"],
  derive: () => ({ name: "Attendee", identity: "attendee", description: "Lists bots" }),
  check: ({ options, secrets, http }) =>
    call(http, `${(options.baseUrl || "https://app.attendee.dev").replace(/\/+$/, "")}/api/v1/bots?page_size=1`, {
      headers: { Authorization: `Token ${secrets.apiKey}` },
    }),
});

export type AxiomOptions = PresetOptions & {
  /** The dataset logs are sent to */
  dataset: string | undefined;
  /** Regional edge domain for ingestion, e.g. "eu-central-1.aws.edge.axiom.co" */
  edge?: string;
  secrets: { token: string | undefined };
};

/** Axiom. Ingests an empty batch into the dataset: it writes nothing and proves token and dataset. */
export const axiom = definePreset<AxiomOptions>()({
  kind: "axiom",
  requiredFields: ["dataset"],
  requiredSecrets: ["token"],
  derive: () => ({ name: "Axiom", identity: "axiom", description: "Ingests an empty batch into the logs dataset" }),
  check: ({ options, secrets, http }) =>
    call(
      http,
      options.edge
        ? `https://${options.edge}/v1/ingest/${options.dataset}`
        : `https://api.axiom.co/v1/datasets/${options.dataset}/ingest`,
      { method: "POST", headers: { ...bearer(secrets.token), "content-type": "application/json" }, body: "[]" }
    ),
});

export type UpstashRedisOptions = PresetOptions & {
  /** REST URL of the database */
  url: string | undefined;
  secrets: { token: string | undefined };
};

/**
 * Upstash Redis / Vercel KV, over REST. Sends `PING` as a regular command (which compatible
 * servers such as serverless-redis-http also accept). up on PONG.
 */
export const upstashRedis = definePreset<UpstashRedisOptions>()({
  kind: "upstash.redis",
  requiredFields: ["url"],
  requiredSecrets: ["token"],
  defaults: { slowMs: 500 },
  derive: () => ({ name: "Redis", description: "PING through the REST API" }),
  check: ({ options, secrets, http }) =>
    call(
      http,
      (options.url as string).replace(/\/+$/, ""),
      {
        method: "POST",
        headers: { ...bearer(secrets.token), "content-type": "application/json" },
        body: '["PING"]',
      },
      (res) =>
        (res.json as { result?: string })?.result === "PONG"
          ? undefined
          : { status: "down", error: "Unexpected reply to PING" }
    ),
});

export type StatuspageOptions = PresetOptions & {
  /** The status page, e.g. "https://status.flyio.net" */
  url: string;
};

/**
 * Any provider that publishes an Atlassian Statuspage (Fly.io, Vercel, Cloudflare, GitHub…).
 * Reads `/api/v2/status.json`.
 * - up: the provider reports no incident
 * - degraded: a minor incident
 * - down: a major or critical incident
 *
 * The provider's own description becomes the error text.
 */
export const statuspage = definePreset<StatuspageOptions>()({
  kind: "statuspage",
  requiredFields: ["url"],
  derive: (options) => {
    let host = options.url;
    try {
      host = new URL(options.url).host;
    } catch {
      // Keep the raw value: the check will report the bad URL
    }
    return {
      name: host,
      identity: `statuspage:${host}`,
      description: "Status reported by the provider's public status page",
    };
  },
  check: ({ options, http }) =>
    call(http, `${options.url.replace(/\/+$/, "")}/api/v2/status.json`, undefined, (res) => {
      const { indicator, description } =
        (res.json as { status?: { indicator?: string; description?: string } })?.status ?? {};
      if (!indicator) return { status: "degraded", error: "Not a Statuspage answer" };
      const status = indicator === "none" ? "up" : indicator === "minor" ? "degraded" : "down";
      return { status, error: status === "up" ? undefined : description };
    }),
});
