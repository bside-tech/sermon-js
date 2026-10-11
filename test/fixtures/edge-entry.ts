import { custom, defineStatus, generic, group } from "../../src";
import { createStatusHandler } from "../../src/api";
import { aws, fly, mongodb, redis, signGoogleAssertion, signPusherRequest, statuspage } from "../../src/presets";
import { upstashStore } from "../../src/stores/upstash";
import { runCheck } from "../../src/testing";

/** Bundled and evaluated inside a real edge sandbox by edge.test.ts */
export async function run() {
  const status = defineStatus({
    fetch: async () => new Response("{}", { status: 200 }),
    services: [
      group({
        title: "Services",
        services: [
          generic.http({ name: "Web", url: "https://x.test" }),
          custom({ name: "Thing", secrets: { key: "edge-secret-1" }, check: () => true }),
          custom({
            name: "Broken",
            check: () => {
              throw new Error("boom edge-secret-1");
            },
          }),
        ],
      }),
    ],
  });
  // The HTTP handler and the Upstash store are edge-safe too
  const handler = createStatusHandler(status, { secret: "tick-secret-1" });
  const tick = await handler(new Request("https://edge.test/api/tick", { headers: { authorization: "Bearer tick-secret-1" } }));
  const viaApi = (await (await handler(new Request("https://edge.test/api/status"))).json()) as { score: number };
  const kv = new Map<string, string>();
  const store = upstashStore({
    url: "https://db.upstash.test",
    token: "t",
    // Just enough of the REST pipeline for a lock: SET … NX PX
    fetch: async (_url, init) => {
      const commands = JSON.parse(String(init?.body)) as string[][];
      return Response.json(
        commands.map(([name, key = "", value = ""]) => {
          if (name === "SET") {
            if (kv.has(key)) return { result: null };
            kv.set(key, value);
            return { result: "OK" };
          }
          return { result: 1000 };
        })
      );
    },
  });
  const locks = [await store.lock!("x", 1000), await store.lock!("x", 1000)].map((lock) => lock.ok);

  // Presets, including the ones that sign with Web Crypto
  const page = await runCheck(statuspage({ url: "https://status.edge.test" }), {
    fetch: async () => Response.json({ status: { indicator: "minor", description: "Slow deploys" } }),
  });
  const flyApp = await runCheck(fly.app({ app: "edge-app", secrets: { token: "fly-token" } }), {
    fetch: async () => Response.json([{ id: "m1", state: "suspended", region: "ams" }]),
  });
  let s3Authorization = "";
  await runCheck(aws.s3Bucket({ bucket: "b", secrets: { accessKeyId: "AKIAEDGE", secretAccessKey: "edge-secret" } }), {
    fetch: async (_url, init) => {
      s3Authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(null, { status: 200 });
    },
  });
  // Database presets take a client, so nothing here needs a driver
  const mongo = await runCheck(mongodb.ping({ client: { db: () => ({ command: async () => ({ ok: 1 }) }) } }));
  const redisPing = await runCheck(redis.ping({ client: { ping: async () => "PONG" } }));
  const pusherUrl = await signPusherRequest({ appId: "1", key: "k", secret: "s", path: "/channels", timestamp: 1 });
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const assertion = await signGoogleAssertion({
    account: { client_email: "a@b", private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----` },
    scope: "s",
  });

  const report = await status.run({ trigger: "scheduled" });
  const snapshot = await status.snapshot();
  const history = await status.history();
  return JSON.stringify({
    score: report.score,
    statuses: report.results.map((result) => result.status),
    error: report.results[2]?.error,
    label: snapshot.label,
    bars: history.bars.length,
    tick: tick.status,
    viaApi: viaApi.score,
    locks,
    presets: {
      statuspage: page.status,
      fly: flyApp.status,
      mongodb: mongo.status,
      redis: redisPing.status,
      s3Signed: s3Authorization.startsWith("AWS4-HMAC-SHA256 Credential=AKIAEDGE/"),
      pusherSigned: /auth_signature=[0-9a-f]{64}$/.test(pusherUrl),
      googleJwtParts: assertion.split(".").length,
    },
    nodeGlobals: [typeof (globalThis as Record<string, unknown>).process, typeof (globalThis as Record<string, unknown>).Buffer],
  });
}
