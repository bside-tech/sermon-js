import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { HistoryRange } from "../types";
import { createStatusClient, type StatusClient } from "./client";

const ClientContext = createContext<StatusClient | undefined>(undefined);

/** Tells the hooks where the status API lives. Needs a React Query `QueryClientProvider` above it. */
export function StatusProvider({
  baseUrl,
  client,
  children,
}: {
  /** Where `createStatusHandler` is mounted (default "/api") */
  baseUrl?: string;
  /** Or a ready client, e.g. with a custom `fetch` */
  client?: StatusClient;
  children: ReactNode;
}) {
  const value = useMemo(() => client ?? createStatusClient({ baseUrl }), [client, baseUrl]);
  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}

const fallbackClient = createStatusClient();

export function useStatusClient(): StatusClient {
  return useContext(ClientContext) ?? fallbackClient;
}

/** The snapshot, refreshed periodically (default every 30 s) */
export function useStatus({ refetchInterval = 30_000 }: { refetchInterval?: number | false } = {}) {
  const client = useStatusClient();
  return useQuery({ queryKey: ["sermon", "status"], queryFn: () => client.status(), refetchInterval });
}

/** The score history for a range */
export function useHistory(range: HistoryRange, { refetchInterval = 60_000 }: { refetchInterval?: number | false } = {}) {
  const client = useStatusClient();
  return useQuery({ queryKey: ["sermon", "history", range], queryFn: () => client.history(range), refetchInterval });
}

/**
 * Run everything (`mutate()`) or one service (`mutate(key)`) on demand. The snapshot updates
 * in place; a refused run surfaces as a `RateLimitError` in `error`.
 */
export function useRunChecks() {
  const client = useStatusClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (key?: string | void) => client.run(key || undefined),
    onSuccess: (snapshot) => {
      queryClient.setQueryData(["sermon", "status"], snapshot);
      void queryClient.invalidateQueries({ queryKey: ["sermon", "history"] });
    },
  });
}
