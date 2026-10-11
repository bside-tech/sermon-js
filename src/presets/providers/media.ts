import { definePreset, type PresetOptions } from "../../config";
import type { CheckOutcome } from "../../types";
import { base64, bearer, call, quota } from "./shared";

export type MuxOptions = PresetOptions & {
  secrets: { tokenId: string | undefined; tokenSecret: string | undefined };
};

/** Mux Video. Lists live streams (limit 1). up when the token works; down when rejected. */
export const mux = definePreset<MuxOptions>()({
  kind: "mux",
  requiredSecrets: ["tokenId", "tokenSecret"],
  derive: () => ({ name: "Mux", identity: "mux", description: "Lists live streams (limit 1)" }),
  check: ({ secrets, http }) =>
    call(http, "https://api.mux.com/video/v1/live-streams?limit=1", {
      headers: { Authorization: `Basic ${base64(`${secrets.tokenId}:${secrets.tokenSecret}`)}` },
    }),
});

export type CloudflareStreamOptions = PresetOptions & {
  /** The Cloudflare account ID */
  accountId: string | undefined;
  secrets: { token: string | undefined };
  track?: {
    /** Warn when this share of the storage plan is used (default 90). `false` skips storage. */
    storage?: { warnAbovePct?: number } | false;
  };
};

/**
 * Cloudflare Stream. Lists videos (limit 1) and reads storage usage, in parallel.
 * - up: both calls work
 * - degraded: storage at or above `track.storage.warnAbovePct`
 * - down: either call fails
 *
 * Reports a `usage` bar (storage minutes) and `metrics.videos`.
 */
export const cloudflareStream = definePreset<CloudflareStreamOptions>()({
  kind: "cloudflare.stream",
  requiredFields: ["accountId"],
  requiredSecrets: ["token"],
  derive: () => ({
    name: "Cloudflare Stream",
    identity: "cloudflare.stream",
    description: "Lists videos (limit 1) and reads storage usage against the plan limit",
  }),
  check: async ({ options, secrets, http, combine }): Promise<CheckOutcome> => {
    const base = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/stream`;
    const init = { headers: bearer(secrets.token) };
    const rejected = (json: unknown): CheckOutcome | undefined =>
      (json as { success?: boolean })?.success === false
        ? { status: "down", error: "Cloudflare API reported success=false" }
        : undefined;

    const videos = call(http, `${base}?limit=1`, init, (res) => rejected(res.json));
    if (options.track?.storage === false) return videos;

    const warnAbovePct = options.track?.storage?.warnAbovePct ?? 90;
    const storage = call(http, `${base}/storage-usage`, init, (res) => {
      const failed = rejected(res.json);
      if (failed) return failed;
      const usage = (
        res.json as {
          result?: { videoCount?: number; totalStorageMinutes?: number; totalStorageMinutesLimit?: number };
        }
      )?.result;
      if (!usage?.totalStorageMinutesLimit) return undefined;
      return {
        ...quota({
          label: "Video storage",
          used: Math.round(usage.totalStorageMinutes ?? 0),
          limit: usage.totalStorageMinutesLimit,
          unit: "min",
          warnAbovePct,
          warning: "Stream storage almost full",
        }),
        metrics: { videos: usage.videoCount ?? 0 },
      };
    });
    return combine(await Promise.all([videos, storage]));
  },
});
