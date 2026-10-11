import { Button, ToggleButton, ToggleButtonGroup } from "@heroui/react";
import type { StatusSnapshot } from "../../types";
import { RateLimitError } from "../client";
import { formatDuration, timeAgo } from "../format";
import { useRunChecks } from "../hooks";
import { useThemePreference, type ThemePreference } from "../theme";
import { isStale } from "../tree";
import { AlertIcon, DesktopIcon, MoonIcon, RefreshIcon, SunIcon } from "./icons";

/** Runs every check on demand; the icon spins while they run */
export function RunAllButton({ label = "Run all checks" }: { label?: string }) {
  const run = useRunChecks();
  const rateLimited = run.error instanceof RateLimitError ? run.error : undefined;
  return (
    <div className="flex items-center gap-3">
      {rateLimited && <span className="text-xs text-muted">Try again in {rateLimited.retryAfter}s</span>}
      {run.error && !rateLimited && <span className="text-xs text-danger">{run.error.message}</span>}
      <Button size="sm" variant="tertiary" isDisabled={run.isPending} onPress={() => run.mutate()}>
        {/* Not for viewers who prefer reduced motion */}
        <RefreshIcon size={16} className={run.isPending ? "motion-safe:animate-spin" : undefined} />
        {run.isPending ? "Running checks…" : label}
      </Button>
    </div>
  );
}

const THEMES: Array<{ id: ThemePreference; label: string; Icon: typeof SunIcon }> = [
  { id: "system", label: "System theme", Icon: DesktopIcon },
  { id: "light", label: "Light theme", Icon: SunIcon },
  { id: "dark", label: "Dark theme", Icon: MoonIcon },
];

/** A discreet system / light / dark switch, remembered per viewer */
export function ThemeSwitcher() {
  const [preference, setPreference] = useThemePreference();
  return (
    <ToggleButtonGroup
      aria-label="Color theme"
      size="sm"
      disallowEmptySelection
      selectedKeys={[preference]}
      onSelectionChange={(keys) => {
        const [key] = [...keys];
        if (key) setPreference(key as ThemePreference);
      }}
      className="opacity-60 transition-opacity hover:opacity-100 focus-within:opacity-100"
    >
      {THEMES.map(({ id, label, Icon }, index) => (
        <ToggleButton key={id} id={id} isIconOnly aria-label={label}>
          {index > 0 && <ToggleButtonGroup.Separator />}
          <Icon size={14} />
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

/**
 * Shown when the last full run is older than twice the interval: the scheduler has probably
 * stopped, and the page would otherwise keep showing old results as if they were current.
 */
export function StaleNotice({ snapshot }: { snapshot: StatusSnapshot }) {
  // Judged against the server's clock at the time of the snapshot, not the viewer's
  if (!isStale(snapshot, snapshot.generatedAt) || snapshot.lastRunAt === null) return null;
  return (
    <div role="status" className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-sm text-warning">
      <AlertIcon size={16} className="mt-0.5 shrink-0" />
      <span>
        These results are out of date: the last full check ran {timeAgo(snapshot.lastRunAt)}, and checks should run
        every {formatDuration(snapshot.intervalMs)}.
      </span>
    </div>
  );
}
