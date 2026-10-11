import { toMs, type Duration } from "../duration";
import { RANGES } from "../history";
import type { Status } from "../status";
import type { HistoryRange } from "../types";

export type HandlerContext = {
  /** Keeps the platform alive for background work after the response (Workers, Vercel, Netlify…) */
  waitUntil?: (promise: Promise<unknown>) => void;
};

export type StatusHandlerOptions = {
  /** Where the routes are mounted (default "/api"). The handler ignores anything before it. */
  basePath?: string;
  /**
   * Protects `/tick`. When set, callers must send it as `Authorization: Bearer <secret>`,
   * `x-sermon-secret: <secret>` or `?key=<secret>`. Without a secret, `/tick` is public but
   * harmless: it only runs when a run is due.
   */
  secret?: string;
  /** Minimum time between public on-demand runs */
  rateLimits?: {
    /** Full runs (default "60s") */
    runAll?: Duration;
    /** Single-service runs, per service (default "20s") */
    runOne?: Duration;
  };
  /**
   * When `/status` is read and the data is stale, start a `tick()`. With a `waitUntil` the
   * response isn't delayed; without one the handler waits for the run (up to `refreshBudget`).
   * Keeps a page fresh without any scheduler, as long as someone visits it.
   */
  refreshOnRead?: boolean;
  /** How long a read may wait for a refresh when there is no `waitUntil` (default "8s") */
  refreshBudget?: Duration;
  waitUntil?: HandlerContext["waitUntil"];
  /**
   * Shared-cache lifetimes in seconds for CDNs and edges (default `{ status: 10, history: 30 }`).
   * Browsers are always told to revalidate. Pass `false` to disable shared caching.
   */
  cache?: { status?: number; history?: number } | false;
  /** Allow other origins to call the API: `true` for any, or one origin (default: same-origin only) */
  cors?: boolean | string;
  /**
   * Receives unexpected failures (e.g. the store is unreachable). `message` has every configured
   * secret and credential-shaped value removed; `error` is the raw value, which may contain
   * connection strings: don't print it. Default: `console.error` of `message` only.
   */
  onError?: (failure: { message: string; error: unknown }) => void;
};

export type StatusHandler = (request: Request, context?: HandlerContext) => Promise<Response>;

const RUN_ALL_LOCK = "sermon:run:all";

function parseRange(value: string | null): HistoryRange {
  return value && value in RANGES ? (value as HistoryRange) : "24h";
}

/** Constant-time comparison, so the secret can't be guessed byte by byte from response times */
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function presentedSecret(request: Request, url: URL) {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  return request.headers.get("x-sermon-secret") ?? url.searchParams.get("key") ?? undefined;
}

/**
 * Expose a status engine over HTTP. The result is a standard `(Request) => Response` function:
 * mount it in Next.js, Hono, Bun, Deno, Cloudflare Workers, Netlify or Vercel functions, or wrap
 * it with `toNodeListener` for plain Node servers.
 *
 * Routes (under `basePath`):
 * - `GET  /status`                 snapshot: tree, latest results, statistics, score
 * - `GET  /history?range=24h|7d`   score history
 * - `GET  /services/:key/history`  samples of one service
 * - `POST /run`                    run everything now (rate limited)
 * - `POST /run/:key`               run one service now (rate limited)
 * - `GET|POST /tick`               run everything if due (for schedulers); `?force=1` with the secret
 */
/** An error as loggable text: name, message, causes and stack frames */
function describeError(error: unknown) {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.stack ?? `${error.name}: ${error.message}`];
  let cause = (error as Error & { cause?: unknown }).cause;
  for (let depth = 0; cause && depth < 3; depth++) {
    parts.push(`Caused by: ${cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause)}`);
    cause = cause instanceof Error ? (cause as Error & { cause?: unknown }).cause : undefined;
  }
  return parts.join("\n");
}

