import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { custom, defineStatus, group } from "../src";
import { createStatusHandler } from "../src/api";
import { generic, openai } from "../src/presets";
import { collectSecretValues, redactText, sanitizeError } from "../src/sanitize";
import { mockFetch, runCheck } from "../src/testing";

const KEY = "zq9-live-4f8a1c22d7b94e06a3f5";

describe("secrets never reach public results", () => {
  it("redacts a secret that sits where the body is cut", async () => {
    // The key straddles the 200-character cut of error snippets
    const body = `${"x".repeat(190)} ${KEY} trailing`;
    const result = await runCheck(
      custom({ name: "api", secrets: { apiKey: KEY }, check: async ({ http }) => (await http("https://a.test/")).outcome }),
      { fetch: mockFetch([{ url: "a.test", status: 500, body }]) }
    );
    expect(result.status).toBe("down");
    for (let length = 6; length <= KEY.length; length++) expect(result.error).not.toContain(KEY.slice(0, length));
  });

  it("leaves the body out when credentials are rejected", async () => {
    const result = await runCheck(openai({ secrets: { apiKey: KEY } }), {
      fetch: mockFetch([
        { url: "api.openai.com", status: 401, body: { error: { message: "Incorrect API key provided: zq9-live************a3f5" } } },
      ]),
    });
    expect(result).toMatchObject({ status: "down", httpStatus: 401, error: "HTTP 401: credentials rejected" });
    const forbidden = await runCheck(openai({ secrets: { apiKey: KEY } }), {
      fetch: mockFetch([{ url: "api.openai.com", status: 403, body: `no access for ${KEY.slice(0, 12)}` }]),
    });
    expect(forbidden.error).toBe("HTTP 403: access denied");
  });

  it("redacts metrics, usage labels and instance fields, not only errors", async () => {
    const result = await runCheck(
      custom({
        name: "api",
        secrets: { apiKey: KEY },
        check: () => ({
          status: "up",
          metrics: { account: `acct for ${KEY}`, count: 3 },
          usage: [{ label: `quota of ${KEY}`, used: 1, limit: 2, unit: KEY }],
          instances: [{ key: "a", id: KEY, region: `r-${KEY}`, state: KEY, status: "down", error: `boom ${KEY}` }],
        }),
      })
    );
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.metrics).toEqual({ account: "acct for ***", count: 3 });
  });

  it("redacts encoded forms of a secret and the parts of a connection string", () => {
    const password = "p@ss/w0rd+long";
    const url = `mongodb://admin-user:${encodeURIComponent(password)}@db.internal:27017/app`;
    const secretValues = collectSecretValues([KEY, url, "a b&c=secret"]);
    const redact = (text: string) => redactText({ text, secretValues });
    expect(redact(`auth failed for admin-user with ${password}`)).toBe("auth failed for *** with ***");
    expect(redact(`sent ${btoa(KEY)}`)).not.toContain(btoa(KEY).replace(/=+$/, ""));
    expect(redact(`q=${encodeURIComponent("a b&c=secret")}`)).toBe("q=***");
    expect(redact(JSON.stringify({ key: 'say "hi" twice' }))).toContain("hi");
  });

  it("redacts credential-shaped values that were never declared", () => {
    const redact = (text: string) => redactText({ text, secretValues: [] });
    const samples = [
      "sk-proj-abcdefghijklmnop1234",
      "sk-proj-********************wxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz",
      "xoxb-123456789012-abcdefghijkl",
      "AKIAIOSFODNN7EXAMPLE",
      "AIzaSyA-abcdefghijklmnopqrstuvwxyz012345",
      "ya29.a0AfH6SMBabcdefghijklmnop",
      "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJhQGIifQ.c2lnbmF0dXJl",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    ];
    for (const sample of samples) {
      const out = redact(`error: ${sample} rejected`);
      expect(out.startsWith("error: ***")).toBe(true);
      expect(out).not.toContain(sample.slice(0, 14));
    }
    expect(redact("DeepL-Auth-Key 1234abcd-12ab-34cd:fx")).toBe("DeepL-Auth-Key ***:fx");
    expect(redact("wss://ws.example.com/app/thekey?protocol=7&token=abc")).toBe("wss://ws.example.com/app/thekey?***");
    // Ordinary text is left alone
    expect(redact("task-management-system is slow; risk-assessment pending")).toBe(
      "task-management-system is slow; risk-assessment pending"
    );
  });

  it("quotes response bodies by default and never with hideResponseBodies", async () => {
    const service = () => generic.http({ name: "internal", url: "https://internal.test/health" });
    const fetch = () => mockFetch([{ url: "internal.test", status: 500, body: "DEBUG dump: DATABASE_PASSWORD=hunter2" }]);
    expect((await runCheck(service(), { fetch: fetch() })).error).toBe("HTTP 500: DEBUG dump: DATABASE_PASSWORD=hunter2");
    expect((await runCheck(service(), { fetch: fetch(), hideResponseBodies: true })).error).toBe("HTTP 500");

    const status = defineStatus({ services: [service()], fetch: fetch(), hideResponseBodies: true });
    const report = await status.run();
    expect(report.results[0]).toMatchObject({ status: "down", httpStatus: 500, error: "HTTP 500" });
    expect(JSON.stringify(await status.snapshot())).not.toContain("hunter2");
  });

  it("truncates only after redacting", () => {
    const message = `${"y".repeat(290)} ${KEY}`;
    const out = sanitizeError({ message, secretValues: collectSecretValues([KEY]) })!;
    for (let length = 6; length <= KEY.length; length++) expect(out).not.toContain(KEY.slice(0, length));
  });

  it("redacts credentials written into generic.http headers", async () => {
    const service = generic.http({
      name: "internal",
      url: "https://internal.test/health",
      headers: { Authorization: `Bearer ${KEY}`, "x-api-key": "another-plain-key-123", accept: "application/json" },
    });
    const result = await runCheck(service, {
      fetch: mockFetch([{ url: "internal.test", status: 500, body: `bad ${KEY} and another-plain-key-123 for application/json` }]),
    });
    expect(result.error).toBe("HTTP 500: bad *** and *** for application/json");
  });
});

