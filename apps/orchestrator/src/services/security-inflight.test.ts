/**
 * WARP-2978 PR-D (ADR-059 P3 spec §6.12) — the in-flight map: who is due a
 * "still in view" row (30 s, the score gate, once), and its bounds (256
 * entries with the oldest evicted, 6 h, a camera or Frigate going offline).
 * The engine's half — writing the row and holding the incident open — is in
 * security-incidents.early-presence.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  createInflightTracker,
  INFLIGHT_END_GRACE_MS,
  INFLIGHT_MAX_AGE_MS,
  INFLIGHT_MAX_ENTRIES,
} from "./security-inflight.js";
import { SECURITY_MIN_SCORE, SECURITY_ONGOING_AFTER_MS } from "./security-event-ingest.js";

const T0 = new Date("2026-09-23T21:14:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

function msg(type: "new" | "update" | "end", after: Record<string, unknown> = {}) {
  return {
    type,
    before: {},
    after: {
      id: "1790000000.1-abc",
      camera: "back",
      label: "person",
      start_time: T0.getTime() / 1000,
      end_time: null,
      top_score: 0.9,
      false_positive: false,
      entered_zones: [],
      ...after,
    },
  };
}

describe("due — a person tracked for 30 s, once", () => {
  it("is due at 30 s, not at 29.999 s", () => {
    const t = createInflightTracker();
    t.observe(msg("new"), T0);
    expect(t.due(plus(T0, SECURITY_ONGOING_AFTER_MS - 1))).toEqual([]);
    expect(t.due(plus(T0, SECURITY_ONGOING_AFTER_MS))).toEqual([
      { id: "1790000000.1-abc", camera: "back", label: "person", startedAt: T0, topScore: 0.9, enteredZones: [] },
    ]);
  });

  it("30 s from when Frigate started tracking — not from when Droplet first heard", () => {
    const t = createInflightTracker();
    // Droplet (re)starts 25 s into a track: due 5 s later, not 30.
    t.observe(msg("update"), plus(T0, 25_000));
    expect(t.due(plus(T0, 30_000))).toHaveLength(1);
  });

  it("is never due again once its row is written", () => {
    const t = createInflightTracker();
    t.observe(msg("new"), T0);
    expect(t.due(plus(T0, 30_000))).toHaveLength(1);
    t.markWritten("1790000000.1-abc");
    t.observe(msg("update", { top_score: 0.95 }), plus(T0, 35_000));
    expect(t.due(plus(T0, 40_000))).toEqual([]);
    expect(t.due(plus(T0, 600_000))).toEqual([]);
  });

  it("needs the best score so far at the detection gate — and it may get there later", () => {
    const t = createInflightTracker();
    t.observe(msg("new", { top_score: SECURITY_MIN_SCORE - 0.01 }), T0);
    expect(t.due(plus(T0, 40_000))).toEqual([]);
    t.observe(msg("update", { top_score: SECURITY_MIN_SCORE }), plus(T0, 41_000));
    expect(t.due(plus(T0, 42_000))).toMatchObject([{ topScore: SECURITY_MIN_SCORE }]);
  });

  it("keeps the BEST score: a later lower one does not lower it", () => {
    const t = createInflightTracker();
    t.observe(msg("new", { top_score: 0.9 }), T0);
    t.observe(msg("update", { top_score: 0.5 }), plus(T0, 10_000));
    expect(t.due(plus(T0, 30_000))).toMatchObject([{ topScore: 0.9 }]);
  });

  it("a missing score is never due; neither is Frigate's own false positive", () => {
    const t = createInflightTracker();
    t.observe(msg("new", { id: "a.1-x", top_score: null }), T0);
    t.observe(msg("new", { id: "b.1-x", false_positive: true }), T0);
    expect(t.due(plus(T0, 60_000))).toEqual([]);
    t.observe(msg("update", { id: "b.1-x", false_positive: false }), plus(T0, 61_000));
    expect(t.due(plus(T0, 62_000)).map((o) => o.id)).toEqual(["b.1-x"]);
  });

  it("gathers the zones entered across updates", () => {
    const t = createInflightTracker();
    t.observe(msg("new", { entered_zones: ["porch"] }), T0);
    t.observe(msg("update", { entered_zones: ["till"] }), plus(T0, 5_000));
    expect(t.due(plus(T0, 30_000))).toMatchObject([{ enteredZones: ["porch", "till"] }]);
  });

  it("persons only: a car or a dog is never tracked (a parked car would fill the map)", () => {
    const t = createInflightTracker();
    t.observe(msg("new", { id: "car.1-x", label: "car" }), T0);
    t.observe(msg("new", { id: "dog.1-x", label: "dog" }), T0);
    expect(t.size()).toBe(0);
    // Relabelled away from person mid-track: forgotten.
    t.observe(msg("new"), T0);
    t.observe(msg("update", { label: "dog" }), plus(T0, 5_000));
    expect(t.size()).toBe(0);
    expect(t.due(plus(T0, 60_000))).toEqual([]);
  });
});

describe("end, and the grace that lets the end row join", () => {
  it("end forgets the person: never due", () => {
    const t = createInflightTracker();
    t.observe(msg("new"), T0);
    t.observe(msg("end", { end_time: T0.getTime() / 1000 + 20 }), plus(T0, 20_000));
    expect(t.size()).toBe(0);
    expect(t.due(plus(T0, 60_000))).toEqual([]);
    expect(t.inView("1790000000.1-abc", plus(T0, 21_000))).toBe(false);
  });

  it("in view while tracked; after the end, only for the grace — and only when its row was written", () => {
    const t = createInflightTracker();
    t.observe(msg("new"), T0);
    expect(t.inView("1790000000.1-abc", plus(T0, 1_000))).toBe(true);
    t.markWritten("1790000000.1-abc");
    const end = plus(T0, 600_000);
    t.observe(msg("end"), end);
    expect(t.inView("1790000000.1-abc", plus(end, INFLIGHT_END_GRACE_MS - 1))).toBe(true);
    expect(t.inView("1790000000.1-abc", plus(end, INFLIGHT_END_GRACE_MS))).toBe(false);

    const u = createInflightTracker();
    u.observe(msg("new"), T0);
    u.observe(msg("end"), plus(T0, 10_000));
    expect(u.inView("1790000000.1-abc", plus(T0, 10_001))).toBe(false);
  });
});

describe("the bounds: 256 entries, 6 hours, a camera or Frigate going offline", () => {
  it("holds at most 256 people; the oldest is evicted", () => {
    const t = createInflightTracker();
    for (let k = 0; k < INFLIGHT_MAX_ENTRIES + 3; k++) t.observe(msg("new", { id: `p${k}.1-x` }), plus(T0, k));
    expect(t.size()).toBe(INFLIGHT_MAX_ENTRIES);
    const due = t.due(plus(T0, 60_000)).map((o) => o.id);
    expect(due).not.toContain("p0.1-x");
    expect(due).not.toContain("p2.1-x");
    expect(due).toContain("p3.1-x");
    expect(due).toContain(`p${INFLIGHT_MAX_ENTRIES + 2}.1-x`);
  });

  it("an update of a known person evicts nobody", () => {
    const t = createInflightTracker({ maxEntries: 2 });
    t.observe(msg("new", { id: "a.1-x" }), T0);
    t.observe(msg("new", { id: "b.1-x" }), T0);
    t.observe(msg("update", { id: "a.1-x" }), plus(T0, 1_000));
    expect(t.due(plus(T0, 60_000)).map((o) => o.id)).toEqual(["a.1-x", "b.1-x"]);
  });

  it("tracking that started more than 6 h ago is dropped, and never let back in", () => {
    const t = createInflightTracker();
    t.observe(msg("new"), T0);
    const late = plus(T0, INFLIGHT_MAX_AGE_MS + 1);
    expect(t.inView("1790000000.1-abc", late)).toBe(false);
    expect(t.due(late)).toEqual([]);
    expect(t.size()).toBe(0);
    t.observe(msg("update"), late);
    expect(t.size()).toBe(0);
    // Exactly 6 h is still in.
    const u = createInflightTracker();
    u.observe(msg("new"), T0);
    expect(u.due(plus(T0, INFLIGHT_MAX_AGE_MS))).toHaveLength(1);
  });

  it("a camera going offline forgets its people only; Frigate going offline (source_offline) forgets everyone", () => {
    const t = createInflightTracker();
    t.observe(msg("new", { id: "a.1-x", camera: "back" }), T0);
    t.observe(msg("new", { id: "b.1-x", camera: "front" }), T0);
    t.forgetCamera("back");
    expect(t.due(plus(T0, 60_000)).map((o) => o.id)).toEqual(["b.1-x"]);
    t.forgetCamera(null);
    expect(t.size()).toBe(0);
    expect(t.due(plus(T0, 60_000))).toEqual([]);
  });

  it("ignores what is not a well-formed Frigate object message", () => {
    const t = createInflightTracker();
    t.observe({ type: "new", after: { id: "a b" } }, T0);
    t.observe("junk", T0);
    t.observe(null, T0);
    expect(t.size()).toBe(0);
  });
});
