import { beforeEach, describe, expect, it } from "vitest";
import {
  clearGoogleTokens,
  gcp,
  googleServiceAccountToken,
  googleTranslate,
  parseServiceAccount,
  signGoogleAssertion,
} from "../src/presets";
import { createHttp } from "../src/probe";
import { mockFetch, runCheck, type MockRoute } from "../src/testing";
import { decodeJwt, makeServiceAccount } from "./helpers/google-key";

beforeEach(() => clearGoogleTokens());

const tokenRoute: MockRoute = { url: "oauth2.googleapis.com/token", body: { access_token: "ya29.token-abc", expires_in: 3600 } };

describe("Google service-account auth", () => {
  it("signs a valid RS256 assertion with Web Crypto", async () => {
    const { account, publicKey } = await makeServiceAccount();
    const now = Date.UTC(2026, 9, 9, 12, 0);
    const jwt = decodeJwt(await signGoogleAssertion({ account, scope: "scope-a", now }));
    expect(jwt.header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(jwt.payload).toEqual({
      iss: account.client_email,
      scope: "scope-a",
      aud: "https://oauth2.googleapis.com/token",
      iat: now / 1000,
      exp: now / 1000 + 3600,
    });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, jwt.signature, jwt.signed)).toBe(true);
  });

  it("accepts keys pasted with escaped newlines", async () => {
    const { account, publicKey } = await makeServiceAccount({ escapedNewlines: true });
    const jwt = decodeJwt(await signGoogleAssertion({ account, scope: "s" }));
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, jwt.signature, jwt.signed)).toBe(true);
  });

  it("exchanges the assertion for a token and keeps it in memory until it nears expiry", async () => {
    const { account } = await makeServiceAccount();
    const fetch = mockFetch([tokenRoute]);
    const http = createHttp({ timeoutMs: 1000, fetch });
    const now = Date.UTC(2026, 9, 9, 12, 0);

    expect(await googleServiceAccountToken({ account, scope: "s", http, now })).toBe("ya29.token-abc");
    expect(await googleServiceAccountToken({ account, scope: "s", http, now: now + 50 * 60_000 })).toBe("ya29.token-abc");
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]).toMatchObject({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(fetch.calls[0]?.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=");
    // A different scope is a different token
    await googleServiceAccountToken({ account, scope: "other", http, now });
    expect(fetch.calls).toHaveLength(2);
    // Past its lifetime (minus a margin), a new token is requested
    await googleServiceAccountToken({ account, scope: "s", http, now: now + 56 * 60_000 });
    expect(fetch.calls).toHaveLength(3);
    // A rotated key of the same account doesn't reuse the old key's token
    const rotated = { ...account, private_key: (await makeServiceAccount()).account.private_key };
    await googleServiceAccountToken({ account: rotated, scope: "s", http, now });
    expect(fetch.calls).toHaveLength(4);
  });

  it("never writes tokens to the store's cache", async () => {
    const { json } = await makeServiceAccount();
    const cache = new Map<string, string>();
    await runCheck(googleTranslate({ secrets: { serviceAccount: json } }), {
      fetch: mockFetch([tokenRoute, { url: "/supportedLanguages", body: { languages: [] } }]),
      cache,
    });
    expect([...cache.keys()]).toEqual([]);
  });

  it("explains a rejected key", async () => {
    const { account } = await makeServiceAccount();
    const http = createHttp({
      timeoutMs: 1000,
      fetch: mockFetch([{ url: "oauth2", status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } }]),
    });
    await expect(googleServiceAccountToken({ account, scope: "s", http })).rejects.toThrow("Google auth failed: Invalid JWT Signature.");
  });

  it("recognises service-account JSON", () => {
    expect(parseServiceAccount(undefined)).toBeUndefined();
    expect(parseServiceAccount("AIzaSy-an-api-key")).toBeUndefined();
    expect(parseServiceAccount('{"type":"service_account"}')).toBeUndefined();
    expect(parseServiceAccount('{"client_email":"a@b","private_key":"k"}')).toEqual({ client_email: "a@b", private_key: "k" });
  });
});

