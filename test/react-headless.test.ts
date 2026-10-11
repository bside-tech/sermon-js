import { describe, expect, it } from "vitest";
import {
  buildLayout,
  createStatusClient,
  flattenServices,
  formatDuration,
  formatMs,
  formatPct,
  humanize,
  isStale,
  mergeBars,
  RateLimitError,
  sectionsOf,
  servicesOf,
  sortServices,
  statusOf,
} from "../src/react";
import type { HistoryBar, ServiceSnapshot, SnapshotNode, Status } from "../src";

const service = (name: string, status?: Status, extra: Partial<ServiceSnapshot> = {}): ServiceSnapshot => ({
  type: "service",
  key: name.toLowerCase(),
  kind: "custom",
  name,
  critical: false,
  slowMs: 2000,
  configured: status !== "unconfigured",
  result: status ? { key: name.toLowerCase(), status, checkedAt: 1, probed: true } : undefined,
  ...extra,
});
const group = (title: string, children: SnapshotNode[], description?: string): SnapshotNode => ({
  type: "group",
  key: title.toLowerCase().replace(/\s+/g, "-"),
  title,
  description,
  children,
});

describe("statusOf / sortServices", () => {
  it("shows unconfigured for services without configuration or result", () => {
    expect(statusOf(service("A", "up"))).toBe("up");
    expect(statusOf(service("A"))).toBe("unconfigured");
    expect(statusOf(service("A", "up", { configured: false }))).toBe("unconfigured");
  });

  it("puts failures first, then critical services, then names", () => {
    const sorted = sortServices([
      service("Zeta", "up"),
      service("Alpha", "up"),
      service("Crit", "up", { critical: true }),
      service("Slow", "degraded"),
      service("Dead", "down"),
      service("Nap", "sleeping"),
      service("Off", "unconfigured"),
    ]);
    expect(sorted.map((s) => s.name)).toEqual(["Dead", "Slow", "Crit", "Alpha", "Zeta", "Nap", "Off"]);
  });
});

describe("buildLayout", () => {
  const tree: SnapshotNode[] = [
    service("Loose one", "up"),
    group("Our services", [service("Web", "up"), group("Encoders", [service("EU", "sleeping")]), service("API", "down")], "Ours"),
    group("External providers", [group("AI", [service("OpenAI", "up")]), group("Email", [service("MailerSend", "up")])], "Third parties"),
    service("Loose two", "up"),
    service("Loose three", "degraded"),
  ];

  it("turns groups into sections, group-only groups into headings, and gathers loose services", () => {
    const blocks = buildLayout(tree, { ungroupedTitle: "Other" });
    expect(blocks.map((b) => (b.type === "section" ? `section:${b.section.title}` : `heading:${b.title}`))).toEqual([
      "section:Other",
      "section:Our services",
      "heading:External providers",
      "section:Other",
    ]);
    const [first, ours, external, last] = blocks;
    if (first?.type !== "section" || ours?.type !== "section" || external?.type !== "heading" || last?.type !== "section") {
      throw new Error("unexpected layout");
    }
    expect(first.section.key).toBe("ungrouped");
    expect(last.section.key).toBe("ungrouped-2");
    expect(last.section.services.map((s) => s.name)).toEqual(["Loose three", "Loose two"]);

    // Direct services are sorted; nested groups are kept
    expect(ours.section).toMatchObject({ description: "Ours" });
    expect(ours.section.services.map((s) => s.name)).toEqual(["API", "Web"]);
    expect(ours.section.groups.map((g) => g.title)).toEqual(["Encoders"]);
    expect(servicesOf(ours.section).map((s) => s.name)).toEqual(["API", "Web", "EU"]);

    expect(external).toMatchObject({ title: "External providers", description: "Third parties" });
    expect(external.sections.map((s) => s.title)).toEqual(["AI", "Email"]);
    expect(sectionsOf(blocks).map((s) => s.title)).toEqual(["Other", "Our services", "AI", "Email", "Other"]);
  });

  it("flattens every service in declaration order", () => {
    expect(flattenServices(tree).map((s) => s.name)).toEqual([
      "Loose one", "Web", "EU", "API", "OpenAI", "MailerSend", "Loose two", "Loose three",
    ]);
    expect(buildLayout([])).toEqual([]);
  });
});