describe("secrets never reach logs or serialized configuration", () => {
  const services = () => [
    group({
      title: "g",
      services: [
        custom({ name: "c", secrets: { apiKey: KEY }, check: () => true }),
        openai({ secrets: { apiKey: `${KEY}-openai` } }),
        generic.http({ name: "h", url: "https://h.test", headers: { Authorization: `Bearer ${KEY}-header` } }),
      ],
    }),
  ];

  it("does not print secrets when the configuration or the engine is logged", () => {
    const tree = services();
    const status = defineStatus({ services: tree });
    const dump = (value: unknown) =>
      inspect(value, { depth: 12, breakLength: Infinity }) + JSON.stringify(value) + JSON.stringify({ ...(value as object) });
    for (const value of [tree, status, status.services, [...status.services.values()], status.tree]) {
      expect(dump(value)).not.toContain(KEY);
    }
    // Still available to the engine
    expect(status.services.get("g:c")?.secrets.apiKey).toBe(KEY);
    expect(status.redact(`x ${KEY}-openai y ${KEY}-header`)).toBe("x *** y ***");
  });

  it("logs store failures without their credentials", async () => {
    const dsn = "rediss://default:store-pass-9d2f7a@redis.internal:6379";
    const status = defineStatus({
      services: services(),
      store: {
        latest: async () => {
          throw Object.assign(new Error(`connect ECONNREFUSED ${dsn}`), {
            cause: new Error(`auth with Bearer abcdefgh12345678 and ${KEY} failed`),
            config: { password: "store-pass-9d2f7a" },
          });
        },
        saveRun: async () => undefined,
        runs: async () => [],
        samples: async () => [],
        prune: async () => undefined,
      },
    });
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => void logged.push(args.map(String).join(" ")));
    try {
      const response = await createStatusHandler(status)(new Request("http://x.test/api/status"));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "Internal error" });
    } finally {
      spy.mockRestore();
    }
    const output = logged.join("\n");
    expect(output).toContain("ECONNREFUSED");
    expect(output).not.toContain("store-pass-9d2f7a");
    expect(output).not.toContain(KEY);
    expect(output).not.toContain("abcdefgh12345678");

    const seen: string[] = [];
    await createStatusHandler(status, { onError: ({ message }) => seen.push(message) })(new Request("http://x.test/api/status"));
    expect(seen[0]).toContain("ECONNREFUSED");
    expect(seen[0]).not.toContain("store-pass-9d2f7a");
  });

  it("answers a malformed path without throwing", async () => {
    const response = await createStatusHandler(defineStatus({ services: services() }))(new Request("http://x.test/api/run/%E0%A4%A"));
    expect(response.status).toBe(404);
  });
});
