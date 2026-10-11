import type { StatusStore } from "../store";
import { createRedisStore, type RedisExec } from "./redis-core";

export type UpstashStoreOptions = {
  /** REST URL of the database (`UPSTASH_REDIS_REST_URL` / Vercel KV's `KV_REST_API_URL`) */
  url: string;
  /** REST token (`UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN`) */
  token: string;
  /** Prefix of every key (default "sermon"): lets several status pages share one database */
  prefix?: string;
  fetch?: typeof fetch;
};

/**
 * Store on Upstash Redis or Vercel KV, over their REST API. It only needs `fetch`, so it works
 * on serverless and edge runtimes, with no client library to install.
 */
export function upstashStore({ url, token, prefix, fetch: fetchImpl = fetch }: UpstashStoreOptions): StatusStore {
  if (!url || !token) throw new Error("sermon-js: upstashStore needs a url and a token");
  const endpoint = `${url.replace(/\/+$/, "")}/pipeline`;

  const exec: RedisExec = async (commands) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(commands.map((command) => command.map(String))),
    });
    if (!response.ok) throw new Error(`sermon-js: Upstash request failed (HTTP ${response.status})`);
    const replies = (await response.json()) as Array<{ result?: unknown; error?: string }>;
    return replies.map((reply) => {
      if (reply.error) throw new Error(`sermon-js: Upstash command failed: ${reply.error}`);
      return reply.result;
    });
  };

  return createRedisStore({ exec, prefix });
}
