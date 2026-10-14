import { Card } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ViewerPayload } from "../../api";
import { currentAnchor, focusAnchor } from "../anchors";
import type { StatusClient } from "../client";
import { formatDuration } from "../format";
import { StatusProvider, useStatus, useStatusClient, useViewer } from "../hooks";
import { buildLayout, flattenServices } from "../tree";
import { RunAllButton, StaleNotice, ThemeSwitcher } from "./controls";
import { FailingServices } from "./FailingServices";
import { FLY_REGIONS } from "./details";
import { HistoryBars, type HistoryPeriod } from "./HistoryBars";
import { ScoreHeader } from "./ScoreHeader";
import { ServiceNav } from "./ServiceNav";
import { KitOptions, ServiceRow } from "./ServiceRow";
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
  /** Text of the sign-in link shown to anonymous viewers when the server has access control (default "Sign in") */
  signInLabel?: string;
  /** Line under the public components, next to the sign-in link (default "to see every service and its details.") */
  signInHint?: string;
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
  signInLabel = "Sign in",
  signInHint = "to see every service and its details.",
  viewer,
}: StatusPageProps & { viewer: ViewerPayload }) {
  const publicView = viewer.view === "public";
  const signIn = publicView && viewer.signInUrl ? viewer.signInUrl : undefined;
  const status = useStatus({ refetchInterval });
  const snapshot = status.data;
  // Selecting a history bar adds a "What was failing" section for that period; the rest stays live
  const [period, setPeriod] = useState<HistoryPeriod | null>(null);
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

  // The hash can also change on an open page: back/forward, or a link that only changes it
  useEffect(() => {
    const onHashChange = () => {
      const anchor = currentAnchor();
      if (anchor) focusAnchor(anchor);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    // On wide screens the service index is attached to the right of the main column
    <div className="mx-auto flex min-h-screen max-w-5xl gap-6 px-4 py-8 sm:px-6 xl:max-w-[calc(64rem+12rem+1.5rem)]">
      <main className="flex min-w-0 flex-1 flex-col gap-6">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          {brand ?? <h1 className="text-lg font-semibold">Status</h1>}
          <div className="flex flex-wrap items-center gap-3">
            {!publicView && viewer.name && <span className="text-xs text-muted">Signed in as {viewer.name}</span>}
            {signIn && (
              <a
                href={signIn}
                className="rounded-md px-2.5 py-1 text-sm font-medium text-foreground outline-none hover:bg-default focus-visible:ring-2 focus-visible:ring-focus"
              >
                {signInLabel}
              </a>
            )}
            {snapshot && allowRuns && !publicView && <RunAllButton />}
          </div>
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
                <HistoryBars names={names} selected={period} onSelect={setPeriod} />
              </Card.Content>
            </Card>
            {period && <FailingServices period={period} />}

            {publicView ? (
              <>
                <Card>
                  <Card.Content>
                    <div className="divide-y divide-border">
                      {flattenServices(snapshot.tree).map((row) => (
                        <ServiceRow key={row.key} service={row} anchor={false} />
                      ))}
                    </div>
                  </Card.Content>
                </Card>
                {signIn && (
                  <p className="text-center text-sm text-muted">
                    <a href={signIn} className="font-medium text-foreground underline underline-offset-2">
                      {signInLabel}
                    </a>{" "}
                    {signInHint}
                  </p>
                )}
              </>
            ) : (
              blocks.map((block) =>
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

      {snapshot && showNav && !publicView && (
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
          <ViewGate {...props} />
        </KitOptions.Provider>
      </StatusProvider>
    </QueryClientProvider>
  );
}

/**
 * Asks the server who is looking before loading anything else, so a signed-in viewer never
 * sees the public page flash first. Servers without access control answer "full".
 */
function ViewGate(props: StatusPageProps) {
  const base = useStatusClient();
  const viewer = useViewer();
  const options = useContext(KitOptions);
  // If the server can't say, fall back to the public view: it is never more than allowed
  const payload: ViewerPayload | undefined = viewer.data ?? (viewer.isError ? { view: "public" } : undefined);
  const view = payload?.view;
  const client = useMemo(() => (view ? base.withView(view) : undefined), [base, view]);
  const kit = useMemo(
    () => ({ ...options, publicView: view === "public", allowRuns: options.allowRuns && view !== "public" }),
    [options, view]
  );
  if (!payload || !client) {
    return (
      <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-8 sm:px-6">
        <div className="h-8 w-40 animate-pulse rounded-lg bg-surface" />
        <div className="h-40 animate-pulse rounded-3xl bg-surface" />
      </div>
    );
  }
  return (
    <StatusProvider client={client}>
      <KitOptions.Provider value={kit}>
        <Page {...props} viewer={payload} />
      </KitOptions.Provider>
    </StatusProvider>
  );
}
