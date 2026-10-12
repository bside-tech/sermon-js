import { describe, expect, it } from "vitest";
import {
  anthropic,
  attendee,
  axiom,
  azureTranslator,
  cambai,
  cloudflareStream,
  deepgram,
  deepl,
  elevenlabs,
  gemini,
  github,
  gladia,
  mailersend,
  meilisearch,
  mux,
  openai,
  resend,
  revolut,
  speechmatics,
  statuspage,
  upstashRedis,
  vercel,
} from "../src/presets";
import { mockFetch, runCheck, type MockRoute } from "../src/testing";
import type { ServiceDefinition } from "../src";

const run = async (service: ServiceDefinition, routes: MockRoute[]) => {
  const fetch = mockFetch(routes);
  return { result: await runCheck(service, { fetch }), fetch };
};

describe("single-call providers", () => {
  // preset, the request it must make, and how the key travels
  const cases: Array<{
    name: string;
    service: ServiceDefinition;
    url: string;
    method?: string;
    header: [string, string];
    body?: string;
  }> = [
    { name: "Gladia", service: gladia({ secrets: { apiKey: "key-123456" } }), url: "https://api.gladia.io/v2/live?limit=1", header: ["x-gladia-key", "key-123456"] },
    { name: "Speechmatics", service: speechmatics({ secrets: { apiKey: "key-123456" } }), url: "https://asr.api.speechmatics.com/v2/jobs?limit=1", header: ["authorization", "Bearer key-123456"] },
    { name: "OpenAI", service: openai({ secrets: { apiKey: "key-123456" } }), url: "https://api.openai.com/v1/models", header: ["authorization", "Bearer key-123456"] },
    { name: "Anthropic", service: anthropic({ secrets: { apiKey: "key-123456" } }), url: "https://api.anthropic.com/v1/models?limit=1", header: ["x-api-key", "key-123456"] },
    { name: "Google Gemini", service: gemini({ secrets: { apiKey: "key-123456" } }), url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", header: ["x-goog-api-key", "key-123456"] },
    { name: "CAMB.AI", service: cambai({ secrets: { apiKey: "key-123456" } }), url: "https://client.camb.ai/apis/source-languages", header: ["x-api-key", "key-123456"] },
    { name: "Mux", service: mux({ secrets: { tokenId: "id-1234", tokenSecret: "key-123456" } }), url: "https://api.mux.com/video/v1/live-streams?limit=1", header: ["authorization", `Basic ${btoa("id-1234:key-123456")}`] },
    { name: "Azure Translator", service: azureTranslator({ secrets: { apiKey: "key-123456" } }), url: "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=fr", method: "POST", header: ["ocp-apim-subscription-key", "key-123456"], body: '[{"Text":"a"}]' },
    { name: "Revolut Merchant", service: revolut({ secrets: { apiKey: "key-123456" } }), url: "https://merchant.revolut.com/api/1.0/orders?limit=1", header: ["authorization", "Bearer key-123456"] },
    { name: "Attendee", service: attendee({ secrets: { apiKey: "key-123456" } }), url: "https://app.attendee.dev/api/v1/bots?page_size=1", header: ["authorization", "Token key-123456"] },
    { name: "Vercel Blob", service: vercel.blob({ secrets: { token: "key-123456" } }), url: "https://vercel.com/api/blob?limit=1", header: ["authorization", "Bearer key-123456"] },
    { name: "Axiom", service: axiom({ dataset: "logs", secrets: { token: "key-123456" } }), url: "https://api.axiom.co/v1/datasets/logs/ingest", method: "POST", header: ["authorization", "Bearer key-123456"], body: "[]" },
  ];

  for (const c of cases) {
    it(`${c.name}: up when the API answers, down when it rejects the key, degraded on 429`, async () => {
      expect(c.service.name).toBe(c.name);
      const up = await run(c.service, [{ url: new URL(c.url).host, status: 200, body: {} }]);
      expect(up.result).toMatchObject({ status: "up", httpStatus: 200, probed: true });
      expect(up.fetch.calls).toHaveLength(1);
      expect(up.fetch.calls[0]).toMatchObject({ url: c.url, method: c.method ?? "GET" });
      expect(up.fetch.calls[0]?.headers[c.header[0]]).toBe(c.header[1]);
      if (c.body) expect(up.fetch.calls[0]?.body).toBe(c.body);

      const down = await run(c.service, [{ url: new URL(c.url).host, status: 401, body: { error: "invalid key-123456" } }]);
      expect(down.result).toMatchObject({ status: "down", httpStatus: 401 });
      // The key never appears in the public error
      expect(down.result.error).not.toContain("123456");

      expect((await run(c.service, [{ url: new URL(c.url).host, status: 429 }])).result.status).toBe("degraded");
    });
  }

  it("each is not configured without its secret, and calls nothing", async () => {
    const services = [
      gladia({ secrets: { apiKey: undefined } }),
      openai({ secrets: { apiKey: "" } }),
      mux({ secrets: { tokenId: "id", tokenSecret: undefined } }),
      axiom({ dataset: undefined, secrets: { token: "t" } }),
    ];
    for (const service of services) {
      const { result, fetch } = await run(service, []);
      expect(result.status).toBe("unconfigured");
      expect(fetch.calls).toHaveLength(0);
    }
  });

  it("honours provider options", async () => {
    expect((await run(speechmatics({ baseUrl: "https://eu1.asr.api.speechmatics.com/", secrets: { apiKey: "k" } }), [{ url: "eu1.asr" }])).fetch.calls[0]?.url).toBe(
      "https://eu1.asr.api.speechmatics.com/v2/jobs?limit=1"
    );
    const withModel = await run(openai({ organization: "org-1", track: { model: "gpt-4.1" }, secrets: { apiKey: "k" } }), [{ url: "openai.com" }]);
    expect(withModel.fetch.calls[0]).toMatchObject({ url: "https://api.openai.com/v1/models/gpt-4.1", headers: { "openai-organization": "org-1" } });
    expect((await run(revolut({ environment: "sandbox", secrets: { apiKey: "k" } }), [{ url: "revolut.com" }])).fetch.calls[0]?.url).toContain(
      "sandbox-merchant.revolut.com"
    );
    expect((await run(attendee({ baseUrl: "https://bots.example.com/", secrets: { apiKey: "k" } }), [{ url: "bots.example.com" }])).fetch.calls[0]?.url).toBe(
      "https://bots.example.com/api/v1/bots?page_size=1"
    );
    expect((await run(axiom({ dataset: "logs", edge: "eu.edge.axiom.co", secrets: { token: "k" } }), [{ url: "edge.axiom.co" }])).fetch.calls[0]?.url).toBe(
      "https://eu.edge.axiom.co/v1/ingest/logs"
    );
    expect((await run(azureTranslator({ region: "northeurope", secrets: { apiKey: "k" } }), [{ url: "microsofttranslator" }])).fetch.calls[0]?.headers["ocp-apim-subscription-region"]).toBe(
      "northeurope"
    );
  });
});

describe("deepgram", () => {
  const service = (track?: Parameters<typeof deepgram>[0]["track"]) => deepgram({ secrets: { apiKey: "dg-key-1234" }, track });
  const projects: MockRoute = { url: "/v1/projects", body: { projects: [{ project_id: "p1" }] } };

  it("reports the balance", async () => {
    const { result, fetch } = await run(service(), [
      { url: "/v1/projects/p1/balances", body: { balances: [{ amount: 81.456, units: "usd" }] } },
      projects,
    ]);
    expect(result).toMatchObject({ status: "up", metrics: { balance: "81.46 usd" } });
    expect(fetch.calls[0]?.headers.authorization).toBe("Token dg-key-1234");
  });

  it("is degraded on a low balance, with a configurable threshold", async () => {
    const routes: MockRoute[] = [{ url: "/balances", body: { balances: [{ amount: 12, units: "usd" }] } }, projects];
    expect((await run(service(), routes)).result).toMatchObject({ status: "degraded", error: "Low balance" });
    expect((await run(service({ balance: { warnBelow: 10 } }), routes)).result.status).toBe("up");
  });

  it("stays up when the key can't read balances, and can skip them", async () => {
    expect((await run(service(), [{ url: "/balances", status: 403 }, projects])).result).toMatchObject({ status: "up" });
    const skipped = await run(service({ balance: false }), [projects]);
    expect(skipped.fetch.calls).toHaveLength(1);
    expect(skipped.result.metrics).toBeUndefined();
  });

  it("is degraded when the key sees no project, down when rejected", async () => {
    expect((await run(service(), [{ url: "/v1/projects", body: { projects: [] } }])).result).toMatchObject({
      status: "degraded",
      error: "No project visible to this key",
    });
    expect((await run(service(), [{ url: "/v1/projects", status: 401 }])).result.status).toBe("down");
  });
});

describe("deepl", () => {
  it("reports character usage and warns near the limit", async () => {
    const ok = await run(deepl({ secrets: { apiKey: "key-123456" } }), [{ url: "/v2/usage", body: { character_count: 250_000, character_limit: 500_000 } }]);
    expect(ok.result).toMatchObject({ status: "up", usage: [{ label: "Characters", used: 250_000, limit: 500_000, unit: "characters" }] });
    expect(ok.fetch.calls[0]).toMatchObject({ url: "https://api.deepl.com/v2/usage", headers: { authorization: "DeepL-Auth-Key key-123456" } });

    const near = await run(deepl({ secrets: { apiKey: "k" } }), [{ url: "/v2/usage", body: { character_count: 460_000, character_limit: 500_000 } }]);
    expect(near.result).toMatchObject({ status: "degraded", error: "Character quota almost exhausted" });
    const relaxed = await run(deepl({ secrets: { apiKey: "k" }, track: { quota: { warnAbovePct: 95 } } }), [
      { url: "/v2/usage", body: { character_count: 460_000, character_limit: 500_000 } },
    ]);
    expect(relaxed.result.status).toBe("up");
  });

  it("uses the free API host for free keys", async () => {
    const { fetch } = await run(deepl({ secrets: { apiKey: "abc:fx" } }), [{ url: "api-free.deepl.com", body: {} }]);
    expect(fetch.calls[0]?.url).toBe("https://api-free.deepl.com/v2/usage");
  });
});

describe("cloudflareStream", () => {
  const service = (track?: Parameters<typeof cloudflareStream>[0]["track"]) =>
    cloudflareStream({ accountId: "acct1", secrets: { token: "cf-token-1" }, track });
  const storage = (used: number): MockRoute => ({
    url: "/stream/storage-usage",
    body: { success: true, result: { videoCount: 40, totalStorageMinutes: used, totalStorageMinutesLimit: 2000 } },
  });
  const videos: MockRoute = { url: "/stream?limit=1", body: { success: true, result: [] } };

  it("reports storage usage and the video count from two parallel calls", async () => {
    const { result, fetch } = await run(service(), [storage(794.98), videos]);
    expect(result).toMatchObject({
      status: "up",
      usage: [{ label: "Video storage", used: 795, limit: 2000, unit: "min" }],
      metrics: { videos: 40 },
    });
    expect(fetch.calls.map((call) => call.url).sort()).toEqual([
      "https://api.cloudflare.com/client/v4/accounts/acct1/stream/storage-usage",
      "https://api.cloudflare.com/client/v4/accounts/acct1/stream?limit=1",
    ]);
  });

  it("is degraded when storage is almost full", async () => {
    expect((await run(service(), [storage(1900), videos])).result).toMatchObject({ status: "degraded", error: "Stream storage almost full" });
  });

  it("is down when either call fails or Cloudflare reports failure", async () => {
    expect((await run(service(), [storage(100), { url: "/stream?limit=1", status: 403 }])).result.status).toBe("down");
    expect((await run(service(), [storage(100), { url: "/stream?limit=1", body: { success: false } }])).result).toMatchObject({
      status: "down",
      error: "Cloudflare API reported success=false",
    });
  });

  it("can skip storage", async () => {
    const { result, fetch } = await run(service({ storage: false }), [videos]);
    expect(result.status).toBe("up");
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("mailersend", () => {
  it("reports API requests used, with the reset time", async () => {
    const { result } = await run(mailersend({ secrets: { apiKey: "k" } }), [
      { url: "/v1/api-quota", body: { quota: 100, remaining: 85, reset: "2026-10-10T00:00:00Z" } },
    ]);
    expect(result).toMatchObject({
      status: "up",
      usage: [{ label: "API requests", used: 15, limit: 100, unit: "requests", resetsAt: Date.parse("2026-10-10T00:00:00Z") }],
    });
  });

  it("is degraded when under 10% is left", async () => {
    expect((await run(mailersend({ secrets: { apiKey: "k" } }), [{ url: "/v1/api-quota", body: { quota: 100, remaining: 5 } }])).result).toMatchObject({
      status: "degraded",
      error: "API quota almost exhausted",
    });
  });
});

describe("github", () => {
  const limit = (remaining: number): MockRoute => ({ url: "/rate_limit", body: { resources: { core: { limit: 5000, remaining, reset: 1_791_564_595 } } } });

  it("reports requests this hour", async () => {
    const { result, fetch } = await run(github({ secrets: { token: "ghp-123456" } }), [limit(4990)]);
    expect(result).toMatchObject({
      status: "up",
      usage: [{ label: "API requests this hour", used: 10, limit: 5000, unit: "requests", resetsAt: 1_791_564_595_000 }],
    });
    expect(fetch.calls[0]?.headers).toMatchObject({ authorization: "Bearer ghp-123456", "user-agent": "sermon-js" });
  });

  it("is degraded near the rate limit and down on bad credentials", async () => {
    expect((await run(github({ secrets: { token: "t" } }), [limit(100)])).result).toMatchObject({ status: "degraded", error: "Rate limit almost exhausted" });
    expect((await run(github({ secrets: { token: "t" } }), [{ url: "/rate_limit", status: 401, body: { message: "Bad credentials" } }])).result.status).toBe("down");
  });

  it("can also require access to a repository's releases", async () => {
    const service = github({ secrets: { token: "t" }, track: { repo: "line-21/line21" } });
    expect(service.identity).toBe("github:line-21/line21");
    const ok = await run(service, [limit(5000), { url: "/repos/line-21/line21/releases", body: [] }]);
    expect(ok.result.status).toBe("up");
    expect(ok.fetch.calls.map((call) => call.url)).toContain("https://api.github.com/repos/line-21/line21/releases?per_page=1");
    expect((await run(service, [limit(5000), { url: "/repos/", status: 404 }])).result.status).toBe("down");
  });
});

describe("statuspage", () => {
  const service = statuspage({ url: "https://status.flyio.net/" });
  const page = (indicator: string, description: string): MockRoute[] => [{ url: "/api/v2/status.json", body: { status: { indicator, description } } }];

  it("derives its name and identity from the host", () => {
    expect(service).toMatchObject({ kind: "statuspage", name: "status.flyio.net", identity: "statuspage:status.flyio.net" });
    expect(statuspage({ name: "Fly.io platform", url: "https://status.flyio.net" }).name).toBe("Fly.io platform");
  });

  it("maps the provider's indicator to a status", async () => {
    const up = await run(service, page("none", "All Systems Operational"));
    expect(up.result).toMatchObject({ status: "up" });
    expect(up.result.error).toBeUndefined();
    expect(up.fetch.calls[0]?.url).toBe("https://status.flyio.net/api/v2/status.json");
    expect((await run(service, page("minor", "Degraded deploys"))).result).toMatchObject({ status: "degraded", error: "Degraded deploys" });
    expect((await run(service, page("major", "Regional outage"))).result).toMatchObject({ status: "down", error: "Regional outage" });
    expect((await run(service, page("critical", "Global outage"))).result.status).toBe("down");
  });

  it("is degraded when the page isn't a Statuspage", async () => {
    expect((await run(service, [{ url: "status.json", body: "<html>" }])).result).toMatchObject({ status: "degraded", error: "Not a Statuspage answer" });
  });
});

describe("upstashRedis", () => {
  it("pings over REST", async () => {
    const service = upstashRedis({ url: "https://db.upstash.test/", secrets: { token: "tok-12345" } });
    const { result, fetch } = await run(service, [{ url: "db.upstash.test", body: { result: "PONG" } }]);
    expect(result.status).toBe("up");
    expect(fetch.calls[0]).toMatchObject({
      url: "https://db.upstash.test",
      method: "POST",
      body: '["PING"]',
      headers: { authorization: "Bearer tok-12345" },
    });
    expect((await run(service, [{ url: "db.upstash.test", body: { result: "nope" } }])).result).toMatchObject({ status: "down", error: "Unexpected reply to PING" });
    expect(upstashRedis({ url: undefined, secrets: { token: "t" } }).missing).toEqual(['field "url"']);
  });
});

describe("vercel.aiGateway", () => {
  const service = (track?: Parameters<typeof vercel.aiGateway>[0]["track"]) =>
    vercel.aiGateway({ secrets: { apiKey: "gw-key-12345" }, track });
  const credits = (balance: string): MockRoute => ({ url: "/v1/credits", body: { balance, total_used: "14.341" } });

  it("reports the credit balance", async () => {
    const { result, fetch } = await run(service(), [credits("95.50")]);
    expect(result).toMatchObject({ key: "vercel.aigateway", status: "up", metrics: { balance: "95.5 USD", used: "14.34 USD" } });
    expect(result.error).toBeUndefined();
    expect(fetch.calls[0]).toMatchObject({
      url: "https://ai-gateway.vercel.sh/v1/credits",
      headers: { authorization: "Bearer gw-key-12345" },
    });
  });

  it("is degraded on a low balance, with a configurable threshold", async () => {
    expect((await run(service(), [credits("0.66")])).result).toMatchObject({ status: "degraded", error: "Low credit balance" });
    expect((await run(service({ credits: { warnBelow: 0.5 } }), [credits("0.66")])).result.status).toBe("up");
  });

  it("is down when the key is rejected, and stays up on an answer without a balance", async () => {
    expect((await run(service(), [{ url: "/v1/credits", status: 401 }])).result).toMatchObject({ status: "down", httpStatus: 401 });
    const bare = (await run(service(), [{ url: "/v1/credits", body: {} }])).result;
    expect(bare.status).toBe("up");
    expect(bare.metrics).toBeUndefined();
  });

  it("can skip credits and list models instead", async () => {
    const { result, fetch } = await run(service({ credits: false }), [{ url: "/v1/models", body: { data: [] } }]);
    expect(result.status).toBe("up");
    expect(fetch.calls.map((call) => call.url)).toEqual(["https://ai-gateway.vercel.sh/v1/models"]);
    expect(vercel.aiGateway({ secrets: { apiKey: undefined } }).missing).toEqual(['secret "apiKey"']);
  });
});

describe("elevenlabs", () => {
  const service = (track?: Parameters<typeof elevenlabs>[0]["track"]) => elevenlabs({ secrets: { apiKey: "el-key-12345" }, track });
  const subscription = (used: number): MockRoute => ({
    url: "/v1/user/subscription",
    body: { tier: "creator", character_count: used, character_limit: 100000, next_character_count_reset_unix: 1790000000 },
  });

  it("reports credits used, with the reset time", async () => {
    const { result, fetch } = await run(service(), [subscription(25000)]);
    expect(result).toMatchObject({
      status: "up",
      metrics: { tier: "creator" },
      usage: [{ label: "Credits", used: 25000, limit: 100000, unit: "credits", resetsAt: 1790000000000 }],
    });
    expect(fetch.calls[0]).toMatchObject({
      url: "https://api.elevenlabs.io/v1/user/subscription",
      headers: { "xi-api-key": "el-key-12345" },
    });
  });

  it("is degraded when under 10% is left, with a configurable threshold", async () => {
    expect((await run(service(), [subscription(95000)])).result).toMatchObject({ status: "degraded", error: "Credits almost exhausted" });
    expect((await run(service({ quota: { warnBelowPct: 2 } }), [subscription(95000)])).result.status).toBe("up");
  });

  it("counts a key without the user scope as working, and a rejected key as down", async () => {
    const restricted = await run(service(), [{ url: "/v1/user/subscription", status: 401, body: { detail: { status: "missing_permissions" } } }]);
    expect(restricted.result).toMatchObject({ status: "up", httpStatus: 401, metrics: { key: "restricted" } });
    expect(restricted.result.usage).toBeUndefined();
    const rejected = await run(service(), [{ url: "/v1/user/subscription", status: 401, body: { detail: { status: "invalid_api_key" } } }]);
    expect(rejected.result).toMatchObject({ status: "down", httpStatus: 401 });
  });
});

describe("resend", () => {
  const service = resend({ secrets: { apiKey: "re-key-12345" } });
  const domains = (...statuses: string[]): MockRoute => ({ url: "/domains", body: { data: statuses.map((status) => ({ status })) } });

  it("reports domains and how many are verified", async () => {
    const { result, fetch } = await run(service, [domains("verified", "pending")]);
    expect(result).toMatchObject({ key: "resend", status: "up", metrics: { domains: 2, verified: 1 } });
    expect(fetch.calls[0]).toMatchObject({ url: "https://api.resend.com/domains", headers: { authorization: "Bearer re-key-12345" } });
    expect((await run(service, [domains()])).result).toMatchObject({ status: "up", metrics: { domains: 0, verified: 0 } });
  });

  it("is degraded when no domain is verified", async () => {
    expect((await run(service, [domains("pending", "failed")])).result).toMatchObject({ status: "degraded", error: "No verified domain" });
  });

  it("counts a sending-only key as working, and a rejected key as down", async () => {
    const sendingOnly = await run(service, [{ url: "/domains", status: 401, body: { name: "restricted_api_key", message: "This API key is restricted to only send emails" } }]);
    expect(sendingOnly.result).toMatchObject({ status: "up", httpStatus: 401, metrics: { key: "sending only" } });
    expect(sendingOnly.result.error).toBeUndefined();
    const rejected = await run(service, [{ url: "/domains", status: 401, body: { name: "validation_error", message: "API key is invalid" } }]);
    expect(rejected.result).toMatchObject({ status: "down", httpStatus: 401 });
  });
});

describe("meilisearch", () => {
  const service = (index?: string) => meilisearch({ host: "https://search.test/", index, secrets: { apiKey: "ms-key-12345" } });
  const health: MockRoute = { url: "/health", body: { status: "available" } };
  const stats: MockRoute = { url: "/stats", body: { numberOfDocuments: 1200, isIndexing: true } };

  it("reads the health, the index and its statistics", async () => {
    const { result, fetch } = await run(service("content"), [health, stats, { url: "/indexes/content", body: { uid: "content" } }]);
    expect(result).toMatchObject({ key: "meilisearch:content", status: "up", metrics: { documents: 1200, indexing: "yes" } });
    expect(fetch.calls.map((call) => call.url).sort()).toEqual([
      "https://search.test/health",
      "https://search.test/indexes/content",
      "https://search.test/indexes/content/stats",
    ]);
    // The key is only sent where it is needed
    const byUrl = Object.fromEntries(fetch.calls.map((call) => [call.url, call.headers.authorization]));
    expect(byUrl).toEqual({
      "https://search.test/health": undefined,
      "https://search.test/indexes/content": "Bearer ms-key-12345",
      "https://search.test/indexes/content/stats": "Bearer ms-key-12345",
    });
    expect(service("content")).toMatchObject({ kind: "meilisearch", identity: "meilisearch:content" });
  });

  it("stays up, without metrics, when the key may not read statistics", async () => {
    const { result } = await run(service("content"), [health, { url: "/stats", status: 403, body: { code: "invalid_api_key" } }, { url: "/indexes/content", body: {} }]);
    expect(result.status).toBe("up");
    expect(result.metrics).toBeUndefined();
  });

  it("is degraded when the index is missing, down when unavailable or the key is rejected", async () => {
    const missing = await run(service("content"), [health, { url: "/stats", status: 404 }, { url: "/indexes/content", status: 404, body: { code: "index_not_found" } }]);
    expect(missing.result).toMatchObject({ status: "degraded", error: "Index content not found" });
    const unavailable = await run(service("content"), [{ url: "/health", body: { status: "starting" } }, stats, { url: "/indexes/content", body: {} }]);
    expect(unavailable.result).toMatchObject({ status: "down", error: "Not available" });
    const rejected = await run(service("content"), [health, { url: "/stats", status: 403 }, { url: "/indexes/content", status: 403, body: { code: "invalid_api_key" } }]);
    expect(rejected.result).toMatchObject({ status: "down", httpStatus: 403 });
  });

  it("lists indexes and sums their documents without an index", async () => {
    const { result, fetch } = await run(service(), [
      health,
      { url: "/stats", body: { indexes: { a: { numberOfDocuments: 3 }, b: { numberOfDocuments: 4 } } } },
      { url: "/indexes?limit=1", body: { results: [] } },
    ]);
    expect(result).toMatchObject({ status: "up", metrics: { documents: 7 } });
    expect(fetch.calls.map((call) => call.url).sort()).toEqual([
      "https://search.test/health",
      "https://search.test/indexes?limit=1",
      "https://search.test/stats",
    ]);
    expect(meilisearch({ host: undefined, secrets: { apiKey: "k" } }).missing).toEqual(['field "host"']);
  });
});
