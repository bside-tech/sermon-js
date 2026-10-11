import { toMs, type Duration } from "./duration";
import type { Status, TickResult } from "./status";

export type SchedulerOptions = {
  /** How often to call `tick()` (default: the status `interval`) */
  every?: Duration;
  /** Run a first tick right away instead of waiting one period (default true) */
  immediate?: boolean;
  /** Random extra delay per period, as a share of it, so replicas don't all fire together (default 0.1) */
  jitter?: number;
  onTick?: (result: TickResult) => void;
  /** Called when a tick throws (e.g. the store is unreachable). The scheduler keeps going. */
  onError?: (error: unknown) => void;
};

/**
 * In-process scheduler for long-running servers (Node, Bun, Deno, containers).
 * It only calls `status.tick()`, which is idempotent, so several replicas sharing one store
 * still run the checks once per interval.
 *
 * On serverless platforms use the platform's scheduler, or the `/tick` endpoint, instead.
 */
export function startScheduler(status: Status, options: SchedulerOptions = {}): { stop: () => void } {
  const periodMs = toMs(options.every ?? status.intervalMs);
  const jitter = Math.max(0, options.jitter ?? 0.1);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    timer = setTimeout(run, delayMs);
    // Don't keep a Node process alive just for the scheduler
    (timer as { unref?: () => void }).unref?.();
  };

  const run = async () => {
    try {
      // Tick first: `onTick?.(await …)` would skip the call entirely when there is no listener
      const result = await status.tick();
      options.onTick?.(result);
    } catch (error) {
      options.onError?.(error);
    }
    schedule(periodMs + Math.random() * jitter * periodMs);
  };

  schedule(options.immediate === false ? periodMs : 0);

  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
