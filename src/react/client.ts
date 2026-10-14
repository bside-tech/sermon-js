import type { ViewerPayload } from "../api";
import type { ServiceHistory } from "../status";
import type { HistoryPayload, HistoryRange, StatusSnapshot } from "../types";

/** Thrown when an on-demand run is refused because one happened too recently */
export class RateLimitError extends Error {
  constructor(readonly retryAfter: number) {
    super(`Please wait ${retryAfter}s before running this again`);
    this.name = "RateLimitError";
  }
}

export type StatusClient = {
  /** Which view this client asks for: "full" adds `?view=full`, which the server grants or not */
  readonly view: "full" | "public";
  /** Who is looking, and where to sign in; servers without access control answer "full" */
  viewer(): Promise<ViewerPayload>;
  /** The same client, asking for another view */
  withView(view: "full" | "public"): StatusClient;
  status(): Promise<StatusSnapshot>;
  /** The page as it was during a past period: each service's worst result in it */
  statusAt(period: { start: number; end: number }): Promise<StatusSnapshot>;
  history(range: HistoryRange): Promise<HistoryPayload>;
  serviceHistory(key: string, range: HistoryRange): Promise<ServiceHistory>;
  /** Run everything, or one service; resolves with the fresh snapshot */
  run(key?: string): Promise<StatusSnapshot>;
};

/** Talks to the routes of `createStatusHandler` */
export function createStatusClient({
  baseUrl = "/api",
  fetch: fetchImpl,
  view = "public",
}: {
  /** Where the API is mounted (default "/api"); may be an absolute URL */
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Ask for the full view (default "public"). Servers without access control always give everything. */
  view?: "full" | "public";
} = {}): StatusClient {
  const base = baseUrl.replace(/\/+$/, "");
  const withView = (path: string) => (view === "full" ? `${path}${path.includes("?") ? "&" : "?"}view=full` : path);
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await (fetchImpl ?? fetch)(`${base}${withView(path)}`, init);
    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as { retryAfter?: number };
      throw new RateLimitError(body.retryAfter ?? Number(response.headers.get("retry-after") ?? 30));
    }
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return (await response.json()) as T;
  }
  return {
    view,
    withView: (next) => createStatusClient({ baseUrl, fetch: fetchImpl, view: next }),
    viewer: async () => {
      const response = await (fetchImpl ?? fetch)(`${base}/viewer`);
      // Servers from before access control have no /viewer: everyone sees everything there
      if (response.status === 404) return { view: "full" };
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return (await response.json()) as ViewerPayload;
    },
    status: () => request("/status"),
    statusAt: ({ start, end }) => request(`/status/at?start=${start}&end=${end}`),
    history: (range) => request(`/history?range=${range}`),
    serviceHistory: (key, range) => request(`/services/${encodeURIComponent(key)}/history?range=${range}`),
    run: (key) => request(key ? `/run/${encodeURIComponent(key)}` : "/run", { method: "POST" }),
  };
}
