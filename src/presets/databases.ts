import { definePreset, type PresetOptions } from "../config";

// These presets take a client you created, so the library never imports a database driver:
// nothing extra to install, and the presets entry stays usable on edge runtimes.

type MongoDatabase = { command(command: Record<string, unknown>): Promise<unknown> };
type MongoLike = MongoDatabase | { db(name?: string): MongoDatabase };

export type MongoPingOptions = PresetOptions & {
  /**
   * Your `MongoClient` (or a `Db`). The driver connects on first use, so there is nothing to
   * await. When undefined the service is "not configured".
   */
  client: MongoLike | undefined;
  /** Optional: the connection string, only so it is redacted from public errors */
  secrets?: { url?: string };
};

/**
 * MongoDB, through your own client. Sends the `ping` command.
 * - up: the server replies
 * - down: it can't be reached, or rejects the credentials
 *
 * ```ts
 * mongodb.ping({ client: new MongoClient(url, { serverSelectionTimeoutMS: 8000 }) })
 * ```
 */
const mongoPing = definePreset<MongoPingOptions>()({
  kind: "mongodb.ping",
  requiredFields: ["client"],
  defaults: { slowMs: 500 },
  derive: () => ({ name: "MongoDB", description: "`ping` command on the database" }),
  check: ({ options, measure }) =>
    measure(async () => {
      const client = options.client as MongoLike;
      const database = "command" in client ? client : client.db();
      await database.command({ ping: 1 });
    }),
});

/** Presets for MongoDB */
export const mongodb = { ping: mongoPing };

type RedisLike =
  | { ping: () => Promise<unknown> }
  | { call: (command: string, ...args: string[]) => Promise<unknown> }
  | { sendCommand: (args: string[]) => Promise<unknown> };

export type RedisPingOptions = PresetOptions & {
  /** A connected ioredis or node-redis client. When undefined the service is "not configured". */
  client: RedisLike | undefined;
};

/**
 * Any Redis server, through your own client. Sends `PING`; up on PONG.
 * (For Upstash or Vercel KV over REST, use `upstashRedis`, which needs no client.)
 */
const redisPing = definePreset<RedisPingOptions>()({
  kind: "redis.ping",
  requiredFields: ["client"],
  defaults: { slowMs: 300 },
  derive: () => ({ name: "Redis", description: "PING" }),
  check: ({ options, measure }) =>
    measure(async () => {
      const client = options.client as RedisLike;
      const reply =
        "ping" in client
          ? await client.ping()
          : "call" in client
            ? await client.call("PING")
            : await client.sendCommand(["PING"]);
      return String(reply).toUpperCase() === "PONG" ? true : { status: "down", error: `Unexpected reply: ${String(reply)}` };
    }),
});

/** Presets for Redis servers reached with a client library */
export const redis = { ping: redisPing };

export type PostgresPingOptions = PresetOptions & {
  /**
   * Runs one statement with the driver you already use (pg, postgres.js, Neon…). When
   * undefined the service is "not configured".
   */
  query: ((sql: string) => Promise<unknown>) | undefined;
  /** Optional: the connection string, only so it is redacted from public errors */
  secrets?: { url?: string };
};

/**
 * PostgreSQL, through your own driver. Runs `select 1`.
 * - up: the server answers
 * - down: it can't be reached, or rejects the credentials
 *
 * ```ts
 * postgres.ping({ query: (sql) => pool.query(sql) })
 * ```
 */
const postgresPing = definePreset<PostgresPingOptions>()({
  kind: "postgres.ping",
  requiredFields: ["query"],
  defaults: { slowMs: 1000 },
  derive: () => ({ name: "PostgreSQL", description: "Runs `select 1`" }),
  check: ({ options, measure }) =>
    measure(async () => {
      await (options.query as (sql: string) => Promise<unknown>)("select 1");
    }),
});

/** Presets for PostgreSQL servers reached with a client library */
export const postgres = { ping: postgresPing };
