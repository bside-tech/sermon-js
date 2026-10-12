import { describe, expect, it } from "vitest";
import { anthropic, aws, emelia, exa, neon, nimble, stripe, tavily } from "../src/presets";
import { mockFetch, runCheck } from "../src/testing";

const KEY = "sk-test-secret-value-123456";

describe("anthropic", () => {
  it("lists models when no model is tracked", async () => {
    const fetch = mockFetch([{ url: "/v1/models?limit=1", body: { data: [] } }]);
    const result = await runCheck(anthropic({ secrets: { apiKey: KEY } }), { fetch });
    expect(result.status).toBe("up");
    expect(result.instances).toBeUndefined();
    expect(fetch.calls).toHaveLength(1);
  });

  it("reports each tracked model, and only those", async () => {
    const fetch = mockFetch([
      { url: "/v1/models/claude-a", body: { id: "claude-a" } },
      { url: "/v1/models/claude-gone", status: 404, body: { error: { type: "not_found_error" } } },
    ]);
    const result = await runCheck(
      anthropic({ secrets: { apiKey: KEY }, track: { models: ["claude-a", "claude-gone"] } }),
      { fetch }
    );
    expect(result.status).toBe("degraded");
    expect(result.instances?.map((i) => [i.key, i.status])).toEqual([
      ["claude-a", "up"],
      ["claude-gone", "down"],
    ]);
    expect(result.instanceLabels).toEqual({ key: "Model" });
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("is down when every model is missing, degraded when overloaded", async () => {
    const gone = mockFetch([{ url: "/v1/models/", status: 404 }]);
    expect((await runCheck(anthropic({ secrets: { apiKey: KEY }, track: { models: ["a", "b"] } }), { fetch: gone })).status).toBe("down");
    const busy = mockFetch([{ url: "/v1/models/", status: 529 }]);
    const result = await runCheck(anthropic({ secrets: { apiKey: KEY }, track: { models: ["a"] } }), { fetch: busy });
    expect(result.status).toBe("degraded");
  });

  it("reports a rejected key once, without model rows or the key", async () => {
    const fetch = mockFetch([{ url: "/v1/models/", status: 401, body: { error: { message: `invalid x-api-key ${KEY}` } } }]);
    const result = await runCheck(anthropic({ secrets: { apiKey: KEY }, track: { models: ["a", "b"] } }), { fetch });
    expect(result.status).toBe("down");
    expect(result.instances).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("is not configured without a key", async () => {
    expect(anthropic({ secrets: { apiKey: undefined } }).missing).toEqual(['secret "apiKey"']);
  });
});

describe("aws.bedrock", () => {
  const models = ["eu.anthropic.claude-haiku-4-5-20251001-v1:0", "cohere.embed-english-v3"];

  it("invokes each model with a bearer token and the body its family expects", async () => {
    const fetch = mockFetch([{ url: "bedrock-runtime.eu-west-1.amazonaws.com/model/", body: {} }]);
    const result = await runCheck(aws.bedrock({ region: "eu-west-1", models, secrets: { bearerToken: KEY } }), { fetch });
    expect(result.status).toBe("up");
    expect(result.instances?.map((i) => i.key)).toEqual(models);
    expect(fetch.calls.every((call) => call.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    expect(JSON.parse(fetch.calls[0]?.body ?? "{}").max_tokens).toBe(1);
    expect(JSON.parse(fetch.calls[1]?.body ?? "{}").texts).toEqual(["ping"]);
  });

  it("signs with SigV4 when given an access key pair", async () => {
    const fetch = mockFetch([{ url: "/invoke", body: {} }]);
    const result = await runCheck(
      aws.bedrock({ region: "us-east-1", models: ["m"], secrets: { accessKeyId: "AKIAEXAMPLEEXAMPLE", secretAccessKey: KEY } }),
      { fetch }
    );
    expect(result.status).toBe("up");
    expect(fetch.calls[0]?.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
  });

  it("is degraded when one model is throttled or failing", async () => {
    const fetch = mockFetch([
      { url: "cohere", status: 429 },
      { url: "/invoke", body: {} },
    ]);
    const result = await runCheck(aws.bedrock({ region: "eu-west-1", models, secrets: { bearerToken: KEY } }), { fetch });
    expect(result.status).toBe("degraded");
    expect(result.instances?.[1]?.status).toBe("degraded");
  });

  it("needs one kind of credentials, not both", () => {
    expect(aws.bedrock({ region: "r", models, secrets: { bearerToken: KEY } }).missing).toEqual([]);
    expect(aws.bedrock({ region: "r", models, secrets: {} }).missing).toHaveLength(2);
    expect(aws.bedrock({ region: undefined, models, secrets: { bearerToken: KEY } }).missing).toEqual(['field "region"']);
  });
});

describe("neon.project", () => {
  const endpoint = (overrides: object) => ({
    id: "ep-main-123",
    branch_id: "br-main",
    region_id: "aws-eu-west-2",
    type: "read_write",
    current_state: "active",
    ...overrides,
  });
  const routes = (endpoints: object[]) => [
    { url: "/endpoints", body: { endpoints } },
    { url: "/branches", body: { branches: [{ id: "br-main", name: "main", default: true, logical_size: 2 * 1024 ** 3 }] } },
    { url: "/projects/p1", body: { project: { pg_version: 17, region_id: "aws-eu-west-2", compute_time_seconds: 7200 } } },
  ];
  const options = { projectId: "p1", secrets: { apiKey: KEY } };

  it("pings an active compute and reports it", async () => {
    let pings = 0;
    const result = await runCheck(
      neon.project({ ...options, query: async () => void pings++, track: { compute: { maxHours: 100 }, storage: { maxGb: 10 } } }),
      { fetch: mockFetch(routes([endpoint({})])) }
    );
    expect(pings).toBe(1);
    expect(result.status).toBe("up");
    expect(result.probed).toBe(true);
    expect(result.instances).toMatchObject([{ key: "main", state: "active", status: "up" }]);
    expect(result.metrics).toMatchObject({ postgres: 17, branches: 1, computes: "1/1 active" });
    expect(result.usage?.map((u) => [u.label, u.used, u.limit])).toEqual([
      ["Compute this period", 2, 100],
      ["Storage", 2, 10],
    ]);
  });

  it("never wakes a suspended compute", async () => {
    let pings = 0;
    const result = await runCheck(neon.project({ ...options, query: async () => void pings++ }), {
      fetch: mockFetch(routes([endpoint({ current_state: "idle" })])),
    });
    expect(pings).toBe(0);
    expect(result.status).toBe("sleeping");
    expect(result.probed).toBe(false);
  });

  it("follows the compute named in `endpoint`", async () => {
    let pings = 0;
    const result = await runCheck(neon.project({ ...options, endpoint: "ep-dev-456", query: async () => void pings++ }), {
      fetch: mockFetch(routes([endpoint({}), endpoint({ id: "ep-dev-456", current_state: "idle" })])),
    });
    expect(pings).toBe(0);
    expect(result.status).toBe("sleeping");
    expect(result.instances?.map((i) => i.key)).toEqual(["main", "main#2"]);
  });

  it("is down when an active compute doesn't answer, degraded near a limit", async () => {
    const failing = await runCheck(
      neon.project({
        ...options,
        query: async () => {
          throw new Error("connection refused");
        },
      }),
      { fetch: mockFetch(routes([endpoint({})])) }
    );
    expect(failing.status).toBe("down");
    const full = await runCheck(neon.project({ ...options, track: { storage: { maxGb: 2 } } }), {
      fetch: mockFetch(routes([endpoint({})])),
    });
    expect(full.status).toBe("degraded");
  });

  it("separates a missing project from an unreadable API", async () => {
    const missing = await runCheck(neon.project(options), { fetch: mockFetch([{ url: "/projects/p1", status: 404 }]) });
    expect(missing.status).toBe("down");
    const broken = await runCheck(neon.project(options), { fetch: mockFetch([{ url: "/projects/p1", status: 500 }]) });
    expect(broken.status).toBe("degraded");
  });
});

describe("stripe", () => {
  const balance = { url: "/v1/balance", body: { livemode: true, available: [{ amount: 12345, currency: "eur" }], pending: [] } };
  const healthy = [
    balance,
    { url: "/v1/account", body: { charges_enabled: true, payouts_enabled: true, requirements: { past_due: [] } } },
    { url: "/v1/webhook_endpoints", body: { data: [{ id: "we_1", url: "https://fmd.vc/api/webhooks/stripe?x=1", status: "enabled" }] } },
    { url: "/v1/events", body: { data: [], has_more: false } },
    { url: "/v1/disputes", body: { data: [{ status: "needs_response" }, { status: "won" }] } },
  ];

  it("reports balance, endpoints, deliveries and disputes", async () => {
    const fetch = mockFetch(healthy);
    const result = await runCheck(stripe({ secrets: { apiKey: KEY } }), { fetch, now: () => 1_700_000_000_000 });
    expect(result.status).toBe("up");
    expect(result.metrics).toMatchObject({ mode: "live", available: "123.45 EUR", undelivered24h: "0", openDisputes: 1 });
    expect(result.instances).toMatchObject([{ key: "fmd.vc/api/webhooks/stripe", status: "up" }]);
    expect(fetch.calls.find((call) => call.url.includes("/events"))?.url).toContain("created[gte]=1699913600");
  });

  it("is degraded on a disabled endpoint, undelivered events or a blocked live account", async () => {
    const fetch = mockFetch([
      balance,
      { url: "/v1/account", body: { charges_enabled: false, payouts_enabled: true } },
      { url: "/v1/webhook_endpoints", body: { data: [{ id: "we_1", url: "https://fmd.vc/hook", status: "disabled" }] } },
      { url: "/v1/events", body: { data: [{}, {}], has_more: true } },
      { url: "/v1/disputes", body: { data: [] } },
    ]);
    const result = await runCheck(stripe({ secrets: { apiKey: KEY } }), { fetch });
    expect(result.status).toBe("degraded");
    expect(result.error).toContain("Charges are disabled");
    expect(result.error).toContain("1 webhook endpoint(s) disabled");
    expect(result.error).toContain("2+ event(s) not delivered");
  });

  it("skips what a restricted key may not read, and what track turns off", async () => {
    const restricted = mockFetch([balance, { url: "/v1/", status: 403 }]);
    const result = await runCheck(stripe({ secrets: { apiKey: KEY } }), { fetch: restricted });
    expect(result.status).toBe("up");
    expect(result.instances).toBeUndefined();

    const only = mockFetch([balance]);
    await runCheck(stripe({ secrets: { apiKey: KEY }, track: { account: false, webhooks: false, disputes: false } }), { fetch: only });
    expect(only.calls).toHaveLength(1);
  });

  it("is down when the key is rejected", async () => {
    const result = await runCheck(stripe({ secrets: { apiKey: KEY } }), { fetch: mockFetch([{ url: "/v1/", status: 401 }]) });
    expect(result.status).toBe("down");
  });
});

describe("tavily", () => {
  it("shows the plan's credits, and warns near the limit", async () => {
    const body = { key: { usage: 10, limit: null }, account: { current_plan: "Researcher", plan_usage: 950, plan_limit: 1000 } };
    const result = await runCheck(tavily({ secrets: { apiKey: KEY } }), { fetch: mockFetch([{ url: "/usage", body }]) });
    expect(result.status).toBe("degraded");
    expect(result.usage).toMatchObject([{ label: "Credits", used: 950, limit: 1000 }]);
    expect(result.metrics).toEqual({ plan: "Researcher" });
  });

  it("prefers the key's own limit", async () => {
    const body = { key: { usage: 10, limit: 100 }, account: { plan_usage: 950, plan_limit: 1000 } };
    const result = await runCheck(tavily({ secrets: { apiKey: KEY } }), { fetch: mockFetch([{ url: "/usage", body }]) });
    expect(result.status).toBe("up");
    expect(result.usage).toMatchObject([{ used: 10, limit: 100 }]);
  });
});

describe.each([
  ["exa", exa, "api.exa.ai/search"],
  ["nimble", nimble, "sdk.nimbleway.com/v1/search"],
  ["emelia", emelia, "api.emelia.io/tools/find/email"],
] as const)("%s", (_name, preset, url) => {
  const run = (status: number) => runCheck(preset({ secrets: { apiKey: KEY } }), { fetch: mockFetch([{ url, status, body: { error: "x" } }]) });

  it("sends an empty request, so nothing is billed", async () => {
    const fetch = mockFetch([{ url, status: 400 }]);
    const result = await runCheck(preset({ secrets: { apiKey: KEY } }), { fetch });
    expect(result.status).toBe("up");
    expect(fetch.calls).toMatchObject([{ method: "POST", body: "{}" }]);
  });

  it("maps the answer to a status", async () => {
    expect((await run(422)).status).toBe("up");
    expect((await run(402)).status).toBe("degraded");
    expect((await run(429)).status).toBe("degraded");
    expect((await run(401)).status).toBe("down");
    expect((await run(500)).status).toBe("down");
  });
});
