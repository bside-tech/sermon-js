import { describe, expect, it } from "vitest";
import { aws, mongodb, postgres, pusher, redis, signPusherRequest } from "../src/presets";
import { mockFetch, runCheck, type MockRoute } from "../src/testing";

const awsSecrets = { accessKeyId: "AKIAEXAMPLE123", secretAccessKey: "secret-access-key-123" };

describe("aws.credentials", () => {
  it("validates credentials with a signed STS call", async () => {
    const fetch = mockFetch([{ url: "sts.amazonaws.com", body: "<GetCallerIdentityResponse/>" }]);
    const result = await runCheck(aws.credentials({ name: "AWS Transcribe", secrets: awsSecrets }), { fetch });
    expect(result).toMatchObject({ key: "aws-transcribe", status: "up", httpStatus: 200 });
    expect(fetch.calls[0]).toMatchObject({ method: "POST", url: "https://sts.amazonaws.com/", body: "Action=GetCallerIdentity&Version=2011-06-15" });
    expect(fetch.calls[0]?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE123\/\d{8}\/us-east-1\/sts\/aws4_request/);
  });

  it("is down when rejected and not configured without keys", async () => {
    const rejected = await runCheck(aws.credentials({ name: "AWS", secrets: awsSecrets }), {
      fetch: mockFetch([{ url: "sts", status: 403, body: "<Error><Code>InvalidClientTokenId</Code></Error>" }]),
    });
    expect(rejected).toMatchObject({ status: "down", httpStatus: 403 });
    expect(aws.credentials({ name: "AWS", secrets: { accessKeyId: "a", secretAccessKey: undefined } }).missing).toEqual(['secret "secretAccessKey"']);
  });
});

describe("aws.s3Bucket", () => {
  it("sends a signed HeadBucket to AWS or an S3-compatible endpoint", async () => {
    const fetch = mockFetch([{ url: "tigris.dev", status: 200 }]);
    const service = aws.s3Bucket({ bucket: "captions", endpoint: "https://fly.storage.tigris.dev/", region: "auto", secrets: awsSecrets });
    expect(service).toMatchObject({ name: "captions", slowMs: 1500 });
    const result = await runCheck(service, { fetch });
    expect(result).toMatchObject({ status: "up", httpStatus: 200 });
    expect(fetch.calls[0]).toMatchObject({ method: "HEAD", url: "https://fly.storage.tigris.dev/captions" });
    expect(fetch.calls[0]?.headers.authorization).toContain("/auto/s3/aws4_request");

    const onAws = mockFetch([{ url: "amazonaws.com" }]);
    await runCheck(aws.s3Bucket({ bucket: "b", region: "eu-west-1", secrets: awsSecrets }), { fetch: onAws });
    expect(onAws.calls[0]?.url).toBe("https://s3.eu-west-1.amazonaws.com/b");
  });

  it("is down when the bucket is missing or denied", async () => {
    const service = aws.s3Bucket({ bucket: "nope", secrets: awsSecrets });
    expect((await runCheck(service, { fetch: mockFetch([{ url: "amazonaws.com", status: 404 }]) })).status).toBe("down");
    expect((await runCheck(service, { fetch: mockFetch([{ url: "amazonaws.com", status: 403 }]) })).status).toBe("down");
    expect(aws.s3Bucket({ bucket: undefined, secrets: awsSecrets }).missing).toEqual(['field "bucket"']);
  });
});