describe("isStale", () => {
  it("is stale once the last run is older than twice the interval", () => {
    const intervalMs = 300_000;
    expect(isStale({ lastRunAt: null, intervalMs }, 1_000_000)).toBe(false);
    expect(isStale({ lastRunAt: 1_000_000 - 500_000, intervalMs }, 1_000_000)).toBe(false);
    expect(isStale({ lastRunAt: 1_000_000 - 700_000, intervalMs }, 1_000_000)).toBe(true);
  });
});

describe("mergeBars", () => {
  const bar = (start: number, score: number | null, failing: HistoryBar["failing"] = {}): HistoryBar => ({
    start,
    score,
    label: score === null ? "unknown" : score >= 98 ? "operational" : score >= 85 ? "degraded" : "outage",
    runs: score === null ? 0 : 1,
    failing,
  });

  it("leaves bars alone when they fit", () => {
    const bars = [bar(0, 100), bar(1, 90)];
    expect(mergeBars(bars, 10)).toEqual({ bars, factor: 1 });
    expect(mergeBars(bars, Infinity).factor).toBe(1);
  });

  it("merges neighbours, keeping the worst score, label and failures", () => {
    const bars = [bar(0, null), bar(1, 100), bar(2, 70, { api: "degraded" }), bar(3, 90, { api: "down", web: "degraded" }), bar(4, 100)];
    const merged = mergeBars(bars, 3);
    expect(merged.factor).toBe(2);
    // Grouped from the end: [0] [1,2] [3,4]
    expect(merged.bars).toEqual([
      { start: 0, score: null, label: "unknown", runs: 0, failing: {} },
      { start: 1, score: 70, label: "outage", runs: 2, failing: { api: "degraded" } },
      { start: 3, score: 90, label: "degraded", runs: 2, failing: { api: "down", web: "degraded" } },
    ]);
  });

  it("fits 288 bars into a phone-width chart", () => {
    const bars = Array.from({ length: 288 }, (_, i) => bar(i, 100));
    const merged = mergeBars(bars, 100);
    expect(merged.factor).toBe(3);
    expect(merged.bars).toHaveLength(96);
    expect(merged.bars.at(-1)).toMatchObject({ start: 285, runs: 3 });
  });
});

describe("createStatusClient", () => {
  const record = (response: Response) => {
    const calls: Array<{ url: string; method: string }> = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      return response.clone();
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  };

  it("calls the handler's routes under the base URL", async () => {
    const { fetch, calls } = record(Response.json({ ok: true }));
    const client = createStatusClient({ baseUrl: "https://status.test/api/", fetch });
    await client.status();
    await client.history("7d");
    await client.serviceHistory("fly.app:my-app", "24h");
    await client.run();
    await client.run("our-services:web");
    expect(calls).toEqual([
      { url: "https://status.test/api/status", method: "GET" },
      { url: "https://status.test/api/history?range=7d", method: "GET" },
      { url: "https://status.test/api/services/fly.app%3Amy-app/history?range=24h", method: "GET" },
      { url: "https://status.test/api/run", method: "POST" },
      { url: "https://status.test/api/run/our-services%3Aweb", method: "POST" },
    ]);
  });

  it("turns a refused run into a RateLimitError", async () => {
    const { fetch } = record(Response.json({ retryAfter: 42 }, { status: 429 }));
    const error = await createStatusClient({ fetch }).run().catch((e) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfter).toBe(42);

    const fromHeader = record(new Response("slow down", { status: 429, headers: { "retry-after": "7" } }));
    expect(((await createStatusClient({ fetch: fromHeader.fetch }).run().catch((e) => e)) as RateLimitError).retryAfter).toBe(7);
  });

  it("throws on other failures", async () => {
    const { fetch } = record(new Response("nope", { status: 500 }));
    await expect(createStatusClient({ fetch }).status()).rejects.toThrow("Request failed (500)");
  });
});

describe("format", () => {
  it("formats values for display", () => {
    expect(formatMs(undefined)).toBe("–");
    expect(formatMs(250)).toBe("250 ms");
    expect(formatMs(2500)).toBe("2.5 s");
    expect(formatPct(100)).toBe("100%");
    expect(formatPct(99.5)).toBe("99.50%");
    expect(formatPct(null)).toBe("–");
    expect(formatDuration(300_000)).toBe("5 minutes");
    expect(formatDuration(3_600_000)).toBe("1 hour");
    expect(formatDuration(7 * 86_400_000)).toBe("7 days");
    expect(humanize("quotaUsed")).toBe("Quota used");
  });
});
