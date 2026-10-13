// @vitest-environment happy-dom
import { QueryClient } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { custom, defineStatus, generic, group } from "../src";
import { createStatusHandler } from "../src/api";
import { createStatusClient } from "../src/react";
import { StatusPage } from "../src/react/heroui";
import { mockFetch } from "../src/testing";

beforeAll(() => {
  // The simulated browser lacks a few APIs the components (and HeroUI) touch
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal("IntersectionObserver", Observer);
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
    onchange: null,
  })) as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => undefined;
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  history.replaceState(null, "", "/");
});

/** A real engine and handler; the page talks to it through the client */
async function setup({
  ranAgoMs = 0,
  recovered = false,
}: {
  ranAgoMs?: number;
  /** Run a second time now, with the API back up */
  recovered?: boolean;
} = {}) {
  let now = Date.now() - ranAgoMs;
  const state = { apiUp: false };
  const status = defineStatus({
    now: () => now,
    fetch: mockFetch([{ url: "web.test", status: 200 }]),
    services: [
      group({
        title: "Our services",
        description: "Things we run",
        services: [
          generic.http({ name: "Web app", url: "https://web.test", critical: true }),
          custom({ name: "API", critical: true, check: () => (state.apiUp ? true : { status: "down", error: "HTTP 500: boom" }) }),
          group({
            title: "Regions",
            services: [
              custom({
                name: "Edge",
                check: () => ({
                  status: "sleeping",
                  probed: false,
                  metrics: { machines: "0/2 running" },
                  instances: [
                    { key: "ams", region: "ams", id: "machine-ams-1", state: "suspended", status: "sleeping" },
                    { key: "sin", region: "sin", id: "machine-sin-1", state: "stopped", status: "sleeping" },
                  ],
                }),
              }),
            ],
          }),
        ],
      }),
      group({
        title: "External providers",
        description: "Third parties",
        services: [
          group({
            title: "Email",
            services: [
              custom({
                name: "Mailer",
                check: () => ({ status: "up", usage: [{ label: "API requests", used: 15, limit: 100, unit: "requests" }] }),
              }),
            ],
          }),
        ],
      }),
      custom({ name: "Billing", secrets: { apiKey: undefined }, check: () => true }),
    ],
  });
  await status.run({ trigger: "scheduled" });
  now = Date.now();
  if (recovered) {
    state.apiUp = true;
    await status.run({ trigger: "scheduled" });
  }

  const handler = createStatusHandler(status, { cache: false });
  const client = createStatusClient({
    baseUrl: "https://status.test/api",
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(input), init))) as typeof fetch,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<StatusPage client={client} queryClient={queryClient} brand={<h1>Acme Status</h1>} defaultExpanded />);
  await screen.findByText(recovered ? "All systems operational" : "Major outage");
  return { ...view, status, state };
}