describe("pusher", () => {
  const now = Date.UTC(2026, 9, 9, 12, 0);
  const service = (extra: Partial<Parameters<typeof pusher>[0]> = {}) =>
    pusher({ appId: "123", cluster: "eu", secrets: { key: "app-key", secret: "app-secret-1" }, ...extra });

  /** Answers the channel list and each channel's subscription count */
  function routes(counts: Record<string, number | undefined>): MockRoute[] {
    return [
      ...Object.entries(counts).map(
        ([name, count]): MockRoute => ({
          url: `/apps/123/channels/${encodeURIComponent(name)}?`,
          body: count === undefined ? { occupied: true } : { occupied: true, subscription_count: count },
        })
      ),
      { url: "/apps/123/channels?", body: { channels: Object.fromEntries(Object.keys(counts).map((name) => [name, {}])) } },
    ];
  }

  it("signs requests the way Pusher expects", async () => {
    const url = await signPusherRequest({
      appId: "123",
      key: "app-key",
      secret: "app-secret-1",
      path: "/channels/a",
      params: { info: "subscription_count" },
      timestamp: 1000,
    });
    expect(url).toMatch(
      /^\/apps\/123\/channels\/a\?auth_key=app-key&auth_timestamp=1000&auth_version=1\.0&info=subscription_count&auth_signature=[0-9a-f]{64}$/
    );
    // Same input, same signature; different secret, different signature
    expect(await signPusherRequest({ appId: "123", key: "app-key", secret: "app-secret-1", path: "/channels/a", params: { info: "subscription_count" }, timestamp: 1000 })).toBe(url);
    expect(await signPusherRequest({ appId: "123", key: "app-key", secret: "other", path: "/channels/a", params: { info: "subscription_count" }, timestamp: 1000 })).not.toBe(url);
  });

  it("estimates connections and reports them as metrics without a plan limit", async () => {
    const fetch = mockFetch(routes({ "project_1_en": 40, "#server-to-user-abc": 2 }));
    const result = await runCheck(service(), { fetch, now: () => now });
    expect(result).toMatchObject({
      status: "up",
      metrics: { channels: 2, signedInUsers: 2, connections: 42, peakToday: 42 },
    });
    expect(result.usage).toBeUndefined();
    expect(fetch.calls[0]?.url).toContain("https://api-eu.pusher.com/apps/123/channels?");
    // "#" in channel names is encoded, not treated as a fragment
    expect(fetch.calls.some((call) => call.url.includes("/channels/%23server-to-user-abc?"))).toBe(true);
  });

  it("reports usage bars against the plan limit and remembers today's peak", async () => {
    const cache = new Map<string, string>();
    const withMax = service({ track: { connections: { max: 100 } } });
    await runCheck(withMax, { fetch: mockFetch(routes({ a: 60 })), now: () => now, cache });
    const later = await runCheck(withMax, { fetch: mockFetch(routes({ a: 10 })), now: () => now + 3600_000, cache });
    expect(later).toMatchObject({
      status: "up",
      metrics: { channels: 1, signedInUsers: 0 },
      usage: [
        { label: "Connections now (estimate)", used: 10, limit: 100, unit: "connections" },
        { label: "Peak connections today (UTC)", used: 60, limit: 100, resetsAt: Date.UTC(2026, 9, 10) },
      ],
    });
    // A new UTC day starts a new peak
    const nextDay = await runCheck(withMax, { fetch: mockFetch(routes({ a: 5 })), now: () => now + 24 * 3600_000, cache });
    expect(nextDay.usage?.[1]).toMatchObject({ used: 5 });
  });

  it("is degraded near the plan limit, or when subscription counting is off", async () => {
    const near = await runCheck(service({ track: { connections: { max: 100 } } }), { fetch: mockFetch(routes({ a: 95 })), now: () => now });
    expect(near).toMatchObject({ status: "degraded", error: "Connections close to the plan limit" });
    const off = await runCheck(service(), { fetch: mockFetch(routes({ a: undefined })), now: () => now });
    expect(off.status).toBe("degraded");
    expect(off.error).toContain("Subscription counting is disabled");
  });

  it("is down when the credentials are rejected", async () => {
    const result = await runCheck(service(), { fetch: mockFetch([{ url: "/channels", status: 401, body: "Invalid signature" }]), now: () => now });
    expect(result).toMatchObject({ status: "down", httpStatus: 401 });
  });

  it("supports Pusher-compatible servers", async () => {
    const fetch = mockFetch(routes({}));
    await runCheck(service({ host: "localhost", port: 6001, tls: false }), { fetch, now: () => now });
    expect(fetch.calls[0]?.url).toContain("http://localhost:6001/apps/123/channels?");
    expect(pusher({ appId: undefined, secrets: { key: "k", secret: undefined } }).missing).toEqual(['field "appId"', 'secret "secret"']);
  });
});

