import { definePreset, type PresetOptions } from "../config";
import { normalizeReturn } from "../probe";
import type { CheckReturn, HttpResult, SecretsInput } from "../types";

export type GenericHttpOptions<Secrets extends SecretsInput = SecretsInput> = PresetOptions & {
  /** How to call it */
  name: string;
  /** The URL to call. When empty (e.g. an unset environment variable) the service is "not configured". */
  url: string | undefined;
  method?: string;
  /** Static headers, or a function of the secrets (e.g. to build an Authorization header) */
  headers?: Record<string, string> | ((secrets: { [K in keyof Secrets]-?: string }) => Record<string, string>);
  body?: string;
  /** Every secret given is required and redacted from public errors */
  secrets?: Secrets;
  track?: {
    /** Statuses that mean "up" (default: any 2xx/3xx) */
    status?: number[];
    /** Inspect the JSON body of a healthy answer to refine the outcome (metrics, usage, degraded…) */
    json?: (body: unknown, response: HttpResult) => CheckReturn;
  };
};

const SENSITIVE_HEADER = /auth|key|token|secret|cookie|password|signature|credential/i;

/** Credentials are often written straight into a header: redact them like declared secrets */
function sensitiveHeaderValues(headers: GenericHttpOptions["headers"]) {
  if (!headers || typeof headers === "function") return [];
  return Object.entries(headers)
    .filter(([name]) => SENSITIVE_HEADER.test(name))
    // "Bearer abc" → also "abc" alone, which is how an API would echo it
    .flatMap(([, value]) => [value, value.replace(/^\S+\s+/, "")]);
}

const preset = definePreset<GenericHttpOptions>()({
  kind: "generic.http",
  requiredFields: ["url"],
  requiredSecrets: "all",
  derive: (options) => ({
    name: options.name,
    description: `HTTP ${options.method ?? "GET"} request`,
  }),
  sensitive: (options) => sensitiveHeaderValues(options.headers),
  check: async ({ options, secrets, http }) => {
    const headers =
      typeof options.headers === "function"
        ? options.headers(secrets as Record<string, string>)
        : options.headers;
    const expected = options.track?.status;
    const response = await http(options.url as string, {
      method: options.method,
      headers,
      body: options.body,
      // With an explicit list, only those statuses are healthy
      okStatuses: expected,
    });

    if (expected && response.status !== undefined && !expected.includes(response.status)) {
      return {
        status: "down",
        latencyMs: response.latencyMs,
        httpStatus: response.status,
        error: `HTTP ${response.status} (expected ${expected.join(", ")})`,
      };
    }
    if (!response.ok) return response.outcome;
    if (!options.track?.json) return response.outcome;

    const refined = normalizeReturn(options.track.json(response.json, response));
    return { latencyMs: response.latencyMs, httpStatus: response.status, ...refined };
  },
});

/** Presets that work with any service */
export const generic = {
  /** Any HTTP endpoint: up on 2xx/3xx (or `track.status`), degraded on 429 or when slow, down otherwise */
  http: preset as <Secrets extends SecretsInput = Record<never, never>>(
    options: GenericHttpOptions<Secrets>
  ) => ReturnType<typeof preset>,
};
