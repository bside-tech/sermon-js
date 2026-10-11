import { describe, expect, it } from "vitest";
import { resolveTree, type ServiceDefinition } from "../src/config";
import { generic } from "../src/presets/generic";
import { runService } from "../src/runner";
import { collectSecretValues } from "../src/sanitize";
import { mockFetch, type MockRoute } from "../src/testing";

const run = async (service: ServiceDefinition, routes: MockRoute[]) => {
  const fetch = mockFetch(routes);
  const [resolved] = [...resolveTree([service]).services.values()];
  const result = await runService({
    service: resolved!,
    secretValues: collectSecretValues(Object.values(service.secrets)),
    cache: { get: async () => null, set: async () => undefined },
    fetch,
  });
  return { result, fetch };
};

describe("generic.http", () => {
  it("is up on 2xx/3xx", async () => {
    const { result } = await run(generic.http({ name: "Web", url: "https://x.test/" }), [{ url: "x.test", status: 200 }]);
    expect(result).toMatchObject({ key: "web", status: "up", httpStatus: 200 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("is degraded on 429 and down on other errors", async () => {
    expect((await run(generic.http({ name: "Web", url: "https://x.test/" }), [{ url: "x.test", status: 429 }])).result.status).toBe(
      "degraded"
    );
    const { result } = await run(generic.http({ name: "Web", url: "https://x.test/" }), [
      { url: "x.test", status: 502, body: "bad gateway" },
    ]);
    expect(result).toMatchObject({ status: "down", httpStatus: 502, error: "HTTP 502: bad gateway" });
  });

  it("is down on network errors", async () => {
    const { result } = await run(generic.http({ name: "Web", url: "https://x.test/" }), [
      { url: "x.test", error: Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }) },
    ]);
    expect(result).toMatchObject({ status: "down", error: "fetch failed: ENOTFOUND" });
  });

  it("is not configured without a URL, and makes no request", async () => {
    const { result, fetch } = await run(generic.http({ name: "Web", url: undefined }), []);
    expect(result.status).toBe("unconfigured");
    expect(fetch.calls).toHaveLength(0);
  });

  it("sends method, body and headers built from secrets, which are all required", async () => {
    const service = generic.http({
      name: "GraphQL",
      url: "https://x.test/graphql",
      method: "POST",
      body: '{"query":"{ __typename }"}',
      secrets: { token: "tok-123456" },
      headers: (secrets) => ({ Authorization: `Bearer ${secrets.token}`, "content-type": "application/json" }),
    });
    const { fetch } = await run(service, [{ url: "/graphql", body: { data: { __typename: "Query" } } }]);
    expect(fetch.calls[0]).toMatchObject({
      method: "POST",
      body: '{"query":"{ __typename }"}',
      headers: { authorization: "Bearer tok-123456", "content-type": "application/json" },
    });
    expect(generic.http({ name: "x", url: "https://x.test", secrets: { token: undefined } }).missing).toEqual([
      'secret "token"',
    ]);
  });

  it("only accepts the listed statuses when track.status is given", async () => {
    const service = generic.http({ name: "Tunnel", url: "https://x.test/", track: { status: [404] } });
    expect((await run(service, [{ url: "x.test", status: 404 }])).result.status).toBe("up");
    expect((await run(service, [{ url: "x.test", status: 200 }])).result).toMatchObject({
      status: "down",
      error: "HTTP 200 (expected 404)",
    });
  });

  it("refines a healthy answer with track.json", async () => {
    const service = generic.http({
      name: "GraphQL",
      url: "https://x.test/graphql",
      track: {
        json: (body) =>
          (body as { data?: unknown })?.data ? { status: "up", metrics: { ok: 1 } } : { status: "down", error: "No data" },
      },
    });
    expect((await run(service, [{ url: "/graphql", body: { data: {} } }])).result).toMatchObject({
      status: "up",
      httpStatus: 200,
      metrics: { ok: 1 },
    });
    expect((await run(service, [{ url: "/graphql", body: { errors: [] } }])).result).toMatchObject({
      status: "down",
      error: "No data",
    });
  });
});
