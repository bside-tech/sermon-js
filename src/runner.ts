import type { ResolvedService } from "./config";
import { combine, createHttp, errorMessage, measure, normalizeReturn } from "./probe";
import { redactText, sanitizeError } from "./sanitize";
import type { CheckCache, CheckContext, CheckOutcome, CheckResult, SecretsInput } from "./types";

/** Extra time after `timeoutMs` before a check that ignores its abort signal is given up on */
const GRACE_MS = 1000;

export type RunServiceOptions = {
  service: ResolvedService;
  /** Every secret value of the whole configuration, for redaction */
  secretValues: string[];
  cache: CheckCache;
  now?: () => number;
  fetch?: typeof fetch;
  /** Report failed HTTP answers by status code only */
  hideResponseBodies?: boolean;
};

/**
 * Run one service and apply the rules shared by all of them:
 * - missing required secrets/fields → "unconfigured", the check is never called
 * - a throw or a timeout → down
 * - latency above `slowMs` turns "up" into "degraded"
 * - errors and every other text of the result are redacted before they leave the runner
 */
export async function runService({
  service,
  secretValues,
  cache,
  now = () => Date.now(),
  fetch: fetchImpl,
  hideResponseBodies,
}: RunServiceOptions): Promise<CheckResult> {
  const checkedAt = now();
  if (service.missing.length > 0) {
    return { key: service.key, status: "unconfigured", checkedAt, probed: false };
  }

  const redact = (text: string) => redactText({ text, secretValues });
  const controller = new AbortController();
  const ctx: CheckContext<SecretsInput> = {
    secrets: service.secrets as Record<string, string>,
    http: createHttp({ timeoutMs: service.timeoutMs, signal: controller.signal, fetch: fetchImpl, redact, hideResponseBodies }),
    measure,
    combine,
    signal: controller.signal,
    timeoutMs: service.timeoutMs,
    slowMs: service.slowMs,
    cache,
    now: checkedAt,
  };

  const start = performance.now();
  let outcome: CheckOutcome;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const returned = await Promise.race([
      Promise.resolve().then(() => service.check(ctx)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new DOMException("Timed out", "TimeoutError"));
          reject(new DOMException("Timed out", "TimeoutError"));
        }, service.timeoutMs + GRACE_MS);
      }),
    ]);
    outcome = normalizeReturn(returned);
    if (outcome.latencyMs === undefined && outcome.probed !== false && outcome.status !== "sleeping") {
      // Checks that don't measure themselves get the wall time of the whole check
      outcome = { ...outcome, latencyMs: Math.round(performance.now() - start) };
    }
  } catch (error) {
    outcome = { status: "down", error: errorMessage(error) };
  } finally {
    clearTimeout(timer);
  }

  let { status, error } = outcome;
  if (status === "up" && outcome.latencyMs !== undefined && outcome.latencyMs > service.slowMs) {
    status = "degraded";
    error ??= `Slow response: ${outcome.latencyMs} ms (threshold ${service.slowMs} ms)`;
  }

  return {
    key: service.key,
    status,
    checkedAt,
    probed: outcome.probed ?? true,
    latencyMs: outcome.latencyMs,
    httpStatus: outcome.httpStatus,
    error: sanitizeError({ message: error, secretValues }),
    // Everything below is public too: no text leaves the runner without being redacted
    metrics: outcome.metrics
      ? Object.fromEntries(
          Object.entries(outcome.metrics).map(([name, value]) => [
            redact(name),
            typeof value === "string" ? redact(value) : value,
          ])
        )
      : undefined,
    usage: outcome.usage?.length
      ? outcome.usage.map((usage) => ({
          ...usage,
          label: redact(usage.label),
          unit: usage.unit === undefined ? undefined : redact(usage.unit),
        }))
      : undefined,
    instances: outcome.instances?.length
      ? outcome.instances.map((instance) => ({
          ...instance,
          key: redact(instance.key),
          region: instance.region === undefined ? undefined : redact(instance.region),
          id: instance.id === undefined ? undefined : redact(instance.id),
          state: instance.state === undefined ? undefined : redact(instance.state),
          error: sanitizeError({ message: instance.error, secretValues }),
        }))
      : undefined,
  };
}

export async function runServices({
  services,
  cacheFor,
  ...rest
}: Omit<RunServiceOptions, "service" | "cache"> & {
  services: ResolvedService[];
  /** Each service gets its own cache namespace */
  cacheFor: (key: string) => CheckCache;
}): Promise<CheckResult[]> {
  return Promise.all(
    services.map((service) => runService({ service, cache: cacheFor(service.key), ...rest }))
  );
}
