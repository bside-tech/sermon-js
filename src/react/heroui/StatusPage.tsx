import { Card } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { currentAnchor, focusAnchor } from "../anchors";
import type { StatusClient } from "../client";
import { formatDuration } from "../format";
import { StatusProvider, useStatus } from "../hooks";
import { buildLayout, flattenServices } from "../tree";
import { RunAllButton, StaleNotice, ThemeSwitcher } from "./controls";
import { FLY_REGIONS } from "./details";
import { HistoryBars } from "./HistoryBars";
import { ScoreHeader } from "./ScoreHeader";
import { ServiceNav } from "./ServiceNav";
import { KitOptions } from "./ServiceRow";
import { ServiceSection } from "./ServiceSection";

export type StatusPageProps = {
  /** Where `createStatusHandler` is mounted (default "/api") */
  baseUrl?: string;
  /** Or a ready client, e.g. with a custom `fetch` */
  client?: StatusClient;
  /** Your logo and title, shown at the top left (default: "Status") */
  brand?: ReactNode;
  /** Replaces the default footer text */
  footer?: ReactNode;
  /** Title of the section holding services declared outside any group (default "Services") */
  ungroupedTitle?: string;
  /** Start sections open for viewers who haven't chosen (default false) */
  defaultExpanded?: boolean;
  /** Offer on-demand runs: "Run all checks" and "Check now" (default true) */
  allowRuns?: boolean;
  /** Show the side index on wide screens (default true) */
  showNav?: boolean;
  /** Show the system / light / dark switch (default true) */
  showThemeSwitcher?: boolean;
  /** City names for instance regions (default: Fly.io's regions) */
  regionNames?: Record<string, string>;
  /** How often the page re-reads the API, in ms (default 30000) */
  refetchInterval?: number | false;
  /** Use your own React Query client instead of the built-in one */
  queryClient?: QueryClient;
};

const defaultQueryClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

function Page({
  brand,
  footer,
  ungroupedTitle,
  defaultExpanded,
  allowRuns = true,
  showNav = true,
  showThemeSwitcher = true,
  refetchInterval,
}: StatusPageProps) {
  const status = useStatus({ refetchInterval });
  const snapshot = status.data;
  const blocks = useMemo(() => (snapshot ? buildLayout(snapshot.tree, { ungroupedTitle }) : []), [snapshot, ungroupedTitle]);
  const names = useMemo(
    () => Object.fromEntries(flattenServices(snapshot?.tree ?? []).map((service) => [service.key, service.name])),
    [snapshot]
  );

  // Deep links (#service-…, #group-…): open the right section once the data is there
  const handledHash = useRef(false);
  useEffect(() => {
    if (handledHash.current || !snapshot) return;
    handledHash.current = true;
    const anchor = currentAnchor();
    if (!anchor) return;
    // Otherwise the browser restores the previous scroll position after we jump
    history.scrollRestoration = "manual";
    focusAnchor(anchor, { smooth: false });
  }, [snapshot]);

  return (
    // On wide screens the service index is attached to the right of the main column
    <div className="mx-auto flex min-h-screen max-w-5xl gap-6 px-4 py-8 sm:px-6 xl:max-w-[calc(64rem+12rem+1.5rem)]">
      <main className="flex min-w-0 flex-1 flex-col gap-6">
        <header className="flex items-center justify-between gap-4">
          {brand ?? <h1 className="text-lg font-semibold">Status</h1>}
          {snapshot && allowRuns && <RunAllButton />}
        </header>

        {status.isPending && <div className="h-40 animate-pulse rounded-3xl bg-surface" />}
        {status.isError && (
          <Card>
            <Card.Content className="text-danger">Could not load status: {status.error.message}</Card.Content>
          </Card>
        )}

        {snapshot && (
          <>
            <StaleNotice snapshot={snapshot} />
            <Card>
              <Card.Content className="flex flex-col gap-6">
                <ScoreHeader snapshot={snapshot} />
                <HistoryBars names={names} />
              </Card.Content>
            </Card>

            {blocks.map((block) =>
              block.type === "section" ? (
                <ServiceSection key={block.section.key} section={block.section} defaultExpanded={defaultExpanded} />
              ) : (
                <div key={block.key} className="contents">
                  <div className="mt-2 flex flex-col">
                    <h2 className="text-lg font-semibold leading-snug">{block.title}</h2>
                    {block.description && <p className="text-sm leading-snug text-muted">{block.description}</p>}
                  </div>
                  {block.sections.map((section) => (
                    <ServiceSection key={section.key} section={section} defaultExpanded={defaultExpanded} />
                  ))}
                </div>
              )
            )}
          </>
        )}

        <footer className="flex flex-wrap items-center justify-between gap-3 pb-4 text-xs text-muted">
          <span>
            {footer ??
              (snapshot
                ? `Checks run every ${formatDuration(snapshot.intervalMs)} · history kept for ${formatDuration(snapshot.retentionMs)}`
                : "")}
          </span>
          {showThemeSwitcher && <ThemeSwitcher />}
        </footer>
      </main>

      {snapshot && showNav && (
        <aside className="sticky top-4 hidden w-48 shrink-0 self-start xl:block">
          <ServiceNav blocks={blocks} />
        </aside>
      )}
    </div>
  );
}

/**
 * A complete status page: overall score, history, collapsible sections with per-service
 * details, a side index and a theme switch. It reads everything from the API of
 * `createStatusHandler`, so the page mirrors the `services` tree you configured.
 *
 * ```tsx
 * <StatusPage baseUrl="/api" brand={<Logo />} />
 * ```
 */
export function StatusPage(props: StatusPageProps) {
  const options = useMemo(
    () => ({ regionNames: props.regionNames ?? FLY_REGIONS, allowRuns: props.allowRuns ?? true }),
    [props.regionNames, props.allowRuns]
  );
  return (
    <QueryClientProvider client={props.queryClient ?? defaultQueryClient}>
      <StatusProvider baseUrl={props.baseUrl} client={props.client}>
        <KitOptions.Provider value={options}>
          <Page {...props} />
        </KitOptions.Provider>
      </StatusProvider>
    </QueryClientProvider>
  );
}
