import { Chip } from "@heroui/react";
import type { Status, StatusSnapshot } from "../../types";
import { formatDuration, LABEL_TEXT, LABEL_TONE, STATUS_TEXT, STATUS_TONE, timeAgo, type Tone } from "../format";
import { TONE_BG, TONE_TEXT } from "./tones";

const SIZE = 88;
const STROKE = 8;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The overall score as a ring */
export function ScoreRing({ score, tone }: { score: number | null; tone: Tone }) {
  const progress = score === null ? 0 : score / 100;
  return (
    <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="-rotate-90">
        <circle cx={SIZE / 2} cy={SIZE / 2} r={RADIUS} fill="none" strokeWidth={STROKE} className="stroke-default" />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - progress)}
          className={`${TONE_TEXT[tone]} transition-[stroke-dashoffset] duration-700`}
          stroke="currentColor"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold tabular-nums">{score ?? "–"}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted">score</span>
      </div>
    </div>
  );
}

const COUNT_ORDER: Status[] = ["up", "degraded", "down", "sleeping", "unconfigured"];

/** Score ring, overall label, counts per status and when checks last ran */
export function ScoreHeader({ snapshot }: { snapshot: StatusSnapshot }) {
  const tone = LABEL_TONE[snapshot.label];
  return (
    <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
      <ScoreRing score={snapshot.score} tone={tone} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">{LABEL_TEXT[snapshot.label]}</h2>
          <Chip color={tone} variant="soft" size="sm">
            {snapshot.label}
          </Chip>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted">
          {COUNT_ORDER.filter((status) => snapshot.counts[status] > 0).map((status) => (
            <span key={status} className="flex items-center gap-1.5">
              <span className={`size-2 rounded-full ${TONE_BG[STATUS_TONE[status]]}`} />
              {snapshot.counts[status]} {STATUS_TEXT[status].toLowerCase()}
            </span>
          ))}
        </div>
        <p className="text-xs text-muted">
          {snapshot.lastCheckedAt
            ? `Last checked ${timeAgo(snapshot.lastCheckedAt)} · checks run every ${formatDuration(snapshot.intervalMs)}`
            : "No checks have run yet"}
        </p>
      </div>
    </div>
  );
}
