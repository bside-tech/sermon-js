import type { CheckContext, CheckReturn, CommonOptions, SecretsInput } from "./types";

export const DEFAULT_SLOW_MS = 2000;
export const DEFAULT_TIMEOUT_MS = 10_000;

type AnyCheck = (ctx: CheckContext<SecretsInput>) => Promise<CheckReturn> | CheckReturn;

/** A service ready to be checked. Built by `custom()` or a preset; not meant to be written by hand. */
export type ServiceDefinition = {
  node: "service";
  /** The preset kind: "custom", "generic.http", "fly.app"… */
  kind: string;
  name: string;
  description?: string;
  critical: boolean;
  slowMs: number;
  timeoutMs: number;
  /** Natural identity (e.g. `fly.app:my-app`): keeps history across renames and moves */
  identity?: string;
  /**
   * Hidden from `console.log`, `JSON.stringify` and object spreads (the property is not
   * enumerable), so a logged or serialized configuration never prints credentials.
   */
  secrets: SecretsInput;
  /** Other values to redact from public text (e.g. credentials given as headers). Hidden like `secrets`. */
  sensitive?: string[];
  /** Required secrets/fields that are empty: the service is shown as "not configured" and never runs */
  missing: string[];
  check: AnyCheck;
};

export type GroupDefinition = {
  node: "group";
  title: string;
  description?: string;
  services: ServiceNode[];
};

export type ServiceNode = ServiceDefinition | GroupDefinition;

/** A titled set of services. Groups can contain other groups. */
export function group(options: { title: string; description?: string; services: ServiceNode[] }): GroupDefinition {
  if (!options.title?.trim()) throw new Error("sermon-js: group() needs a title");
  return {
    node: "group",
    title: options.title,
    description: options.description,
    services: options.services ?? [],
  };
}

/**
 * Keep credentials out of anything that prints or serializes a service: loggers, error
 * reporters and `util.inspect` only walk enumerable properties.
 */
