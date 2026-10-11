import { Label, Meter } from "@heroui/react";
import type { Instance, ServiceStats, Usage } from "../../types";
import { formatMs, formatPct, STATUS_TEXT, STATUS_TONE, timeAgo } from "../format";
import { TONE_BG, TONE_TEXT } from "./tones";

const WIDTH = 120;
const HEIGHT = 28;

/** Latency over the last 24h; gaps are runs without a measurement (asleep, down) */
export function Sparkline({ values, threshold }: { values: Array<number | null>; threshold: number }) {
  const points = values.slice(-96);
  const measured = points.filter((value): value is number => value !== null);
  if (measured.length < 2) {
    return (
      <div style={{ width: WIDTH, height: HEIGHT }} className="text-[10px] text-muted">
        no latency data
      </div>
    );
  }
  const max = Math.max(threshold, ...measured);
  const step = WIDTH / Math.max(1, points.length - 1);
  const y = (value: number) => HEIGHT - 2 - (value / max) * (HEIGHT - 4);

  let path = "";
  points.forEach((value, index) => {
    if (value === null) return;
    const previous = points[index - 1];
    path += `${previous === null || previous === undefined ? "M" : "L"}${(index * step).toFixed(1)},${y(value).toFixed(1)} `;
  });

  return (
    <svg width={WIDTH} height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} aria-hidden className="shrink-0">
      <line
        x1={0}
        x2={WIDTH}
        y1={y(threshold)}
        y2={y(threshold)}
        className="stroke-warning"
        strokeDasharray="2 3"
        strokeWidth={1}
        opacity={0.6}
      />
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-accent" />
    </svg>
  );
}

const number = new Intl.NumberFormat("en");

/** A quota as a bar with its numbers: green below 75%, amber from 75%, red from 90% */
export function UsageBar({ usage }: { usage: Usage }) {
  const pct = usage.limit > 0 ? (usage.used / usage.limit) * 100 : 0;
  const unit = usage.unit ? ` ${usage.unit}` : "";
  return (
    <div className="flex w-full max-w-md flex-col gap-1">
      <Meter
        value={Math.min(usage.used, usage.limit)}
        maxValue={usage.limit}
        color={pct >= 90 ? "danger" : pct >= 75 ? "warning" : "success"}
        size="sm"
        valueLabel={
          <span className="tabular-nums">
            {number.format(usage.used)} / {number.format(usage.limit)}
            {unit} · {pct.toFixed(pct < 10 ? 1 : 0)}%
          </span>
        }
      >
        <Label className="text-xs">{usage.label}</Label>
        <Meter.Output className="text-xs" />
        <Meter.Track>
          <Meter.Fill />
        </Meter.Track>
      </Meter>
      {usage.resetsAt && (
        <span className="text-[11px] text-muted">
          {number.format(usage.limit - usage.used)}
          {unit} left · resets {timeAgo(usage.resetsAt)}
        </span>
      )}
    </div>
  );
}

/** Fly.io region codes → city. Extend or replace with the `regionNames` prop. */
export const FLY_REGIONS: Record<string, string> = {
  ams: "Amsterdam", arn: "Stockholm", atl: "Atlanta", bog: "Bogotá", bom: "Mumbai", bos: "Boston",
  cdg: "Paris", den: "Denver", dfw: "Dallas", ewr: "Secaucus", eze: "Buenos Aires", fra: "Frankfurt",
  gdl: "Guadalajara", gig: "Rio de Janeiro", gru: "São Paulo", hkg: "Hong Kong", iad: "Ashburn",
  jnb: "Johannesburg", lax: "Los Angeles", lhr: "London", mad: "Madrid", mia: "Miami", nrt: "Tokyo",
  ord: "Chicago", otp: "Bucharest", phx: "Phoenix", qro: "Querétaro", scl: "Santiago", sea: "Seattle",
  sin: "Singapore", sjc: "San Jose", syd: "Sydney", waw: "Warsaw", yul: "Montreal", yyz: "Toronto",
};

/** One line per machine/region of a multi-instance service */
export function InstanceTable({
  instances,
  stats,
  regionNames = FLY_REGIONS,
}: {
  instances: Instance[];
  stats?: ServiceStats["instances"];
  regionNames?: Record<string, string>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-xs">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
            <th className="py-1 pr-3 font-normal">Region</th>
            <th className="py-1 pr-3 font-normal">Machine</th>
            <th className="py-1 pr-3 font-normal">Status</th>
            <th className="py-1 pr-3 text-right font-normal">Response</th>
            <th className="py-1 pr-3 text-right font-normal">p50 24h</th>
            <th className="py-1 text-right font-normal">Uptime 24h</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {instances.map((instance) => {
            const tone = STATUS_TONE[instance.status];
            const instanceStats = stats?.[instance.key];
            return (
              <tr key={instance.key} className="align-top">
                <td className="py-1.5 pr-3">
                  <span className="flex items-center gap-2">
                    <span className={`size-2 shrink-0 rounded-full ${TONE_BG[tone]}`} aria-hidden />
                    <span className="font-mono">{instance.key}</span>
                    <span className="text-muted">{(instance.region && regionNames[instance.region]) ?? ""}</span>
                  </span>
                </td>
                <td className="py-1.5 pr-3 font-mono text-muted" title={instance.id}>
                  {[instance.id?.slice(0, 8), instance.state].filter(Boolean).join(" · ")}
                </td>
                <td className="py-1.5 pr-3">
                  <span className={TONE_TEXT[tone]}>{STATUS_TEXT[instance.status]}</span>
                  {instance.error && instance.status !== "up" && (
                    <span className="block text-muted">
                      {instance.httpStatus ? `[${instance.httpStatus}] ` : ""}
                      {instance.error}
                    </span>
                  )}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {instance.latencyMs !== undefined ? formatMs(instance.latencyMs) : "–"}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{formatMs(instanceStats?.p50)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatPct(instanceStats?.uptime24h)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
