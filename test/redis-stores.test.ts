import Redis from "ioredis";
import { describe, expect, it } from "vitest";
import { createRedisStore } from "../src/stores/redis-core";
import { redisStore } from "../src/stores/redis";
import { upstashStore } from "../src/stores/upstash";
import { runStoreConformance } from "../src/testing";
import { fakeRedis } from "./helpers/fake-redis";

const harness = { describe, it, expect };

/** A `fetch` that behaves like Upstash's REST pipeline endpoint, backed by the fake Redis */
function fakeUpstash() {
  const redis = fakeRedis();
  const calls: Array<{ url: string; authorization: string | null }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
    const commands = JSON.parse(String(init?.body)) as string[][];
    const replies = commands.map((command) => {
      try {
        return { result: redis.command(command) };
      } catch (error) {
        return { error: (error as Error).message };
      }
    });
    return Response.json(replies);
  }) as typeof globalThis.fetch;
  return { fetch, calls, redis };
}

runStoreConformance("createRedisStore (fake Redis)", () => {
  const redis = fakeRedis();
  return createRedisStore({ exec: async (commands) => commands.map((c) => redis.command(c.map(String))) });
}, harness);

runStoreConformance("upstashStore (fake REST)", () => {
  return upstashStore({ url: "https://db.upstash.test", token: "t0ken", fetch: fakeUpstash().fetch });
}, harness);

runStoreConformance("redisStore (ioredis-style client)", () => {
  const redis = fakeRedis();
  return redisStore({ client: { call: async (name, ...args) => redis.command([name, ...args.map(String)]) } });
}, harness);

runStoreConformance("redisStore (node-redis-style client)", () => {
  const redis = fakeRedis();
  return redisStore({ client: { sendCommand: async (args) => redis.command(args) } });
}, harness);

describe("upstashStore", () => {
  it("calls the pipeline endpoint with the token, and prefixes keys", async () => {
    const upstash = fakeUpstash();
    const store = upstashStore({ url: "https://db.upstash.test/", token: "t0ken", prefix: "line21", fetch: upstash.fetch });
    await store.saveRun({
      summary: { at: 1, trigger: "manual", full: true, score: 100, label: "operational", failing: {} },
      results: [{ key: "api", status: "up", checkedAt: 1, probed: true }],
      samples: [{ key: "api", at: 1, status: "up" }],
    });
    expect(upstash.calls[0]).toEqual({ url: "https://db.upstash.test/pipeline", authorization: "Bearer t0ken" });
    expect(upstash.redis.keys().sort()).toEqual(["line21:latest", "line21:runs", "line21:samples:api"]);
  });

  it("fails loudly on HTTP and command errors", async () => {
    const down = upstashStore({
      url: "https://db.upstash.test",
      token: "t",
      fetch: (async () => new Response("nope", { status: 401 })) as typeof fetch,
    });
    await expect(down.latest()).rejects.toThrow(/HTTP 401/);

    const broken = upstashStore({
      url: "https://db.upstash.test",
      token: "t",
      fetch: (async () => Response.json([{ error: "WRONGTYPE" }])) as typeof fetch,
    });
    await expect(broken.latest()).rejects.toThrow(/WRONGTYPE/);
    expect(() => upstashStore({ url: "", token: "" })).toThrow(/url and a token/);
  });
});

describe("redisStore", () => {
  it("needs a client or a command function", () => {
    expect(() => redisStore({})).toThrow(/client/);
    expect(() => redisStore({ client: {} as never })).toThrow(/client/);
  });

  it("accepts a raw command function", async () => {
    const redis = fakeRedis();
    const store = redisStore({ command: async (args) => redis.command(args) });
    expect(await store.lock!("x", 1000)).toEqual({ ok: true });
  });
});

// Real servers, when available: set SERMON_TEST_UPSTASH_URL (+ _TOKEN) and/or SERMON_TEST_REDIS_URL
const unique = () => `sermon-test:${Date.now()}:${Math.random().toString(36).slice(2)}`;

if (process.env.SERMON_TEST_UPSTASH_URL) {
  runStoreConformance("upstashStore (real REST server)", () =>
    upstashStore({
      url: process.env.SERMON_TEST_UPSTASH_URL!,
      token: process.env.SERMON_TEST_UPSTASH_TOKEN ?? "",
      prefix: unique(),
    }), harness);
}

if (process.env.SERMON_TEST_REDIS_URL) {
  const client = new Redis(process.env.SERMON_TEST_REDIS_URL, { lazyConnect: false });
  runStoreConformance("redisStore (real Redis via ioredis)", () => redisStore({ client, prefix: unique() }), harness);
  describe("cleanup", () => {
    it("closes the connection", async () => {
      const keys = await client.keys("sermon-test:*");
      if (keys.length) await client.del(...keys);
      await client.quit();
    });
  });
}
