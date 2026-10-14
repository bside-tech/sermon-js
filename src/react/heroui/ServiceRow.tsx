import { Button, Chip } from "@heroui/react";
import { createContext, useContext } from "react";
import type { ServiceSnapshot } from "../../types";
import { serviceAnchor } from "../anchors";
import { RateLimitError } from "../client";
import { formatDateTime, formatMs, formatPct, humanize, STATUS_TEXT, STATUS_TONE, timeAgo } from "../format";
import { useRunChecks } from "../hooks";
import { statusOf } from "../tree";
import { FLY_REGIONS, InstanceTable, Sparkline, UsageBar } from "./details";
import { PlayIcon } from "./icons";
import { TONE_BG } from "./tones";

/** Display options shared by the kit's components */
export const KitOptions = createContext<{
  regionNames: Record<string, string>;
  allowRuns: boolean;
  /** Rows show results of a past period: no on-demand runs and no present-day statistics */
  historical?: boolean;
}>({
  regionNames: FLY_REGIONS,
  allowRuns: true,
});

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-muted">{label}</span>
      <span className="text-sm tabular-nums">{value}</span>
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Everything known about one service: status, response time, percentiles, uptime, sparkline,
 * per-instance rows, usage bars, metrics, the current error, and a "Check now" button.
 */
export function ServiceRow({
  service,
  anchor = true,
}: {
  service: ServiceSnapshot;
  /** Give the row its deep-link id (default true). Turn off when the same service is listed twice on a page. */
  anchor?: boolean;
}) {
  const run = useRunChecks();
  const { regionNames, allowRuns, historical = false } = useContext(KitOptions);
  const status = statusOf(service);
  const tone = STATUS_TONE[status];
  const { result, stats } = service;
  const failing = status === "down" || status === "degraded";
  const rateLimited = run.error instanceof RateLimitError ? run.error : undefined;
  // "Recent" is measured from the latest check, not the viewer's clock
  const lastFailure =
    !failing && result && stats?.lastFailure && result.checkedAt - stats.lastFailure.at < DAY_MS
      ? stats.lastFailure
      : undefined;

  return (
    <div
      id={anchor ? serviceAnchor(service.key) : undefined}
      className={`flex scroll-mt-6 flex-col gap-3 py-4 ${service.configured ? "" : "opacity-60"}`}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${TONE_BG[tone]}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{service.name}</span>
            {service.critical && (
              <Chip size="sm" variant="tertiary">
                critical
              </Chip>
            )}
            <Chip size="sm" variant="soft" color={tone}>
              {historical && !result ? "No data" : STATUS_TEXT[status]}
            </Chip>
          </div>
          {service.description && <p className="text-xs text-muted">{service.description}</p>}
          {!service.configured && service.missing && service.missing.length > 0 && (
            <p className="text-xs text-muted">Missing: {service.missing.join(", ")}</p>
          )}
        </div>
        {allowRuns && !historical && (
          <div className="flex items-center gap-2">
            {rateLimited && <span className="text-xs text-muted">wait {rateLimited.retryAfter}s</span>}
            <Button
              size="sm"
              variant="ghost"
              isDisabled={!service.configured}
              isPending={run.isPending}
              onPress={() => run.mutate(service.key)}
              aria-label={`Check ${service.name} now`}
            >
              <PlayIcon size={14} />
              Check now
            </Button>
          </div>
        )}
      </div>

      {service.configured && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pl-5.5">
          <Stat label="Response" value={result?.probed === false ? "not probed" : formatMs(result?.latencyMs)} />
          {/* Statistics describe the last 24 hours and 7 days from now: they don't belong to a past period */}
          {!historical && (
            <>
              <Stat label="p50 / p95 24h" value={`${formatMs(stats?.p50)} / ${formatMs(stats?.p95)}`} />
              <Stat label="Uptime 24h" value={formatPct(stats?.uptime24h)} />
              <Stat label="Uptime 7d" value={formatPct(stats?.uptime7d)} />
              {stats && <Sparkline values={stats.latency} threshold={service.slowMs} />}
            </>
          )}
          {result && (
            <Stat label="Checked" value={historical ? formatDateTime(result.checkedAt) : timeAgo(result.checkedAt)} />
          )}
        </div>
      )}

      {result?.instances && result.instances.length > 0 && (
        <div className="pl-5.5">
          <InstanceTable
            instances={result.instances}
            stats={stats?.instances}
            regionNames={regionNames}
            labels={result.instanceLabels}
            showStats={!historical}
          />
        </div>
      )}

      {result?.usage && result.usage.length > 0 && (
        <div className="flex flex-col gap-3 pl-5.5">
          {result.usage.map((usage) => (
            <UsageBar key={usage.label} usage={usage} />
          ))}
        </div>
      )}

      {result?.metrics && Object.keys(result.metrics).length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-5.5">
          {Object.entries(result.metrics)
            .filter(([, value]) => value !== "")
            .map(([key, value]) => (
              <Chip key={key} size="sm" variant="secondary">
                {humanize(key)}: {value}
              </Chip>
            ))}
        </div>
      )}

      {failing && result?.error && (
        <div
          className={`ml-5.5 rounded-lg px-3 py-2 font-mono text-xs break-words ${
            status === "down" ? "bg-danger/10 text-danger" : "bg-warning/10 text-warning"
          }`}
        >
          {result.httpStatus ? `[${result.httpStatus}] ` : ""}
          {result.error}
        </div>
      )}

      {lastFailure && (
        <p className="pl-5.5 text-xs text-muted">
          Last incident {formatDateTime(lastFailure.at)} ({lastFailure.status})
          {lastFailure.error ? `: ${lastFailure.error}` : ""}
        </p>
      )}

      {run.error && !rateLimited && <p className="pl-5.5 text-xs text-danger">{run.error.message}</p>}
    </div>
  );
}
