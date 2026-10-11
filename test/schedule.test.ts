import { afterEach, describe, expect, it, vi } from "vitest";
import { custom, defineStatus, memoryStore, startScheduler } from "../src";

const MINUTE = 60_000;

function setup({ interval = "5m" as const, store = undefined as ReturnType<typeof memoryStore> | undefined } = {}) {
  let now = Date.UTC(2026, 9, 9, 12, 0);
  const clock = { advance: (ms: number) => (now += ms), now: () => now };
  const check = vi.fn(async () => true);
  const status = defineStatus({
    now: clock.now,
    interval,
    store: store ?? memoryStore({ now: clock.now }),
    services: [custom({ name: "A", check })],
  });
  return { status, clock, check };
}

describe("tick()", () => {
  it("runs when nothing ran yet, then only when due", async () => {
    const { status, clock, check } = setup();
    const first = await status.tick();
    expect(first).toMatchObject({ ran: true, report: { trigger: "scheduled", full: true } });

    clock.advance(2 * MINUTE);
    expect(await status.tick()).toEqual({ ran: false, reason: "not-due", nextDueAt: clock.now() + 3 * MINUTE });
    expect(check).toHaveBeenCalledTimes(1);

    clock.advance(3 * MINUTE);
    expect((await status.tick()).ran).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("tolerates schedulers that fire a little early", async () => {
    const { status, clock } = setup();
    await status.tick();
    clock.advance(5 * MINUTE - 20_000);
    expect((await status.tick()).ran).toBe(true);
  });

  it("never runs twice at once", async () => {
    const { status, check } = setup();
    const results = await Promise.all([status.tick(), status.tick(), status.tick()]);
    expect(results.filter((result) => result.ran)).toHaveLength(1);
    expect(results.filter((result) => !result.ran && result.reason === "locked")).toHaveLength(2);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("runs once across instances that share a store", async () => {
    let now = Date.UTC(2026, 9, 9, 12, 0);
    const store = memoryStore({ now: () => now });
    const check = vi.fn(async () => true);
    const make = () => defineStatus({ now: () => now, store, services: [custom({ name: "A", check })] });
    const [a, b] = [make(), make()];
    const results = await Promise.all([a.tick(), b.tick()]);
    expect(results.filter((result) => result.ran)).toHaveLength(1);
    now += 1000;
    expect(await b.tick()).toMatchObject({ ran: false });
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("is not reset by single-service runs", async () => {
    const { status, clock, check } = setup();
    await status.tick();
    clock.advance(4 * MINUTE);
    await status.run({ keys: ["a"] });
    clock.advance(MINUTE);
    expect((await status.tick()).ran).toBe(true);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it("can be forced", async () => {
    const { status, clock, check } = setup();
    await status.tick();
    clock.advance(3 * MINUTE);
    expect((await status.tick({ force: true })).ran).toBe(true);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("counts manual full runs as runs", async () => {
    const { status, clock } = setup();
    await status.run({ trigger: "manual" });
    clock.advance(MINUTE);
    expect(await status.tick()).toMatchObject({ ran: false, reason: "not-due" });
  });
});

describe("startScheduler", () => {
  afterEach(() => vi.useRealTimers());

  it("ticks immediately, then every period, until stopped", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => ({ ran: false as const, reason: "not-due" as const, nextDueAt: 0 }));
    const onTick = vi.fn();
    const scheduler = startScheduler({ tick, intervalMs: 5 * MINUTE } as never, { jitter: 0, onTick });

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(tick).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(onTick).toHaveBeenCalledTimes(4);

    scheduler.stop();
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it("can wait one period first, and uses a custom period", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => ({ ran: false as const, reason: "not-due" as const, nextDueAt: 0 }));
    const scheduler = startScheduler({ tick, intervalMs: 5 * MINUTE } as never, { every: "1m", immediate: false, jitter: 0 });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(tick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(tick).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("keeps going when a tick fails", async () => {
    vi.useFakeTimers();
    const tick = vi.fn(async () => {
      throw new Error("store down");
    });
    const onError = vi.fn();
    const scheduler = startScheduler({ tick, intervalMs: MINUTE } as never, { jitter: 0, onError });
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });

  it("two schedulers on one store run the checks once per interval", async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 9, 12, 0) });
    const store = memoryStore();
    const check = vi.fn(async () => true);
    const make = () => defineStatus({ store, interval: "1m", services: [custom({ name: "A", check })] });
    const schedulers = [startScheduler(make(), { jitter: 0 }), startScheduler(make(), { jitter: 0 })];
    await vi.advanceTimersByTimeAsync(0);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    expect(check).toHaveBeenCalledTimes(4);
    schedulers.forEach((scheduler) => scheduler.stop());
  });
});
