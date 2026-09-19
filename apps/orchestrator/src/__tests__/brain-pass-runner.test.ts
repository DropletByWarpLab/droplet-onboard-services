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
  type TriggerReason,
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

function makeTrigger(
  lastRunAt: Date | null = null,
  preconditions?: Record<string, () => TriggerReason | null | Promise<TriggerReason | null>>,
) {
  return createBrainPassTrigger({
    prisma: prismaWith(lastRunAt),
    runners: { [DETECTOR]: detectorRun, [CORPUS]: corpusRun },
    manualMinIntervalMs: { [CORPUS]: FIVE_MIN },
    preconditions,
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

describe("preconditions — checked BEFORE the claim (WARP-2850 review)", () => {
  // 🔴 THE ORDERING IS THE WHOLE POINT, and getting it wrong was a real
  // regression on this branch. `claimPass` stamps `runState: "running"`,
  // `claimedAt` AND `lastRunAt` in one atomic `updateMany` that lands BEFORE
  // `run()` is ever called. So a "this box cannot do this pass at all" check
  // that lives inside the runner marks a run that never happened: the route
  // answers 202 `{status:"started"}`, the row reads `running`, and `lastRunAt`
  // moves — which then silently spends the `too_soon` budget of the first real
  // run, once the box is finally configured.
  //
  // These cases pin the check on the OTHER side of the claim, where a refusal
  // is a refusal.
  const noModel = { [CORPUS]: () => "no_model" as const };

  it("refuses with the precondition's own reason", async () => {
    await expect(makeTrigger(null, noModel).trigger(CORPUS)).resolves.toEqual({
      ok: false,
      reason: "no_model",
    });
  });

  it("🔴 never claims — so runState and lastRunAt do not move", async () => {
    await makeTrigger(null, noModel).trigger(CORPUS, { manual: true, now: NOW });
    expect(runWithLease).not.toHaveBeenCalled();
    expect(corpusRun).not.toHaveBeenCalled();
  });

  it("refuses a SCHEDULED tick too, not just a manual one", async () => {
    // The tick is the caller that runs hourly forever. If only the manual path
    // were guarded, `lastRunAt` would still crawl forward on its own.
    await makeTrigger(null, noModel).trigger(CORPUS);
    expect(runWithLease).not.toHaveBeenCalled();
  });

  it("is checked BEFORE the rate limit, so the refusal is the true one", async () => {
    // Both would refuse; only one of them is honest. "Just ran, try again in
    // 4 min" on a box with no model configured sends an operator away to wait
    // for something that is never going to work.
    const justRan = new Date(NOW.getTime() - 60_000);
    const out = await makeTrigger(justRan, noModel).trigger(CORPUS, {
      manual: true,
      now: NOW,
    });
    expect(out).toEqual({ ok: false, reason: "no_model" });
  });

  it("claims as normal once the precondition is satisfied", async () => {
    const ok = { [CORPUS]: () => null };
    await expect(makeTrigger(null, ok).trigger(CORPUS)).resolves.toEqual({ ok: true });
    expect(runWithLease).toHaveBeenCalledOnce();
  });

  // WARP-2838 — the master switch is a `BrainSetting` ROW, so asking whether
  // the brain is on is a database read. A precondition may therefore return a
  // promise, and `trigger()` has to await it. Left un-awaited the refusal is a
  // truthy Promise object, so these tests would still see a refusal — but of
  // the wrong shape, and any precondition resolving to `null` would refuse the
  // pass forever. Both directions are pinned.
  it("AWAITS an async precondition's refusal, and reports its reason", async () => {
    const asyncOff = { [CORPUS]: async () => "disabled" as const };
    await expect(makeTrigger(null, asyncOff).trigger(CORPUS)).resolves.toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(runWithLease).not.toHaveBeenCalled();
  });

  it("🔴 an async precondition resolving to null must CLAIM, not refuse", async () => {
    // The direction an un-awaited promise breaks silently: `Promise<null>` is
    // truthy, so a satisfied async precondition would refuse every run and the
    // pass would never fire again.
    const asyncOk = { [CORPUS]: async () => null };
    await expect(makeTrigger(null, asyncOk).trigger(CORPUS)).resolves.toEqual({ ok: true });
    expect(runWithLease).toHaveBeenCalledOnce();
  });

  it("leaves a pass with no precondition of its own alone", async () => {
    await expect(makeTrigger(null, noModel).trigger(DETECTOR)).resolves.toEqual({ ok: true });
    expect(runWithLease).toHaveBeenCalledOnce();
  });
});

describe("shutdown, seen from the trigger (WARP-2837 + WARP-2850)", () => {
  it("passes `shutting_down` through as itself, not as `busy`", async () => {
    // WARP-2837's latch hands a claim straight back when the process is on its
    // way out. That is a THIRD answer — not contention, not a switched-off
    // pass — and `trigger` must not flatten it into the default.
    runWithLease.mockResolvedValueOnce({ started: false, reason: "shutting_down" } as never);
    await expect(makeTrigger().trigger(CORPUS)).resolves.toEqual({
      ok: false,
      reason: "shutting_down",
    });
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

  it("reports a claim that THROWS instead of leaving an untagged rejection", async () => {
    // 🔴 NOTHING AWAITS THE BOOT RUN. `trigger` rejects if the claim's DB round
    // trip fails — and a boot run lands while migrations may still be settling,
    // which is the likeliest moment for exactly that. A rejection with no
    // subscriber became an untagged `unhandledRejection`: the process survives,
    // because index.ts installs a handler, but the failure arrived without its
    // passKey and without saying it was the boot run that hit it. Same reason
    // `runWithLease` catches its own run rather than asking every caller to
    // remember a `.catch`.
    const t = makeTrigger();
    vi.spyOn(t, "trigger").mockRejectedValueOnce(new Error("db down"));
    const onDone = vi.fn();
    const onError = vi.fn();
    scheduleBootRun(t, DETECTOR, 1_000, onDone, onError);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onError).toHaveBeenCalledOnce();
    expect((onError.mock.calls[0]![0] as Error).message).toBe("db down");
    expect(onDone).not.toHaveBeenCalled();
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
