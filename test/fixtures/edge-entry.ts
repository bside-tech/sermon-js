import { custom, defineStatus, generic, group } from "../../src";
import { createStatusHandler } from "../../src/api";
import { upstashStore } from "../../src/stores/upstash";

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
    nodeGlobals: [typeof (globalThis as Record<string, unknown>).process, typeof (globalThis as Record<string, unknown>).Buffer],
  });
}
