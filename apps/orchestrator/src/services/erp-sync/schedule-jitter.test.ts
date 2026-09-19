/**
 * WARP-2218 — the jitter is a fleet-scale rate-limit control, so the property
 * under test is DETERMINISM, not randomness.
 *
 * Xero's limit is app-wide and pooled at 10,000 calls/min across every box we
 * ship, which saturates at roughly 1,250 boxes syncing on the same minute. The
 * spread has to hold, and it has to be explainable during an incident.
 */
import { describe, it, expect } from "vitest";

import { deriveScheduleJitterMs, jitteredPeriodMs } from "./schedule-jitter.js";

const PERIOD = 15 * 60 * 1000;

describe("deriveScheduleJitterMs", () => {
  it("gives two boxes different offsets for the same schedule", () => {
    // MUTATION: derive from Math.random() instead of the identity and this
    // still passes — which is why the stability case below exists beside it.
    const a = deriveScheduleJitterMs("droplet-aaaa", PERIOD);
    const b = deriveScheduleJitterMs("droplet-bbbb", PERIOD);
    expect(a).not.toBe(b);
  });

  it("gives the SAME box the same offset every time — across process restarts", () => {
    // The determinism assertion. MUTATION: replace the sha256 derivation with
    // `Math.random() * spanMs` and this goes red, because two calls in one
    // process already disagree — which is exactly what two boots would.
    const first = deriveScheduleJitterMs("droplet-serial-7", PERIOD);
    const second = deriveScheduleJitterMs("droplet-serial-7", PERIOD);
    const third = deriveScheduleJitterMs("droplet-serial-7", PERIOD);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it("bounds the offset by the span so a tick cannot pass its successor", () => {
    for (const id of ["a", "b", "droplet-001", "droplet-002", "droplet-999", ""]) {
      const offset = deriveScheduleJitterMs(id, PERIOD);
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(PERIOD);
    }
  });

  it("spreads sequentially-provisioned ids rather than clustering them", () => {
    // The one input distribution we can be certain of: a provisioning run
    // emits adjacent serials. A cheap multiplicative hash would put these in
    // adjacent slots and re-create the alignment the jitter exists to break.
    const ids = Array.from({ length: 20 }, (_, i) => `droplet-${String(i).padStart(3, "0")}`);
    const buckets = new Set(
      ids.map((id) => Math.floor(deriveScheduleJitterMs(id, PERIOD) / (PERIOD / 10))),
    );
    expect(buckets.size).toBeGreaterThanOrEqual(5);
  });

  it("returns 0 for a non-positive span rather than dividing by zero", () => {
    expect(deriveScheduleJitterMs("box", 0)).toBe(0);
    expect(deriveScheduleJitterMs("box", -1)).toBe(0);
  });
});

describe("jitteredPeriodMs", () => {
  it("keeps the effective period inside the stated band", () => {
    const p = jitteredPeriodMs(PERIOD, "droplet-x", 0.25);
    expect(p).toBeGreaterThanOrEqual(PERIOD);
    expect(p).toBeLessThan(PERIOD * 1.25);
  });

  it("gives two boxes periods that never re-align", () => {
    const a = jitteredPeriodMs(PERIOD, "box-one");
    const b = jitteredPeriodMs(PERIOD, "box-two");
    expect(a).not.toBe(b);
  });

  it("is stable for one identity", () => {
    expect(jitteredPeriodMs(PERIOD, "box-one")).toBe(jitteredPeriodMs(PERIOD, "box-one"));
  });
});
