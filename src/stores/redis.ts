import type { StatusStore } from "../store";
import { createRedisStore, type RedisExec } from "./redis-core";

/** ioredis: `client.call("GET", "key")` */
type CallClient = { call: (command: string, ...args: Array<string | number>) => Promise<unknown> };
/** node-redis: `client.sendCommand(["GET", "key"])` */
type SendCommandClient = { sendCommand: (args: string[]) => Promise<unknown> };

export type RedisStoreOptions = {
  /** An ioredis or node-redis client you created and connected */
  client?: CallClient | SendCommandClient;
  /** Or any function that sends one raw command, for other clients */
  command?: (args: string[]) => Promise<unknown>;
  /** Prefix of every key (default "sermon"): lets several status pages share one database */
  prefix?: string;
};

/**
 * Store on any Redis-compatible server (Redis, Valkey, KeyDB, Dragonfly…), using the client
 * you already have:
 *
 * ```ts
 * redisStore({ client: new Redis(process.env.REDIS_URL) })          // ioredis
 * redisStore({ client: await createClient({ url }).connect() })     // node-redis
 * ```
 */
export function redisStore({ client, command, prefix }: RedisStoreOptions): StatusStore {
  let send = command;
  if (!send && client) {
    if ("call" in client && typeof client.call === "function") {
      send = ([name, ...args]) => client.call(name as string, ...(args as string[]));
    } else if ("sendCommand" in client && typeof client.sendCommand === "function") {
      send = (args) => client.sendCommand(args);
    }
  }
  if (!send) throw new Error("sermon-js: redisStore needs a `client` (ioredis or node-redis) or a `command` function");

  const run = send;
  const exec: RedisExec = (commands) => Promise.all(commands.map((args) => run(args.map(String))));
  return createRedisStore({ exec, prefix });
}
