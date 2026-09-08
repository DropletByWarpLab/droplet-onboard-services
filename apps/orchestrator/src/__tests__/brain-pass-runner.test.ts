/**
 * WARP-2850 (ADR-051) — the one way to start a pass, and the boot run.
 *
 * Three callers share this: the interval tick, a run shortly after boot, and
 * an operator. The cases below pin the two decisions that are easy to undo by
 * accident — the boot run is the DETECTOR pass only, and a manual corpus run
 * is rate-limited off `lastRunAt` — plus the property everything rests on:
 * `trigger` returns without waiting for the pass.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";

/** Typed EXPLICITLY: an untyped `vi.fn` infers a zero-length argument tuple,
 *  so `mock.calls[0]![1]` is a tsc error under `typecheck:tests` while vitest
 *  runs it happily — vitest strips types without checking them (WARP-2606). */
const runWithLease = vi.hoisted(() =>
  vi.fn(
    async (
      _prisma: unknown,
      _passKey: string,
      _run: () => Promise<void>,
      _opts?: unknown,
    ): Promise<{ started: boolean; reason?: string; done?: Promise<void> }> => ({
      started: true,
      done: Promise.resolve(),
    }),
  ),
);
vi.mock("../services/brain/brain-lease.service", () => ({ runWithLease }));
vi.mock("../services/brain/brain-lease.service.js", () => ({ runWithLease }));

import {
  createBrainPassTrigger,
  scheduleBootRun,
} from "../services/brain/brain-pass-runner";

const NOW = new Date("2033-06-10T12:00:00.000Z");
const DETECTOR = "detectors";
const CORPUS = "corpus.documents";
const FIVE_MIN = 5 * 60_000;

const detectorRun = vi.fn(async () => {});
const corpusRun = vi.fn(async () => {});

function prismaWith(lastRunAt: Date | null) {
  return {
    brainPass: { findUnique: vi.fn(async () => ({ lastRunAt })) },
  } as unknown as PrismaClient;
}

function makeTrigger(lastRunAt: Date | null = null) {
  return createBrainPassTrigger({
    prisma: prismaWith(lastRunAt),
    runners: { [DETECTOR]: detectorRun, [CORPUS]: corpusRun },
    manualMinIntervalMs: { [CORPUS]: FIVE_MIN },
  });
}

beforeEach(() => {
  runWithLease.mockReset().mockResolvedValue({ started: true, done: Promise.resolve() });
  detectorRun.mockClear();
  corpusRun.mockClear();
});

describe("trigger — the shared entry point (WARP-2850)", () => {
  it("starts a known pass through the lease", async () => {
    await expect(makeTrigger().trigger(DETECTOR)).resolves.toEqual({ ok: true });
    expect(runWithLease).toHaveBeenCalledOnce();
    expect(runWithLease.mock.calls[0]![1]).toBe(DETECTOR);
  });

  it("refuses a pass that is not in the runner registry", async () => {
    // Checked against the RUNNERS map, so a future caller cannot reach another
    // job by shaping a string — even if it forgets to validate.
    await expect(makeTrigger().trigger("corpus.emails")).resolves.toEqual({
      ok: false,
      reason: "unknown_pass",
    });
    expect(runWithLease).not.toHaveBeenCalled();
  });

  it("passes the lease's refusal through unchanged", async () => {
    runWithLease.mockResolvedValueOnce({ started: false, reason: "disabled" } as never);
    await expect(makeTrigger().trigger(DETECTOR)).resolves.toEqual({
      ok: false,
      reason: "disabled",
    });
  });

  it("does NOT await the pass", async () => {
    // The property everything rests on. `runWithLease` resolves once the claim
    // is decided; the pass runs on. If this ever awaited, a cron tick — or an
    // HTTP request — would be holding ten inferences.
    let finish!: () => void;
    runWithLease.mockResolvedValueOnce({
      started: true,
      done: new Promise<void>((r) => (finish = r)),
    } as never);
    await expect(makeTrigger().trigger(CORPUS)).resolves.toEqual({ ok: true });
    finish();
  });
});

describe("manual rate limit — duty cycle, not concurrency (WARP-2850)", () => {
  it("refuses a manual corpus run that is too soon, and says how long", async () => {
    // Concurrency is already handled by the lease. This is about a caller who
    // re-fires the instant a run ENDS, holding the only inference slot at
    // ~100% with every call queued ahead of the user's next chat turn.
    const justRan = new Date(NOW.getTime() - 60_000);
    const out = await makeTrigger(justRan).trigger(CORPUS, { manual: true, now: NOW });
    expect(out).toEqual({ ok: false, reason: "too_soon", retryAfterMs: FIVE_MIN - 60_000 });
    expect(runWithLease).not.toHaveBeenCalled();
  });

  it("allows it once the interval has passed", async () => {
    const longAgo = new Date(NOW.getTime() - FIVE_MIN - 1000);
    await expect(
      makeTrigger(longAgo).trigger(CORPUS, { manual: true, now: NOW }),
    ).resolves.toEqual({ ok: true });
  });

  it("EXEMPTS the detector pass — it is bounded SQL with no model call", async () => {
    const justRan = new Date(NOW.getTime() - 1000);
    await expect(
      makeTrigger(justRan).trigger(DETECTOR, { manual: true, now: NOW }),
    ).resolves.toEqual({ ok: true });
  });

  it("does not rate-limit a SCHEDULED run", async () => {
    // The tick has its own cadence and the lease already stops overlap.
    const justRan = new Date(NOW.getTime() - 1000);
    await expect(makeTrigger(justRan).trigger(CORPUS, { now: NOW })).resolves.toEqual({
      ok: true,
    });
  });

  it("allows a manual run on a pass that has never run", async () => {
    await expect(
      makeTrigger(null).trigger(CORPUS, { manual: true, now: NOW }),
    ).resolves.toEqual({ ok: true });
  });
});

describe("scheduleBootRun (WARP-2850)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not fire immediately — boot is the worst moment for anything", async () => {
    const t = makeTrigger();
    const spy = vi.spyOn(t, "trigger");
    scheduleBootRun(t, DETECTOR, 30_000);
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(spy).toHaveBeenCalledWith(DETECTOR);
  });

  it("returns a handle so shutdown can cancel it", async () => {
    const t = makeTrigger();
    const spy = vi.spyOn(t, "trigger");
    const handle = scheduleBootRun(t, DETECTOR, 30_000);
    clearTimeout(handle);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("triggers it as a SCHEDULED run, so the rate limit never blocks a boot", async () => {
    const t = makeTrigger(new Date());
    const spy = vi.spyOn(t, "trigger");
    scheduleBootRun(t, DETECTOR, 1_000);
    await vi.advanceTimersByTimeAsync(1_500);
    // No `{ manual: true }` — a boot run is the box's own decision, not an
    // operator hammering a button.
    expect(spy).toHaveBeenCalledWith(DETECTOR);
  });
});