describe("<StatusPage>", () => {
  it("shows the score, the label and the counts", async () => {
    await setup();
    expect(screen.getByText("Acme Status")).toBeTruthy();
    // web up (w3) + api down (w3) + edge sleeping (w1) + mailer up (w1) → 5/8 = 63
    expect(screen.getByText("63")).toBeTruthy();
    expect(screen.getByText("2 operational")).toBeTruthy();
    expect(screen.getByText("1 down")).toBeTruthy();
    expect(screen.getByText("1 asleep (expected)")).toBeTruthy();
    expect(screen.getByText("1 not configured")).toBeTruthy();
    expect(screen.getByText(/checks run every 5 minutes/)).toBeTruthy();
    expect(screen.getByText(/history kept for 7 days/)).toBeTruthy();
  });

  it("mirrors the configured tree: sections, nested groups, headings and loose services", async () => {
    await setup();
    // A group with services is a section; its nested group is a sub-heading inside it
    const ours = document.getElementById("group-our-services")!;
    expect(within(ours).getByText("Things we run")).toBeTruthy();
    expect(within(ours).getByText("Regions")).toBeTruthy();
    expect(within(ours).getByText("Edge")).toBeTruthy();
    // A group holding only groups is a heading, followed by one section per group
    expect(screen.getByRole("heading", { name: "External providers" })).toBeTruthy();
    expect(document.getElementById("group-external-providers:email")).toBeTruthy();
    // Services outside any group are gathered in their own section
    expect(within(document.getElementById("group-ungrouped")!).getByText("Billing")).toBeTruthy();
  });

  it("puts failing services first and shows their error", async () => {
    await setup();
    const ours = document.getElementById("group-our-services")!;
    const names = [...ours.querySelectorAll('[id^="service-"]')].map((row) => row.id);
    expect(names.slice(0, 2)).toEqual(["service-our-services:api", "service-our-services:web-app"]);
    const api = document.getElementById("service-our-services:api")!;
    expect(within(api).getByText("Down")).toBeTruthy();
    expect(within(api).getByText("critical")).toBeTruthy();
    expect(within(api).getByText("HTTP 500: boom")).toBeTruthy();
  });

  it("shows per-instance rows, usage bars, metrics and missing configuration", async () => {
    await setup();
    const edge = document.getElementById("service-our-services:regions:edge")!;
    expect(within(edge).getByText("not probed")).toBeTruthy();
    expect(within(edge).getByText("Amsterdam")).toBeTruthy();
    expect(within(edge).getByText("Singapore")).toBeTruthy();
    // One row per machine: short ID and state
    expect(within(edge).getAllByText(/^machine- · (suspended|stopped)$/)).toHaveLength(2);
    expect(within(edge).getByText("Machines: 0/2 running")).toBeTruthy();

    const mailer = document.getElementById("service-external-providers:email:mailer")!;
    expect(within(mailer).getByText("API requests")).toBeTruthy();
    expect(within(mailer).getByText(/15 \/ 100 requests · 15%/)).toBeTruthy();

    const billing = document.getElementById("service-billing")!;
    expect(within(billing).getByText("Not configured")).toBeTruthy();
    expect(within(billing).getByText('Missing: secret "apiKey"')).toBeTruthy();
    expect((within(billing).getByRole("button", { name: "Check Billing now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists every service in the side index with its status", async () => {
    await setup();
    const nav = screen.getByRole("navigation", { name: "Tracked services" });
    expect(within(nav).getByRole("link", { name: "API: Down" }).getAttribute("href")).toBe("#service-our-services%3Aapi");
    expect(within(nav).getByRole("link", { name: "Edge: Asleep (expected)" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Mailer: Operational" })).toBeTruthy();
    expect(within(nav).getByText("External providers")).toBeTruthy();
  });

  it("re-checks one service on demand and updates the page", async () => {
    const { state } = await setup();
    state.apiUp = true;
    fireEvent.click(screen.getByRole("button", { name: "Check API now" }));
    await screen.findByText("All systems operational");
    expect(within(document.getElementById("service-our-services:api")!).getByText("Operational")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
  });

  it("runs everything on demand, and reports the rate limit on a second try", async () => {
    const { state } = await setup();
    state.apiUp = true;
    fireEvent.click(screen.getByRole("button", { name: /Run all checks/ }));
    await screen.findByText("All systems operational");
    fireEvent.click(screen.getByRole("button", { name: /Run all checks/ }));
    await screen.findByText(/Try again in \d+s/);
  });

  it("remembers collapsed sections per viewer", async () => {
    await setup();
    expect(screen.getByRole("button", { name: "Collapse Our services" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Our services" }));
    await screen.findByRole("button", { name: "Expand Our services" });
    expect(localStorage.getItem("sermon:section:our-services")).toBe("collapsed");
  });

  it("opens the right section when the URL hash points at a service", async () => {
    await setup();
    fireEvent.click(screen.getByRole("button", { name: "Collapse Our services" }));
    await screen.findByRole("button", { name: "Expand Our services" });

    // A link that only changes the hash on the open page (or back/forward)
    history.replaceState(null, "", "#service-our-services%3Aapi");
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await screen.findByRole("button", { name: "Collapse Our services" });

    // And the side index does the same
    fireEvent.click(screen.getByRole("button", { name: "Collapse Our services" }));
    await screen.findByRole("button", { name: "Expand Our services" });
    fireEvent.click(within(screen.getByRole("navigation", { name: "Tracked services" })).getByRole("link", { name: "Edge: Asleep (expected)" }));
    await screen.findByRole("button", { name: "Collapse Our services" });
    expect(decodeURIComponent(location.hash)).toBe("#service-our-services:regions:edge");
  });

  it("starts collapsed by default", async () => {
    localStorage.clear();
    const status = defineStatus({ services: [group({ title: "G", services: [custom({ name: "A", check: () => true })] })] });
    await status.run();
    const handler = createStatusHandler(status, { cache: false });
    const client = createStatusClient({
      baseUrl: "https://s.test/api",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(input), init))) as typeof fetch,
    });
    render(<StatusPage client={client} queryClient={new QueryClient()} />);
    await screen.findByRole("button", { name: "Expand G" });
    // Without a brand, a plain title is shown
    expect(screen.getByRole("heading", { name: "Status" })).toBeTruthy();
  });

  it("warns when the data is stale", async () => {
    await setup({ ranAgoMs: 20 * 60_000 });
    expect(screen.getByRole("status").textContent).toMatch(/out of date: the last full check ran 20 minutes ago.*every 5 minutes/);
  });

  it("does not warn when the data is fresh", async () => {
    await setup();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("can hide on-demand runs, the index and the theme switch", async () => {
    const status = defineStatus({ services: [custom({ name: "A", check: () => true })] });
    await status.run();
    const handler = createStatusHandler(status, { cache: false });
    const client = createStatusClient({
      baseUrl: "https://s.test/api",
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(String(input), init))) as typeof fetch,
    });
    render(
      <StatusPage client={client} queryClient={new QueryClient()} allowRuns={false} showNav={false} showThemeSwitcher={false} defaultExpanded footer="Custom footer" />
    );
    await screen.findByText("All systems operational");
    expect(screen.queryByRole("button", { name: /Run all checks/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check A now" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Tracked services" })).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Color theme" })).toBeNull();
    expect(screen.getByText("Custom footer")).toBeTruthy();
  });

  it("switches theme and remembers the choice", async () => {
    await setup();
    fireEvent.click(screen.getByRole("radio", { name: "Dark theme" }));
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("sermon:theme")).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "System theme" }));
    await waitFor(() => expect(localStorage.getItem("sermon:theme")).toBeNull());
  });

  it("shows an error when the API can't be reached", async () => {
    const client = createStatusClient({ fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch });
    render(<StatusPage client={client} queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })} />);
    await screen.findByText("Could not load status: Request failed (500)");
  });

  it("shows the whole page as it was when a history bar is clicked", async () => {
    await setup({ ranAgoMs: 60 * 60_000, recovered: true });
    const api = () => document.getElementById("service-our-services:api")!;
    expect(within(api()).getByText("Operational")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Run all checks/ })).toBeTruthy();

    // Two bars hold a run: an hour ago (the outage) and now
    const bars = await screen.findAllByRole("button", { name: /Show the page at this time/ });
    expect(bars).toHaveLength(2);
    fireEvent.click(bars[0]!);

    await screen.findByText("Major outage");
    expect(bars[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(/^Showing /)).toBeTruthy();
    expect(screen.getByText(/1 run\(s\) between/)).toBeTruthy();
    expect(within(api()).getByText("Down")).toBeTruthy();
    expect(within(api()).getByText("HTTP 500: boom")).toBeTruthy();
    // The past can't be re-run, and statistics and usage belong to the present
    expect(screen.queryByRole("button", { name: /Run all checks/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Check API now/ })).toBeNull();
    expect(within(api()).queryByText("Uptime 24h")).toBeNull();
    expect(screen.queryByText("API requests")).toBeNull();
    // Per-instance statuses were recorded, with the names known today
    const edge = document.getElementById("service-our-services:regions:edge")!;
    expect(within(edge).getByText("ams")).toBeTruthy();
    expect(within(edge).getByText("Amsterdam")).toBeTruthy();
    // A service that wasn't checked then
    expect(within(document.getElementById("service-billing")!).getByText("No data")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Back to live" }));
    await screen.findByText("All systems operational");
    expect(within(api()).getByText("Operational")).toBeTruthy();
    expect(screen.queryByText(/^Showing /)).toBeNull();
    expect(screen.getByRole("button", { name: /Run all checks/ })).toBeTruthy();

    // Clicking the selected bar again also returns to live
    fireEvent.click(bars[0]!);
    await screen.findByText("Major outage");
    fireEvent.click(bars[0]!);
    await screen.findByText("All systems operational");
  });

  it("opens the sections that had a failing service when looking at the past", async () => {
    cleanup();
    localStorage.setItem("sermon:section:our-services", "collapsed");
    await setup({ ranAgoMs: 60 * 60_000, recovered: true });
    const section = document.getElementById("group-our-services")!;
    const toggle = () => within(section).getByRole("button", { name: /(Expand|Collapse) Our services/ });
    expect(toggle().getAttribute("aria-expanded")).toBe("false");

    fireEvent.click((await screen.findAllByRole("button", { name: /Show the page at this time/ }))[0]!);
    await screen.findByText("Major outage");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    // The viewer's own choice is untouched
    expect(localStorage.getItem("sermon:section:our-services")).toBe("collapsed");
    fireEvent.click(screen.getByRole("button", { name: "Back to live" }));
    await screen.findByText("All systems operational");
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
  });
});