export function createStatusHandler(status: Status, options: StatusHandlerOptions = {}): StatusHandler {
  const basePath = `/${(options.basePath ?? "/api").replace(/^\/+|\/+$/g, "")}`.replace(/^\/$/, "");
  const runAllMs = toMs(options.rateLimits?.runAll ?? "60s");
  const runOneMs = toMs(options.rateLimits?.runOne ?? "20s");
  const refreshBudgetMs = toMs(options.refreshBudget ?? "8s");
  const cache = options.cache === false ? undefined : { status: 10, history: 30, ...options.cache };

  const corsHeaders = (request: Request): Record<string, string> => {
    if (!options.cors) return {};
    const origin = options.cors === true ? (request.headers.get("origin") ?? "*") : options.cors;
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-sermon-secret",
      vary: "origin",
    };
  };

  const json = (request: Request, body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) =>
    new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...corsHeaders(request),
        ...init.headers,
      },
    });

  /** Short shared cache for CDNs only: browsers must always revalidate, or they show stale results */
  const cached = (seconds: number | undefined): Record<string, string> =>
    seconds
      ? {
          "cache-control": "no-cache",
          "cdn-cache-control": `max-age=${seconds}, stale-while-revalidate=${seconds * 3}`,
        }
      : {};

  const tooSoon = (request: Request, message: string, retryAfterMs: number) => {
    const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return json(request, { error: message, retryAfter }, { status: 429, headers: { "retry-after": String(retryAfter) } });
  };

  async function refreshIfStale(context: HandlerContext | undefined) {
    const last = await status.lastFullRun();
    if (last && Date.now() < last.at + status.intervalMs) return;
    const tick = status.tick().catch(() => undefined);
    const waitUntil = context?.waitUntil ?? options.waitUntil;
    if (waitUntil) {
      waitUntil(tick);
      return;
    }
    await Promise.race([tick, new Promise((resolve) => setTimeout(resolve, refreshBudgetMs))]);
  }

  return async function handle(request, context) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (basePath && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return json(request, { error: "Not found" }, { status: 404 });
    }
    if (method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });

    let segments: string[];
    try {
      segments = url.pathname
        .slice(basePath.length)
        .split("/")
        .filter(Boolean)
        .map((segment) => decodeURIComponent(segment));
    } catch {
      return json(request, { error: "Not found" }, { status: 404 });
    }
    const [first, second, third] = segments;

    try {
      if (method === "GET" && first === "status" && segments.length === 1) {
        if (options.refreshOnRead) await refreshIfStale(context);
        return json(request, await status.snapshot(), { headers: cached(cache?.status) });
      }

      if (method === "GET" && first === "history" && segments.length === 1) {
        const range = parseRange(url.searchParams.get("range"));
        return json(request, await status.history({ range }), { headers: cached(cache?.history) });
      }

      if (method === "GET" && first === "services" && second && third === "history" && segments.length === 3) {
        if (!status.has(second)) return json(request, { error: "Unknown service" }, { status: 404 });
        const range = parseRange(url.searchParams.get("range"));
        return json(request, await status.serviceHistory(second, { range }), { headers: cached(cache?.history) });
      }

      if (method === "POST" && first === "run" && segments.length === 1) {
        const lock = await status.lock(RUN_ALL_LOCK, runAllMs);
        if (!lock.ok) return tooSoon(request, "A full run happened recently", lock.retryAfterMs);
        await status.run({ trigger: "manual" });
        return json(request, await status.snapshot());
      }

      if (method === "POST" && first === "run" && second && segments.length === 2) {
        if (!status.has(second)) return json(request, { error: "Unknown service" }, { status: 404 });
        const lock = await status.lock(`sermon:run:${second}`, runOneMs);
        if (!lock.ok) return tooSoon(request, "This service was checked recently", lock.retryAfterMs);
        await status.run({ keys: [second], trigger: "manual" });
        return json(request, await status.snapshot());
      }

      // "/cron" is kept as an alias for schedulers configured before "/tick" existed
      if ((method === "GET" || method === "POST") && (first === "tick" || first === "cron") && segments.length === 1) {
        const presented = presentedSecret(request, url);
        const authorized = !!options.secret && !!presented && safeEqual(presented, options.secret);
        if (options.secret && !authorized) return json(request, { error: "Unauthorized" }, { status: 401 });

        // Forcing a run is only for callers that hold the secret
        const force = authorized && ["1", "true"].includes(url.searchParams.get("force") ?? "");
        const result = await status.tick({ force });
        if (!result.ran) return json(request, result);
        // A scheduled run also counts for the public rate limit
        await status.lock(RUN_ALL_LOCK, runAllMs);
        return json(request, {
          ran: true,
          at: result.report.at,
          score: result.report.score,
          label: result.report.label,
          statuses: Object.fromEntries(result.report.results.map((r) => [r.key, r.status])),
        });
      }

      return json(request, { error: "Not found" }, { status: 404 });
    } catch (error) {
      // Never log the raw error: driver and store errors can carry connection strings
      const message = status.redact(describeError(error));
      if (options.onError) options.onError({ message, error });
      else console.error(`[sermon-js] ${message}`);
      return json(request, { error: "Internal error" }, { status: 500 });
    }
  };
}

type NodeRequest = {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
};

type NodeResponse = {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
};

/**
 * Adapt the handler to Node's `http.createServer` / Express / Connect:
 *
 * ```ts
 * http.createServer(toNodeListener(createStatusHandler(status))).listen(3000);
 * ```
 */
export function toNodeListener(handler: StatusHandler) {
  return async function listener(req: NodeRequest, res: NodeResponse) {
    try {
      const host = (Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host) ?? "localhost";
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const method = (req.method ?? "GET").toUpperCase();
      let body: string | undefined;
      if (method !== "GET" && method !== "HEAD") {
        const decoder = new TextDecoder();
        body = "";
        for await (const chunk of req) body += decoder.decode(chunk, { stream: true });
        body += decoder.decode();
      }
      const response = await handler(
        new Request(`http://${host}${req.url ?? "/"}`, { method, headers, body: body || undefined })
      );
      res.statusCode = response.status;
      response.headers.forEach((value, name) => res.setHeader(name, value));
      res.end(await response.text());
    } catch (error) {
      // The handler reports its own failures; this only covers a broken request or response
      console.error(`[sermon-js] ${error instanceof Error ? error.name : "Error"} while serving a request`);
      res.statusCode = 500;
      res.end('{"error":"Internal error"}');
    }
  };
}
