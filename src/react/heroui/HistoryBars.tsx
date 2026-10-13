import { Chip, Tabs } from "@heroui/react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { HistoryBar, HistoryRange } from "../../types";
import { formatDateTime, formatDuration, LABEL_TEXT, LABEL_TONE } from "../format";
import { useHistory } from "../hooks";
import { mergeBars } from "../tree";
import { TONE_BG, TONE_TEXT } from "./tones";

/** A stretch of history, in ms timestamps (inclusive) */
export type HistoryPeriod = { start: number; end: number };

/** Minimum room for one bar and its gap */
const MIN_BAR_PX = 3;

function average(bars: HistoryBar[]) {
  const scored = bars.filter((bar) => bar.score !== null);
  if (!scored.length) return null;
  return Math.round(scored.reduce((sum, bar) => sum + (bar.score as number), 0) / scored.length);
}

/**
 * Score history as bars over a full-height gray track: the gray above a bar is what was
 * missing to 100, and an all-gray column means no data. Hover a bar for its details.
 */
export function HistoryBars({
  names = {},
  selected = null,
  onSelect,
}: {
  /** Service names by key, to label failures */
  names?: Record<string, string>;
  /** The period currently shown by the page, if any: its bar is highlighted */
  selected?: HistoryPeriod | null;
  /** Makes bars clickable: called with a bar's period, or `null` when the selected bar is clicked again */
  onSelect?: (period: HistoryPeriod | null) => void;
}) {
  const [range, setRange] = useState<HistoryRange>("24h");
  const [hovered, setHovered] = useState<number | null>(null);
  const history = useHistory(range);

  // On narrow screens there isn't a few pixels per bar: merge neighbours until there is
  const chart = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const element = chart.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { bars, factor } = useMemo(
    () => mergeBars(history.data?.bars ?? [], width ? Math.floor(width / MIN_BAR_PX) : Infinity),
    [history.data, width]
  );
  const spanMs = (history.data?.bucketMs ?? 0) * factor;
  // A selection made at another zoom level still highlights the bar that contains it
  const selectedIndex = selected ? bars.findIndex((bar) => selected.start >= bar.start && selected.start < bar.start + spanMs) : -1;
  const active =
    (hovered !== null && bars[hovered]) || (selectedIndex >= 0 && bars[selectedIndex]) || bars.findLast((bar) => bar.runs > 0);
  const avg = average(bars);
  const dimmedBy = hovered ?? (selectedIndex >= 0 ? selectedIndex : null);
  const toggle = (bar: HistoryBar, index: number) => {
    if (!onSelect || bar.runs === 0) return;
    // Periods are inclusive: stop just before the next bar starts
    onSelect(index === selectedIndex ? null : { start: bar.start, end: bar.start + spanMs - 1 });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium">System score history</h3>
          <p className="text-xs text-muted">
            {history.data ? `Worst score per ${formatDuration(history.data.bucketMs * factor)}` : "Loading…"}
            {avg !== null && ` · average ${avg}`}
          </p>
        </div>
        <Tabs
          selectedKey={range}
          onSelectionChange={(key) => {
            setRange(key as HistoryRange);
            setHovered(null);
          }}
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="History range">
              <Tabs.Tab id="24h">
                24h
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab id="7d">
                7d
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
      </div>

      <div
        ref={chart}
        className="flex h-24 items-end gap-px"
        onMouseLeave={() => setHovered(null)}
        role={onSelect ? "group" : "img"}
        aria-label={`System score over the last ${range}`}
      >
        {history.isPending &&
          Array.from({ length: 48 }, (_, index) => (
            <div key={index} className="h-1/3 flex-1 animate-pulse rounded-sm bg-default" />
          ))}
        {bars.map((bar, index) => {
          const clickable = !!onSelect && bar.runs > 0;
          return (
          <div
            key={bar.start}
            className={`relative h-full flex-1 overflow-hidden rounded-sm bg-default transition-opacity outline-none focus-visible:ring-2 focus-visible:ring-focus ${
              clickable ? "cursor-pointer" : "cursor-default"
            } ${dimmedBy !== null && dimmedBy !== index ? "opacity-50" : ""} ${
              index === selectedIndex ? "ring-2 ring-foreground" : ""
            }`}
            onMouseEnter={() => setHovered(index)}
            {...(clickable
              ? {
                  role: "button",
                  tabIndex: 0,
                  "aria-pressed": index === selectedIndex,
                  "aria-label": `${formatDateTime(bar.start)}: ${
                    bar.score === null ? "no data" : `score ${bar.score}`
                  }. Show the page at this time`,
                  onClick: () => toggle(bar, index),
                  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    toggle(bar, index);
                  },
                }
              : {})}
          >
            {bar.score !== null && (
              <div
                className={`absolute inset-x-0 bottom-0 ${TONE_BG[LABEL_TONE[bar.label]]}`}
                // A sliver stays visible even at a score of 0
                style={{ height: `${Math.max(3, bar.score)}%` }}
              />
            )}
          </div>
          );
        })}
      </div>

      <div className="flex justify-between text-[11px] text-muted">
        <span>{range === "24h" ? "24 hours ago" : "7 days ago"}</span>
        <span>Now</span>
      </div>

      <div className="min-h-10 rounded-lg bg-surface-secondary px-3 py-2 text-xs">
        {active ? (
          <div className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-x-3">
              <span className="font-medium">{formatDateTime(active.start)}</span>
              <span className={TONE_TEXT[LABEL_TONE[active.label]]}>
                {active.score === null ? "No data" : `Score ${active.score} · ${LABEL_TEXT[active.label]}`}
              </span>
              {active.runs > 0 && <span className="text-muted">{active.runs} run(s)</span>}
              {onSelect && active.runs > 0 && (
                <span className="ml-auto text-muted">
                  {selectedIndex >= 0 && bars[selectedIndex] === active
                    ? "Shown below · click again for live"
                    : "Click to show the page at this time"}
                </span>
              )}
            </div>
            {Object.keys(active.failing).length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1.5">
                {Object.entries(active.failing).map(([key, status]) => (
                  <Chip
                    key={key}
                    size="sm"
                    variant="soft"
                    color={status === "down" ? "danger" : "warning"}
                    aria-label={`${names[key] ?? key}: ${status}`}
                  >
                    {names[key] ?? key}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        ) : (
          <span className="text-muted">Hover a bar to see details</span>
        )}
      </div>
    </div>
  );
}
