/// <reference types="node" />
// Node-only presets: this entry is the one place allowed to depend on Node and its drivers.
import { MongoClient } from "mongodb";
import { definePreset, type PresetOptions } from "../config";
import type { CheckOutcome } from "../types";

export type MongoPingOptions = PresetOptions & {
  secrets: {
    /** A direct MongoDB connection string (not a proxy URL such as Prisma Accelerate) */
    url: string | undefined;
  };
};

// One client per connection string, reused across runs (and across warm serverless invocations)
const clients = new Map<string, MongoClient>();

/**
 * MongoDB, with the official driver (Node only). Sends the `ping` command.
 * - up: the server replies
 * - down: it can't be reached, or rejects the credentials
 *
 * The latency is the ping round-trip; `metrics.connectMs` is the time to get a connection
 * (near zero once the connection is reused).
 */
const ping = definePreset<MongoPingOptions>()({
  kind: "mongodb.ping",
  requiredSecrets: ["url"],
  defaults: { slowMs: 500 },
  derive: () => ({ name: "MongoDB", description: "`ping` command on the database" }),
  check: async ({ secrets, timeoutMs, measure }): Promise<CheckOutcome> => {
    let client = clients.get(secrets.url);
    if (!client) {
      client = new MongoClient(secrets.url, {
        serverSelectionTimeoutMS: timeoutMs,
        connectTimeoutMS: timeoutMs,
        maxPoolSize: 1,
      });
      clients.set(secrets.url, client);
    }
    const connectStart = performance.now();
    try {
      await client.connect();
    } catch (error) {
      // Don't keep a client that never connected
      clients.delete(secrets.url);
      await client.close().catch(() => undefined);
      throw error;
    }
    const connectMs = Math.round(performance.now() - connectStart);
    const active = client;
    const outcome = await measure(async () => {
      await active.db().command({ ping: 1 });
    });
    return { ...outcome, metrics: { connectMs } };
  },
});

/** Presets for MongoDB (Node only: needs the `mongodb` package) */
export const mongodb = { ping };

type RedisLike =
  | { call: (command: string, ...args: string[]) => Promise<unknown> }
  | { sendCommand: (args: string[]) => Promise<unknown> }
  | { ping: () => Promise<unknown> };

export type RedisPingOptions = PresetOptions & {
  /** How to call it */
  name?: string;
  /** A connected ioredis or node-redis client */
  client: RedisLike | undefined;
};

/** Any Redis server, through a client you already have. Sends `PING`; up on PONG. */
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