describe("redis.ping", () => {
  it("works with ioredis-, node-redis- and ping-style clients", async () => {
    expect((await runCheck(redis.ping({ client: { ping: async () => "PONG" } }))).status).toBe("up");
    expect((await runCheck(redis.ping({ client: { call: async () => "PONG" } }))).status).toBe("up");
    expect((await runCheck(redis.ping({ client: { sendCommand: async () => "PONG" } }))).status).toBe("up");
  });

  it("is down on a wrong reply or a failing client, and not configured without one", async () => {
    expect(await runCheck(redis.ping({ client: { ping: async () => "LOADING" } }))).toMatchObject({ status: "down", error: "Unexpected reply: LOADING" });
    const failing = await runCheck(
      redis.ping({
        client: {
          ping: async () => {
            throw new Error("ECONNREFUSED");
          },
        },
      })
    );
    expect(failing).toMatchObject({ status: "down", error: "ECONNREFUSED" });
    expect((await runCheck(redis.ping({ client: undefined }))).status).toBe("unconfigured");
  });
});

describe("postgres.ping", () => {
  it("runs select 1 through your driver", async () => {
    const statements: string[] = [];
    const service = postgres.ping({
      query: async (sql) => {
        statements.push(sql);
        return [{ "?column?": 1 }];
      },
    });
    expect(await runCheck(service)).toMatchObject({ key: "postgresql", status: "up", probed: true });
    expect(statements).toEqual(["select 1"]);
    expect(service).toMatchObject({ kind: "postgres.ping", name: "PostgreSQL", slowMs: 1000 });
  });

  it("is down when the query throws, without leaking the connection string, and not configured without a query", async () => {
    const url = "postgres://app:s3cret-pass@db.internal:5432/app";
    const failing = await runCheck(
      postgres.ping({
        secrets: { url },
        query: async () => {
          throw new Error(`connect ECONNREFUSED ${url}`);
        },
      })
    );
    expect(failing.status).toBe("down");
    expect(failing.error).toContain("ECONNREFUSED");
    expect(failing.error).not.toContain("s3cret-pass");
    expect((await runCheck(postgres.ping({ query: undefined }))).status).toBe("unconfigured");
  });
});

describe("mongodb.ping", () => {
  const fakeClient = (command: (cmd: Record<string, unknown>) => Promise<unknown>) => ({ db: () => ({ command }) });

  it("pings through a client or a database handle", async () => {
    const commands: unknown[] = [];
    const client = fakeClient(async (cmd) => {
      commands.push(cmd);
      return { ok: 1 };
    });
    const result = await runCheck(mongodb.ping({ client, critical: true }));
    expect(result).toMatchObject({ key: "mongodb", status: "up", probed: true });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(commands).toEqual([{ ping: 1 }]);
    // A Db works too
    expect((await runCheck(mongodb.ping({ client: { command: async () => ({ ok: 1 }) } }))).status).toBe("up");
    expect(mongodb.ping({ client })).toMatchObject({ kind: "mongodb.ping", name: "MongoDB", slowMs: 500 });
  });

  it("is not configured without a client", async () => {
    const service = mongodb.ping({ client: undefined });
    expect(service.missing).toEqual(['field "client"']);
    expect((await runCheck(service)).status).toBe("unconfigured");
  });

  it("is down when the server can't be reached, with the connection string redacted", async () => {
    const url = "mongodb://user:hunter2-password@db.internal:27017/app";
    const client = fakeClient(async () => {
      throw new Error(`Server selection timed out connecting to ${url}`);
    });
    const result = await runCheck(mongodb.ping({ client, secrets: { url } }));
    expect(result).toMatchObject({ status: "down", error: "Server selection timed out connecting to ***" });
  });

  it("gives up on a client that never answers", async () => {
    const client = fakeClient(() => new Promise(() => undefined));
    const result = await runCheck(mongodb.ping({ client, timeoutMs: 50 }));
    expect(result).toMatchObject({ status: "down", error: "Timed out" });
  });

  // A real server with the real driver, when available: set SERMON_TEST_MONGODB_URL
  it.runIf(process.env.SERMON_TEST_MONGODB_URL)("pings a real server with the official driver", async () => {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient(process.env.SERMON_TEST_MONGODB_URL!, { serverSelectionTimeoutMS: 3000 });
    try {
      const result = await runCheck(mongodb.ping({ client }));
      expect(result.status).toBe("up");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      await client.close();
    }
  });

  it.runIf(process.env.SERMON_TEST_MONGODB_URL)("reports an unreachable real server as down", async () => {
    const { MongoClient } = await import("mongodb");
    const client = new MongoClient("mongodb://127.0.0.1:1/db", { serverSelectionTimeoutMS: 300 });
    try {
      expect((await runCheck(mongodb.ping({ client }))).status).toBe("down");
    } finally {
      await client.close();
    }
  });
});
