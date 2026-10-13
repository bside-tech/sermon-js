import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { StatusEngine } from "sermon-js";
import { defineConfig, type Plugin } from "vite";

/**
 * The example keeps history in memory, so a fresh start has an empty chart. Invent the last
 * three hours, with an incident in the middle, so there are bars to hover and click.
 */
async function seedHistory(status: StatusEngine) {
  const MINUTE = 60_000;
  const now = Date.now();
  const keys = [...status.services.values()].filter((service) => service.missing.length === 0).map((service) => service.key);
  for (let minutes = 180; minutes >= 5; minutes -= 5) {
    const at = now - minutes * MINUTE;
    const incident = minutes <= 95 && minutes >= 80;
    const samples = keys.map((key, index) => {
      const down = incident && index === 0;
      const slow = incident && index === 2;
      return {
        key,
        at,
        status: down ? ("down" as const) : slow ? ("degraded" as const) : ("up" as const),
        latencyMs: down ? undefined : slow ? 2600 : 90 + ((index * 37 + minutes) % 60),
        httpStatus: down ? 503 : undefined,
        error: down ? "HTTP 503: upstream unavailable" : slow ? "Slow response: 2600 ms (threshold 2000 ms)" : undefined,
      };
    });
    const failing = Object.fromEntries(samples.filter((s) => s.status !== "up").map((s) => [s.key, s.status]));
    await status.store.saveRun({
      summary: { at, trigger: "scheduled", full: true, score: incident ? 58 : 100, label: incident ? "outage" : "operational", failing },
      results: [],
      samples,
    });
  }
}

/** Dev only: serve the status API from the Vite dev server, with an in-process scheduler */
function statusApi(): Plugin {
  return {
    name: "status-api",
    apply: "serve",
    async configureServer(server) {
      const { startScheduler } = await import("sermon-js");
      const { createStatusHandler, toNodeListener } = await import("sermon-js/api");
      const { status } = await import("./status.config");
      await seedHistory(status);
      const scheduler = startScheduler(status, { onError: console.error });
      server.httpServer?.once("close", () => scheduler.stop());
      const listener = toNodeListener(createStatusHandler(status));
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        void listener(req, res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), statusApi()],
  server: { port: 3006 },
});
