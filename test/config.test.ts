import { describe, expect, it } from "vitest";
import { custom, definePreset, group, resolveTree, type PresetOptions } from "../src/config";
import { generic } from "../src/presets/generic";

type FlyOptions = PresetOptions & {
  app: string;
  secrets: { token: string | undefined; extra?: string };
  track?: { health?: string | false };
};

const flyApp = definePreset<FlyOptions>()({
  kind: "fly.app",
  requiredSecrets: ["token"],
  requiredFields: ["app"],
  defaults: { slowMs: 1500 },
  derive: (o) => ({ name: o.app, identity: `fly.app:${o.app}`, description: `Fly app "${o.app}"` }),
  check: async ({ options, secrets }) => ({
    status: "up",
    metrics: { app: options.app, token: secrets.token.length, health: String(options.track?.health ?? "/") },
  }),
});

describe("group / custom", () => {
  it("validates what it needs", () => {
    expect(() => group({ title: " ", services: [] })).toThrow(/needs a title/);
    expect(() => custom({ name: "", check: () => true })).toThrow(/needs a name/);
    expect(() => custom({ name: "x", check: undefined as never })).toThrow(/needs a check function/);
  });

  it("applies defaults and lists empty secrets as missing", () => {
    const service = custom({ name: "Queue", secrets: { apiKey: undefined, other: "set" }, check: () => true });
    expect(service).toMatchObject({ kind: "custom", critical: false, slowMs: 2000, timeoutMs: 10_000 });
    expect(service.missing).toEqual(['secret "apiKey"']);
    expect(custom({ name: "Off", enabled: false, check: () => true }).missing).toEqual(["disabled"]);
    expect(custom({ name: "On", check: () => true }).missing).toEqual([]);
  });
});

describe("definePreset", () => {
  it("derives name, identity and description, and lets options override them", () => {
    const derived = flyApp({ app: "l21-caption", secrets: { token: "t" } });
    expect(derived).toMatchObject({
      kind: "fly.app",
      name: "l21-caption",
      identity: "fly.app:l21-caption",
      description: 'Fly app "l21-caption"',
      slowMs: 1500,
      missing: [],
    });
    const named = flyApp({ app: "l21-caption", name: "Caption", critical: true, slowMs: 900, secrets: { token: "t" } });
    expect(named).toMatchObject({ name: "Caption", critical: true, slowMs: 900 });
  });

  it("reports missing required secrets and fields instead of throwing", () => {
    expect(flyApp({ app: "x", secrets: { token: undefined } }).missing).toEqual(['secret "token"']);
    const empty = flyApp({ app: "", secrets: { token: "" } });
    expect(empty.missing).toEqual(['field "app"', 'secret "token"']);
    expect(empty.name).toBe("fly.app");
    // Optional secrets don't block
    expect(flyApp({ app: "x", secrets: { token: "t", extra: undefined } }).missing).toEqual([]);
  });

  it("passes options and secrets to the check", async () => {
    const service = flyApp({ app: "x", secrets: { token: "abcd" }, track: { health: "/health" } });
    const outcome = await service.check({ secrets: service.secrets } as never);
    expect(outcome).toMatchObject({ metrics: { app: "x", token: 4, health: "/health" } });
  });
});

describe("resolveTree", () => {
  const tree = () =>
    resolveTree([
      group({
        title: "Our services",
        description: "Ours",
        services: [
          generic.http({ name: "Web app", url: "https://x.test" }),
          flyApp({ app: "l21-caption", name: "Caption", secrets: { token: "t" } }),
          group({ title: "Encoders", services: [custom({ name: "EU", check: () => true })] }),
        ],
      }),
      group({ title: "AI", services: [custom({ name: "Déjà Vu / 2", check: () => true })] }),
      custom({ name: "Queue depth", check: () => true }),
    ]);

  it("mirrors groups, nested groups and top-level services", () => {
    const { tree: nodes } = tree();
    expect(nodes).toEqual([
      {
        type: "group",
        key: "our-services",
        title: "Our services",
        description: "Ours",
        children: [
          { type: "service", key: "our-services:web-app" },
          { type: "service", key: "fly.app:l21-caption" },
          {
            type: "group",
            key: "our-services:encoders",
            title: "Encoders",
            description: undefined,
            children: [{ type: "service", key: "our-services:encoders:eu" }],
          },
        ],
      },
      {
        type: "group",
        key: "ai",
        title: "AI",
        description: undefined,
        children: [{ type: "service", key: "ai:deja-vu-2" }],
      },
      { type: "service", key: "queue-depth" },
    ]);
  });

  it("keeps declaration order and URL-safe keys", () => {
    const { services } = tree();
    expect([...services.keys()]).toEqual([
      "our-services:web-app",
      "fly.app:l21-caption",
      "our-services:encoders:eu",
      "ai:deja-vu-2",
      "queue-depth",
    ]);
    for (const key of services.keys()) expect(key).toMatch(/^[a-z0-9._:-]+$/);
  });

  it("keeps identity-based keys stable when a service is renamed or moved", () => {
    const moved = resolveTree([
      group({ title: "Elsewhere", services: [flyApp({ app: "l21-caption", name: "Renamed", secrets: { token: "t" } })] }),
    ]);
    expect([...moved.services.keys()]).toEqual(["fly.app:l21-caption"]);
  });

  it("suffixes duplicates and warns", () => {
    const { services, warnings } = resolveTree([
      custom({ name: "API", check: () => true }),
      custom({ name: "api", check: () => true }),
      flyApp({ app: "same", secrets: { token: "t" } }),
      flyApp({ app: "same", secrets: { token: "t" } }),
    ]);
    expect([...services.keys()]).toEqual(["api", "api-2", "fly.app:same", "fly.app:same-2"]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('"api-2"');
  });

  it("gives groups with the same title distinct keys", () => {
    const { tree: nodes } = resolveTree([group({ title: "A", services: [] }), group({ title: "A", services: [] })]);
    expect(nodes.map((node) => node.key)).toEqual(["a", "a-2"]);
  });

  it("rejects hand-written objects", () => {
    expect(() => resolveTree([{ name: "x" } as never])).toThrow(/group\(\), custom\(\) or a preset/);
  });
});
