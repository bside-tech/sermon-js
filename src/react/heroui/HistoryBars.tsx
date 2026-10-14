import { Chip, Tabs } from "@heroui/react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { HistoryBar, HistoryRange } from "../../types";
import { formatDateTime, formatDuration, LABEL_TEXT, LABEL_TONE } from "../format";
import { useHistory } from "../hooks";
import { mergeBars } from "../tree";
import { TONE_BG, TONE_TEXT } from "./tones";

/** A stretch of history, in ms timestamps (inclusive) */
export type HistoryPeriod = { start: number; end: number };

/** Minimum room for one bar and its gap */
const MIN_BAR_PX = 3;

/** Where the tooltip sits: centered on its bar, or hanging from the nearest edge of the chart */
function tipStyle(index: number, count: number): CSSProperties {
  const center = ((index + 0.5) / count) * 100;
  if (center < 25) return { left: `${(index / count) * 100}%` };
  if (center > 75) return { right: `${((count - index - 1) / count) * 100}%` };
  return { left: `${center}%`, transform: "translateX(-50%)" };
}

function average(bars: HistoryBar[]) {
  const scored = bars.filter((bar) => bar.score !== null);
  if (!scored.length) return null;
  return Math.round(scored.reduce((sum, bar) => sum + (bar.score as number), 0) / scored.length);
}

/**
 * Score history as bars over a full-height gray track: the gray above a bar is what was
 * missing to 100, and an all-gray column means no data. Hovering a bar shows its details in a tooltip.
 */
export function HistoryBars({
  names = {},
  selected = null,
  onSelect,
}: {
  /** Service names by key, to label failures */
  names?: Record<string, string>;
  /** The selected period, if any: its bar stays lit while the others dim, and a strip below the chart names it */
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
  const tip = hovered !== null ? bars[hovered] : undefined;
  const avg = average(bars);
  // The selected bar stays lit and the others dim; without a selection, hovering does the same
  const lit = (index: number) =>
    selectedIndex >= 0 ? index === selectedIndex || index === hovered : hovered === null || index === hovered;
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

      <div className="relative">
        {tip && hovered !== null && (
          // Follows the hovered bar; near an edge it hangs from that side so it stays inside the chart
          <div
            role="tooltip"
            className="pointer-events-none absolute bottom-full z-20 mb-2 flex w-max max-w-[min(20rem,100%)] flex-col gap-1 rounded-lg border border-border bg-overlay px-3 py-2 text-xs text-overlay-foreground shadow-lg"
            style={tipStyle(hovered, bars.length)}
          >
            <span className="font-medium">{formatDateTime(tip.start)}</span>
            <span className={TONE_TEXT[LABEL_TONE[tip.label]]}>
              {tip.score === null ? "No data" : `Score ${tip.score} · ${LABEL_TEXT[tip.label]}`}
              {tip.runs > 1 && <span className="text-muted"> · {tip.runs} runs</span>}
            </span>
            {Object.keys(tip.failing).length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-0.5">
                {Object.entries(tip.failing).map(([key, status]) => (
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
            {/* Nothing to announce on a bar where nothing failed */}
            {onSelect && hovered === selectedIndex && (
              <span className="text-muted">Selected · click to go back to live</span>
            )}
            {onSelect && hovered !== selectedIndex && Object.keys(tip.failing).length > 0 && (
              <span className="text-muted">Click to see what was failing</span>
            )}
          </div>
        )}
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
              className={`relative h-full flex-1 overflow-hidden rounded-sm bg-default transition-[opacity,filter] outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                clickable ? "cursor-pointer" : "cursor-default"
              } ${
                // With a selection the other bars also lose their color, so only the selected one reads as data
                lit(index) ? "" : selectedIndex >= 0 ? "opacity-30 grayscale" : "opacity-50"
              }`}
              onMouseEnter={() => setHovered(index)}
              onFocus={() => setHovered(index)}
              onBlur={() => setHovered((current) => (current === index ? null : current))}
              {...(clickable
                ? {
                    role: "button",
                    tabIndex: 0,
                    "aria-pressed": index === selectedIndex,
                    "aria-label": `${formatDateTime(bar.start)}: ${
                      bar.score === null ? "no data" : `score ${bar.score}`
                    }. Show what was failing at this time`,
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
      </div>

      <div className="flex justify-between text-[11px] text-muted">
        <span>{range === "24h" ? "24 hours ago" : "7 days ago"}</span>
        <span>Now</span>
      </div>

      {selected && onSelect && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg bg-foreground px-3 py-1.5 text-sm text-background"
        >
          <span className="font-medium">
            Selected: {formatDateTime(selected.start)} – {formatDateTime(selected.end + 1)}
          </span>
          <button
            type="button"
            className="cursor-pointer rounded px-1.5 py-0.5 text-xs font-medium underline underline-offset-2 outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-background"
            onClick={() => onSelect(null)}
          >
            Back to live
          </button>
        </div>
      )}
    </div>
  );
}
