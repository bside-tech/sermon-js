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
}: {
  /** Where the API is mounted (default "/api"); may be an absolute URL */
  baseUrl?: string;
  fetch?: typeof fetch;
} = {}): StatusClient {
  const base = baseUrl.replace(/\/+$/, "");
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await (fetchImpl ?? fetch)(`${base}${path}`, init);
    if (response.status === 429) {
      const body = (await response.json().catch(() => ({}))) as { retryAfter?: number };
      throw new RateLimitError(body.retryAfter ?? Number(response.headers.get("retry-after") ?? 30));
    }
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return (await response.json()) as T;
  }
  return {
    status: () => request("/status"),
    statusAt: ({ start, end }) => request(`/status/at?start=${start}&end=${end}`),
    history: (range) => request(`/history?range=${range}`),
    serviceHistory: (key, range) => request(`/services/${encodeURIComponent(key)}/history?range=${range}`),
    run: (key) => request(key ? `/run/${encodeURIComponent(key)}` : "/run", { method: "POST" }),
  };
}
