import { describe, expectTypeOf, it } from "vitest";
import { custom, definePreset, generic, group, type PresetOptions, type ServiceDefinition } from "../src";

type FlyOptions = PresetOptions & {
  app: string;
  secrets: { token: string | undefined; orgToken?: string };
  track?: { machines?: boolean; health?: string | false };
};

const flyApp = definePreset<FlyOptions>()({
  kind: "fly.app",
  requiredSecrets: ["token"],
  derive: (o) => ({ name: o.app }),
  check: ({ secrets, options }) => {
    // Required secrets are strings; optional ones may be missing
    expectTypeOf(secrets.token).toEqualTypeOf<string>();
    expectTypeOf(secrets.orgToken).toEqualTypeOf<string | undefined>();
    expectTypeOf(options.app).toEqualTypeOf<string>();
    return true;
  },
});

describe("types", () => {
  it("presets accept only their own fields, secrets and track options", () => {
    expectTypeOf(flyApp({ app: "x", secrets: { token: undefined } })).toEqualTypeOf<ServiceDefinition>();
    flyApp({ app: "x", secrets: { token: "t" }, track: { health: false }, critical: true });

    // @ts-expect-error `app` is required
    flyApp({ secrets: { token: "t" } });
    // @ts-expect-error unknown secret name
    flyApp({ app: "x", secrets: { token: "t", password: "p" } });
    // @ts-expect-error unknown track option
    flyApp({ app: "x", secrets: { token: "t" }, track: { regions: true } });
    // @ts-expect-error unknown field
    flyApp({ app: "x", secrets: { token: "t" }, zone: "eu" });
  });

  it("requiredSecrets must name secrets of the preset", () => {
    definePreset<FlyOptions>()({
      kind: "x",
      // @ts-expect-error "password" is not a secret of FlyOptions
      requiredSecrets: ["password"],
      derive: () => ({ name: "x" }),
      check: () => true,
    });
  });

  it("custom() types its secrets through to the check", () => {
    custom({
      name: "Queue",
      secrets: { apiKey: undefined as string | undefined },
      check: ({ secrets, http, measure, combine, signal, cache }) => {
        expectTypeOf(secrets.apiKey).toEqualTypeOf<string>();
        // @ts-expect-error not a secret of this service
        void secrets.other;
        expectTypeOf(http).toBeFunction();
        expectTypeOf(measure).toBeFunction();
        expectTypeOf(combine).toBeFunction();
        expectTypeOf(signal).toEqualTypeOf<AbortSignal>();
        expectTypeOf(cache.get).toBeFunction();
        return { status: "up" };
      },
    });
    // @ts-expect-error "broken" is not a status a check can return
    custom({ name: "x", check: () => ({ status: "broken" }) });
    // @ts-expect-error a check cannot declare itself unconfigured
    custom({ name: "x", check: () => ({ status: "unconfigured" }) });
  });

  it("generic.http types header secrets", () => {
    generic.http({
      name: "API",
      url: undefined,
      secrets: { token: "t" as string | undefined },
      headers: (secrets) => {
        expectTypeOf(secrets.token).toEqualTypeOf<string>();
        return {};
      },
    });
    // @ts-expect-error a name is required
    generic.http({ url: "https://x.test" });
  });

  it("groups hold services and other groups", () => {
    group({ title: "A", services: [group({ title: "B", services: [custom({ name: "x", check: () => true })] })] });
    // @ts-expect-error plain objects are not services
    group({ title: "A", services: [{ name: "x" }] });
  });
});
