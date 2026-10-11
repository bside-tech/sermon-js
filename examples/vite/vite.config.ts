import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** Dev only: serve the status API from the Vite dev server, with an in-process scheduler */
function statusApi(): Plugin {
  return {
    name: "status-api",
    apply: "serve",
    async configureServer(server) {
      const { startScheduler } = await import("sermon-js");
      const { createStatusHandler, toNodeListener } = await import("sermon-js/api");
      const { status } = await import("./status.config");
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
