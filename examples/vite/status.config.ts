import { custom, defineStatus, generic, group } from "sermon-js";
import { statuspage } from "sermon-js/presets";

// Everything here runs without any key: public status pages, a plain HTTP check, and two
// custom checks that show what usage bars and per-region rows look like.
export const status = defineStatus({
  interval: "1m",
  services: [
    group({
      title: "Our services",
      description: "Things this example pretends to run",
      services: [
        generic.http({ name: "Website", url: "https://example.com", critical: true }),
        custom({
          name: "Edge fleet",
          description: "A custom check reporting each region on its own",
          check: () => ({
            status: "degraded",
            error: "1/3 machine(s) down: sin",
            latencyMs: 120,
            metrics: { machines: "2/3 running" },
            instances: [
              { key: "ams", region: "ams", id: "e2865023f13e86", state: "started", status: "up", latencyMs: 84, httpStatus: 200 },
              { key: "sin", region: "sin", id: "d89546ea616158", state: "stopped", status: "down", error: "Out of memory" },
              { key: "yyz", region: "yyz", id: "8365e2c6666738", state: "started", status: "up", latencyMs: 156, httpStatus: 200 },
            ],
          }),
        }),
        custom({
          name: "Job queue",
          description: "A custom check with a quota",
          check: () => ({
            status: "up",
            metrics: { workers: 4 },
            usage: [{ label: "Queue", used: 310, limit: 1000, unit: "jobs", resetsAt: Date.now() + 3 * 3600_000 }],
          }),
        }),
        generic.http({ name: "Not set up yet", url: process.env.MISSING_URL }),
      ],
    }),
    group({
      title: "Platforms",
      description: "Incidents reported by providers' own status pages",
      services: [
        group({
          title: "Hosting",
          services: [
            statuspage({ name: "Fly.io", url: "https://status.flyio.net" }),
            statuspage({ name: "Vercel", url: "https://www.vercel-status.com" }),
          ],
        }),
        group({
          title: "Developer tools",
          services: [statuspage({ name: "GitHub", url: "https://www.githubstatus.com" })],
        }),
      ],
    }),
  ],
});