export function hideSecrets<T extends { secrets: SecretsInput; sensitive?: string[] }>(
  service: T,
  { secrets, sensitive }: { secrets: SecretsInput; sensitive?: string[] }
): T {
  Object.defineProperty(service, "secrets", { value: secrets, enumerable: false, writable: false, configurable: true });
  Object.defineProperty(service, "sensitive", {
    value: sensitive ?? [],
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return service;
}

const isEmpty = (value: unknown) => value === undefined || value === null || value === "";

export type CustomOptions<Secrets extends SecretsInput> = CommonOptions & {
  /** How to call it (required for custom services) */
  name: string;
  /** Values the check needs. They're redacted from public errors; if one is empty the service is "not configured". */
  secrets?: Secrets;
  /** Set to false to list the service as "not configured" without running it */
  enabled?: boolean;
  /** Return `true`/nothing for up, `false` for down, or a full outcome. Throwing means down. */
  check: (ctx: CheckContext<Secrets>) => Promise<CheckReturn> | CheckReturn;
};

/** Any check you can write yourself: the escape hatch for services without a preset */
export function custom<Secrets extends SecretsInput = Record<never, never>>(
  options: CustomOptions<Secrets>
): ServiceDefinition {
  if (!options.name?.trim()) throw new Error("sermon-js: custom() needs a name");
  if (typeof options.check !== "function") {
    throw new Error(`sermon-js: custom service "${options.name}" needs a check function`);
  }
  const secrets = (options.secrets ?? {}) as SecretsInput;
  const missing = Object.keys(secrets)
    .filter((name) => isEmpty(secrets[name]))
    .map((name) => `secret "${name}"`);
  if (options.enabled === false) missing.push("disabled");
  const service: ServiceDefinition = {
    node: "service",
    kind: "custom",
    name: options.name,
    description: options.description,
    critical: options.critical ?? false,
    slowMs: options.slowMs ?? DEFAULT_SLOW_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    secrets,
    missing,
    check: options.check as AnyCheck,
  };
  return hideSecrets(service, { secrets });
}

/**
 * What every preset accepts on top of its own fields. Declare a preset's options as
 * `PresetOptions & { …fields; secrets: { … }; track?: { … } }`.
 */
export type PresetOptions = CommonOptions;

/** The shape a preset's options must fit (kept separate so `secrets` and `track` stay exact per preset) */
type PresetOptionsShape = CommonOptions & {
  secrets?: SecretsInput;
  track?: unknown;
};

type SecretsOf<O> = O extends { secrets?: infer S } ? (NonNullable<S> extends SecretsInput ? NonNullable<S> : never) : never;

/** Inside a preset's check: required secrets are strings, optional ones may be missing */
export type PresetContext<O extends PresetOptionsShape, Required extends string> = Omit<
  CheckContext<SecretsInput>,
  "secrets"
> & {
  // Keys are mapped through Extract so the type isn't homomorphic: `-?` would strip the `undefined` we add
  secrets: { [K in Extract<keyof SecretsOf<O>, string>]: K extends Required ? string : string | undefined };
  /** The options the user passed to the preset */
  options: O;
};

export type PresetSpec<O extends PresetOptionsShape, Required extends string> = {
  /** Namespaced kind, e.g. "fly.app" */
  kind: string;
  /** Secrets that must be non-empty for the service to run; "all" requires every secret given */
  requiredSecrets?: readonly Required[] | "all";
  /** Options that must be non-empty at runtime (e.g. a URL read from the environment) */
  requiredFields?: readonly (keyof O & string)[];
  defaults?: { slowMs?: number; timeoutMs?: number };
  /** Name, natural identity and description derived from the options */
  derive: (options: O) => { name: string; identity?: string; description?: string };
  /** Values outside `secrets` that must never show in public text (e.g. credentials in headers) */
  sensitive?: (options: O) => Array<string | undefined>;
  // NoInfer: the required set is inferred from `requiredSecrets` only, never from this parameter
  check: (ctx: PresetContext<O, NoInfer<Required>>) => Promise<CheckReturn> | CheckReturn;
};

/**
 * Build a preset: a typed function that turns a few options into a service.
 *
 * ```ts
 * type Options = PresetOptions & { app: string; secrets: { token: string | undefined } };
 * export const app = definePreset<Options>()({
 *   kind: "fly.app",
 *   requiredSecrets: ["token"],
 *   derive: (o) => ({ name: o.name ?? o.app, identity: `fly.app:${o.app}` }),
 *   check: ({ options, secrets, http }) => …,
 * });
 * ```
 */
export function definePreset<O extends PresetOptionsShape>() {
  return function <const Required extends keyof SecretsOf<O> & string = never>(
    spec: PresetSpec<O, Required>
  ): (options: O) => ServiceDefinition {
    return function preset(options: O): ServiceDefinition {
      const derived = spec.derive(options);
      const secrets = (options.secrets ?? {}) as SecretsInput;
      const missing = [
        ...(spec.requiredFields ?? [])
          .filter((field) => isEmpty(options[field]))
          .map((field) => `field "${field}"`),
        ...(spec.requiredSecrets === "all" ? Object.keys(secrets) : (spec.requiredSecrets ?? []))
          .filter((name) => isEmpty(secrets[name]))
          .map((name) => `secret "${name}"`),
      ];
      // A name derived from an empty field (e.g. an unset env var) falls back to the kind:
      // the service is still listed, as "not configured"
      const name = options.name?.trim() || derived.name?.trim() || spec.kind;
      const service: ServiceDefinition = {
        node: "service",
        kind: spec.kind,
        name,
        description: options.description ?? derived.description,
        critical: options.critical ?? false,
        slowMs: options.slowMs ?? spec.defaults?.slowMs ?? DEFAULT_SLOW_MS,
        timeoutMs: options.timeoutMs ?? spec.defaults?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        identity: derived.identity,
        secrets,
        missing,
        check: (ctx) => spec.check({ ...ctx, options } as unknown as PresetContext<O, Required>),
      };
      const sensitive = (spec.sensitive?.(options) ?? []).filter((value): value is string => !!value);
      return hideSecrets(service, { secrets, sensitive });
    };
  };
}

/** A service with its derived key */
export type ResolvedService = ServiceDefinition & { key: string };

export type ResolvedNode =
  | { type: "group"; key: string; title: string; description?: string; children: ResolvedNode[] }
  | { type: "service"; key: string };

export type ResolvedTree = {
  tree: ResolvedNode[];
  /** Every service by key, in declaration order */
  services: Map<string, ResolvedService>;
  warnings: string[];
};

function slug(text: string) {
  return (
    text
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

/** Identities keep their dots and colons (`fly.app:my-app`), everything else is slugged */
function identityKey(identity: string) {
  return (
    identity
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "x"
  );
}

function unique(base: string, taken: Set<string>) {
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
}

/**
 * Walk the services tree and give every group and service an internal key: unique, stable,
 * and safe in URLs. Services with a natural identity keep the same key wherever they sit;
 * the others are keyed by their group path and name.
 */
export function resolveTree(nodes: ServiceNode[]): ResolvedTree {
  const services = new Map<string, ResolvedService>();
  const serviceKeys = new Set<string>();
  const groupKeys = new Set<string>();
  const warnings: string[] = [];

  const walk = (list: ServiceNode[], path: string[]): ResolvedNode[] =>
    list.map((node) => {
      if (!node || typeof node !== "object" || !("node" in node)) {
        throw new Error("sermon-js: services must be built with group(), custom() or a preset function");
      }
      if (node.node === "group") {
        const segments = [...path, slug(node.title)];
        const key = unique(segments.join(":"), groupKeys);
        return {
          type: "group",
          key,
          title: node.title,
          description: node.description,
          children: walk(node.services, segments),
        };
      }
      const base = node.identity ? identityKey(node.identity) : [...path, slug(node.name)].join(":");
      const key = unique(base, serviceKeys);
      if (key !== base) {
        warnings.push(
          `Two services resolve to "${base}" (${node.kind} "${node.name}"): the second one is tracked as "${key}".`
        );
      }
      // The spread drops the hidden properties: put them back, still hidden
      services.set(key, hideSecrets({ ...node, key }, { secrets: node.secrets, sensitive: node.sensitive }));
      return { type: "service", key };
    });

  const tree = walk(nodes, []);
  return { tree, services, warnings };
}
