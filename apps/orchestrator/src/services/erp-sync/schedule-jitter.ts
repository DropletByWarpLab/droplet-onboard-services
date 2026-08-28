/**
 * WARP-2218 — deterministic per-box schedule jitter for the connector sync
 * poller.
 *
 * ## Why this exists (do not "simplify" it away)
 *
 * On-prem appliances align on round times. Every box boots its poller, waits
 * the same interval, and hits the vendor on the same minute — and the vendor
 * limit that matters is not per-customer.
 *
 * **Xero's rate limit is app-wide and pooled: 10,000 calls per minute across
 * every box we ship.** Divide that by the ~8 calls one connection's sync tick
 * costs and the pool saturates at roughly 1,250 boxes syncing on the same
 * minute — regardless of how modest each individual box's usage is. It is not
 * a limit a customer can be moved off, and it is not one we can raise per
 * install. Spreading the fleet across the interval is the only lever we own.
 *
 * ## Why derived, not `Math.random()`
 *
 * `Math.random()` at call time would spread the fleet too, and would be
 * untestable and unexplainable. During an incident the question is "why did
 * THIS box call at THAT moment", and a derived offset answers it: the same
 * device identity always lands in the same slot, across process restarts and
 * across `docker restart`. A random one gives a shrug.
 *
 * `sync-policy.ts:132-147` applies full jitter over the top 50% to *retry*
 * backoff with an injectable `random`; this is the same idea applied to the
 * *steady-state* schedule, and follows the same injectable shape — the device
 * identity is passed in, never read from `process.env` at module import. This
 * repo has been bitten by module-import config reads that a `docker restart`
 * cannot change (`INFERENCE_RUNTIME`), and a schedule offset frozen at import
 * would be exactly that bug again.
 */
import { createHash } from "node:crypto";

/**
 * Map a device identity into a stable offset in `[0, spanMs)`.
 *
 * SHA-256 rather than a hand-rolled string hash: the derivation has to spread
 * evenly across the span for the fleet argument above to hold, and adjacent
 * device ids (`droplet-001`, `droplet-002` — exactly the shape a provisioning
 * run produces) must not land in adjacent slots. A cheap multiplicative hash
 * clusters on sequential inputs, which is the one input distribution we can
 * be certain of.
 *
 * Six bytes (48 bits) is far more than the span ever needs and stays inside
 * `Number.MAX_SAFE_INTEGER`, so the modulo is exact rather than quietly
 * losing precision.
 */
export function deriveScheduleJitterMs(deviceId: string, spanMs: number): number {
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 0;
  const digest = createHash("sha256").update(deviceId, "utf8").digest();
  const slice = digest.subarray(0, 6).toString("hex");
  return Number.parseInt(slice, 16) % Math.floor(spanMs);
}

/**
 * The interval this box actually schedules on.
 *
 * The offset is applied to the PERIOD rather than as a one-off start delay,
 * which is deliberate. A start delay spreads a fleet that booted together and
 * then lets it re-converge the moment boxes reboot at different times (a
 * regional power cut re-aligns them precisely when the vendor is least able to
 * absorb it). Jittering the period means two boxes never share a period at
 * all, so they drift apart and stay apart no matter when either one booted.
 *
 * The offset is bounded by `jitterFraction` of the base period — never the
 * whole period — so a tick can never be pushed past its own successor and the
 * effective cadence stays within a stated band of what the operator configured.
 */
export function jitteredPeriodMs(
  basePeriodMs: number,
  deviceId: string,
  jitterFraction = 0.25,
): number {
  const span = Math.floor(basePeriodMs * jitterFraction);
  return basePeriodMs + deriveScheduleJitterMs(deviceId, span);
}
