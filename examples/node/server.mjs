// A complete status backend in one file: long-running Node server, in-process scheduler,
// in-memory history. Run with:  node examples/node/server.mjs
import http from "node:http";
import { custom, defineStatus, generic, group, startScheduler } from "sermon-js";
import { createStatusHandler, toNodeListener } from "sermon-js/api";

const status = defineStatus({
  interval: "1m",
  services: [
    group({
      title: "Public sites",
      description: "Plain HTTP checks",
      services: [
        generic.http({ name: "Example", url: "https://example.com", critical: true }),
        generic.http({ name: "Not configured yet", url: process.env.MISSING_URL }),
      ],
    }),
    custom({
      name: "Event loop",
      description: "Delay of a zero-millisecond timer",
      check: async () => {
        const start = performance.now();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return { status: "up", metrics: { lagMs: Math.round(performance.now() - start) } };
      },
    }),
  ],
});

// Checks run once per interval for as long as the process lives
startScheduler(status, { onError: console.error });

const port = Number(process.env.PORT ?? 3333);
http
  .createServer(toNodeListener(createStatusHandler(status, { secret: process.env.TICK_SECRET })))
  .listen(port, () => console.log(`Status API on http://localhost:${port}/api/status`));
