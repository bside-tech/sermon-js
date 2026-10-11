import { definePreset, type PresetOptions } from "../config";
import type { CheckOutcome, Metrics, Usage } from "../types";

export type PusherOptions = PresetOptions & {
  appId: string | undefined;
  /** Pusher cluster, e.g. "eu" (default "mt1"). Ignored when `host` is set. */
  cluster?: string;
  /** Custom host, for Pusher-compatible servers such as Soketi */
  host?: string;
  port?: string | number;
  /** Use HTTPS (default: true unless a non-443 port is given) */
  tls?: boolean;
  secrets: { key: string | undefined; secret: string | undefined };
  track?: {
    connections?: {
      /** Your plan's maximum concurrent connections: turns the counts into usage bars */
      max?: number;
      /** Warn when today's peak reaches this share of `max` (default 90) */
      warnAbovePct?: number;
    };
  };
};

/** Max channels queried one by one for their subscription count, per check */
const MAX_CHANNELS = 500;
const CONCURRENCY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

async function hmacSha256Hex(secret: string, message: string) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Path and signed query of a GET to the Pusher HTTP API */
export async function signPusherRequest({
  appId,
  key,
  secret,
  path,
  params = {},
  timestamp = Math.floor(Date.now() / 1000),
}: {
  appId: string;
  key: string;
  secret: string;
  path: string;
  params?: Record<string, string>;
  timestamp?: number;
}) {
  const fullPath = `/apps/${appId}${path}`;
  const search = new URLSearchParams({
    ...params,
    auth_key: key,
    auth_timestamp: String(timestamp),
    auth_version: "1.0",
  });
  search.sort();
  const query = decodeURIComponent(search.toString());
  const signature = await hmacSha256Hex(secret, ["GET", fullPath, query].join("\n"));
  return `${fullPath}?${query}&auth_signature=${signature}`;
}

function baseUrl(options: PusherOptions) {
  const host = options.host || `api-${options.cluster || "mt1"}.pusher.com`;
  const port = options.port === undefined || options.port === "" ? undefined : String(options.port);
  const tls = options.tls ?? (!port || port === "443");
  const defaultPort = tls ? "443" : "80";
  return `${tls ? "https" : "http"}://${host}${port && port !== defaultPort ? `:${port}` : ""}`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index] as T);
      }
    })
  );
  return results;
}

const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Pusher Channels (and compatible servers). Lists occupied channels, then reads each one's
 * `subscription_count` to estimate concurrent connections. Pusher has no usage API, so this is
 * an estimate: clients subscribed to several channels make it run slightly high.
 * Requires "subscription counting" enabled in the app settings.
 * - up: the API answers
 * - degraded: today's peak at or above `warnAbovePct` of `track.connections.max`, or subscription counting is off
 * - down: the API rejects the credentials or errors
 *
 * Reports `metrics.channels` and `metrics.signedInUsers`; with `max`, two `usage` bars
 * (connections now, peak today), otherwise the counts as metrics. The daily peak (UTC) is kept
 * in the store's cache.
 */
export const pusher = definePreset<PusherOptions>()({
  kind: "pusher",
  requiredFields: ["appId"],
  requiredSecrets: ["key", "secret"],
  defaults: { slowMs: 1000 },
  derive: (options) => ({
    name: "Pusher",
    identity: `pusher:${options.appId ?? ""}`,
    description: "Lists occupied channels and estimates connections from their subscription counts",
  }),
  check: async ({ options, secrets, http, cache, now }): Promise<CheckOutcome> => {
    const get = async (path: string, params?: Record<string, string>) =>
      http(
        `${baseUrl(options)}${await signPusherRequest({
          appId: options.appId as string,
          key: secrets.key,
          secret: secrets.secret,
          path,
          params,
          timestamp: Math.floor(now / 1000),
        })}`
      );

    const list = await get("/channels");
    if (!list.ok) return list.outcome;
    const names = Object.keys((list.json as { channels?: Record<string, unknown> })?.channels ?? {});
    const queried = names.slice(0, MAX_CHANNELS);

    let failed = 0;
    let countingDisabled = false;
    const counts = await mapLimit(queried, CONCURRENCY, async (name) => {
      // Names can contain "#" (`#server-to-user-…`), which would otherwise start a URL fragment
      const res = await get(`/channels/${encodeURIComponent(name)}`, { info: "subscription_count" });
      const count = (res.json as { subscription_count?: number })?.subscription_count;
      if (!res.ok) failed += 1;
      else if (typeof count !== "number") countingDisabled = true;
      return typeof count === "number" ? count : 0;
    });
    const connections = counts.reduce((sum, count) => sum + count, 0);
    // One per signed-in connection (pusher.signin()); those usually also subscribe to other
    // channels, so the total errs on the high side: safer for quota alerts
    const signedInUsers = queried.reduce(
      (sum, name, index) => (name.startsWith("#server-to-user-") ? sum + (counts[index] ?? 0) : sum),
      0
    );

    const peakKey = `peak:${utcDay(now)}`;
    const peak = Math.max(connections, Number(await cache.get(peakKey)) || 0);
    await cache.set(peakKey, String(peak), 8 * DAY_MS);

    const metrics: Metrics = { channels: names.length, signedInUsers };
    if (names.length > MAX_CHANNELS) metrics.channelsCounted = MAX_CHANNELS;

    const max = options.track?.connections?.max;
    const warnAbovePct = options.track?.connections?.warnAbovePct ?? 90;
    const usage: Usage[] = [];
    if (max) {
      usage.push(
        { label: "Connections now (estimate)", used: connections, limit: max, unit: "connections" },
        {
          label: "Peak connections today (UTC)",
          used: peak,
          limit: max,
          unit: "connections",
          resetsAt: Date.parse(`${utcDay(now)}T00:00:00Z`) + DAY_MS,
        }
      );
    } else {
      metrics.connections = connections;
      metrics.peakToday = peak;
    }

    const warnings: string[] = [];
    if (max && (peak / max) * 100 >= warnAbovePct) warnings.push("Connections close to the plan limit");
    if (countingDisabled) warnings.push("Subscription counting is disabled in the Pusher app settings");
    const notes = failed > 0 ? [`${failed} channel(s) could not be counted`] : [];

    return {
      status: warnings.length ? "degraded" : "up",
      latencyMs: list.latencyMs,
      httpStatus: list.status,
      error: [...warnings, ...notes].join("; ") || undefined,
      metrics,
      usage: usage.length ? usage : undefined,
    };
  },
});