describe("googleTranslate", () => {
  it("lists supported languages with a service-account token", async () => {
    const { json } = await makeServiceAccount();
    const fetch = mockFetch([tokenRoute, { url: "/supportedLanguages", body: { languages: Array.from({ length: 196 }, (_, i) => ({ languageCode: `l${i}` })) } }]);
    const result = await runCheck(googleTranslate({ secrets: { serviceAccount: json } }), { fetch });
    expect(result).toMatchObject({ status: "up", httpStatus: 200, metrics: { languages: 196 } });
    expect(fetch.calls[1]).toMatchObject({
      url: "https://translation.googleapis.com/v3/projects/line21-test/locations/global/supportedLanguages",
      headers: { authorization: "Bearer ya29.token-abc" },
    });
  });

  it("says so when the secret is not a service-account key", async () => {
    const fetch = mockFetch([]);
    const result = await runCheck(googleTranslate({ secrets: { serviceAccount: "AIzaSy-an-api-key" } }), { fetch });
    expect(result).toMatchObject({ status: "down", probed: false, error: "The service account secret is not a service-account JSON key" });
    expect(fetch.calls).toHaveLength(0);
  });

  it("is down when auth or the API fails, without leaking the key", async () => {
    const { json, account } = await makeServiceAccount();
    const rejected = await runCheck(googleTranslate({ secrets: { serviceAccount: json } }), {
      fetch: mockFetch([{ url: "oauth2", status: 400, body: { error_description: `Invalid grant for ${account.client_email}` } }]),
    });
    expect(rejected).toMatchObject({ status: "down", error: "Google auth failed: Invalid grant for ***" });
    const apiDown = await runCheck(googleTranslate({ secrets: { serviceAccount: json } }), {
      fetch: mockFetch([tokenRoute, { url: "/supportedLanguages", status: 403, body: "denied" }]),
    });
    expect(apiDown).toMatchObject({ status: "down", httpStatus: 403 });
  });
});

describe("gcp.instance", () => {
  const instanceRoute = (status: string, httpStatus = 200): MockRoute => ({
    url: "compute.googleapis.com",
    status: httpStatus,
    body: httpStatus === 200 ? { status } : { error: { message: "forbidden" } },
  });
  const make = async (track?: Parameters<typeof gcp.instance>[0]["track"]) => {
    const { json } = await makeServiceAccount();
    return gcp.instance({ instance: "norsk-eu", zone: "europe-west1-b", secrets: { serviceAccount: json }, track });
  };

  it("derives name and identity", async () => {
    expect(await make()).toMatchObject({ kind: "gcp.instance", name: "norsk-eu", slowMs: 1500, missing: [] });
    expect(gcp.instance({ instance: "vm", zone: "z", project: "p", secrets: { serviceAccount: "x" } }).identity).toBe("gcp.instance:p/z/vm");
    expect(gcp.instance({ instance: undefined, zone: "z", secrets: { serviceAccount: undefined } }).missing).toEqual([
      'field "instance"',
      'secret "serviceAccount"',
    ]);
  });

  it("reads the instance status with a read-only token", async () => {
    const fetch = mockFetch([tokenRoute, instanceRoute("RUNNING")]);
    const result = await runCheck(await make(), { fetch });
    expect(result).toMatchObject({ status: "up", metrics: { vm: "RUNNING", zone: "europe-west1-b" } });
    expect(fetch.calls[0]?.body).toContain("assertion=");
    expect(fetch.calls[1]).toMatchObject({
      url: "https://compute.googleapis.com/compute/v1/projects/line21-test/zones/europe-west1-b/instances/norsk-eu",
      headers: { authorization: "Bearer ya29.token-abc" },
    });
  });

  it("reports a stopped VM as sleeping and never probes it", async () => {
    for (const state of ["TERMINATED", "STOPPED", "SUSPENDED"]) {
      const fetch = mockFetch([tokenRoute, instanceRoute(state)]);
      const result = await runCheck(await make({ health: "http://eu1.video.test:8080/" }), { fetch });
      expect(result).toMatchObject({ status: "sleeping", probed: false, metrics: { vm: state } });
      expect(fetch.calls.map((call) => call.url).some((url) => url.includes("video.test"))).toBe(false);
    }
  });

  it("probes the health URL only while RUNNING, accepting any HTTP answer", async () => {
    const fetch = mockFetch([tokenRoute, instanceRoute("RUNNING"), { url: "video.test", status: 404 }]);
    const result = await runCheck(await make({ health: "http://eu1.video.test:8080/" }), { fetch });
    expect(result).toMatchObject({ status: "up", httpStatus: 404, probed: true, metrics: { vm: "RUNNING" } });
    const down = await runCheck(await make({ health: "http://eu1.video.test:8080/" }), {
      fetch: mockFetch([tokenRoute, instanceRoute("RUNNING"), { url: "video.test", error: new TypeError("fetch failed") }]),
    });
    expect(down.status).toBe("down");
  });

  it("is degraded while booting and down for unexpected states or API errors", async () => {
    expect(await runCheck(await make(), { fetch: mockFetch([tokenRoute, instanceRoute("STAGING")]) })).toMatchObject({
      status: "degraded",
      error: "VM is STAGING",
    });
    expect((await runCheck(await make(), { fetch: mockFetch([tokenRoute, instanceRoute("REPAIRING")]) })).status).toBe("down");
    const forbidden = await runCheck(await make(), { fetch: mockFetch([tokenRoute, instanceRoute("", 403)]) });
    expect(forbidden).toMatchObject({ status: "down", httpStatus: 403 });
    expect(forbidden.error).toContain("Compute API: HTTP 403");
    const noAuth = await runCheck(await make(), { fetch: mockFetch([{ url: "oauth2", status: 400, body: { error: "invalid_grant" } }]) });
    expect(noAuth).toMatchObject({ status: "down", error: "Google auth failed: invalid_grant" });
  });
});
