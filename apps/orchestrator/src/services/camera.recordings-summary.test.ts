/**
 * WARP-1958 — the recordings summary normaliser.
 *
 * The payload in `FRIGATE_0_17_SUMMARY` is a verbatim capture from
 * Frigate 0.17.1 on the production box (2026-08-13), trimmed to the
 * fields we consume. Its shape is the entire point of these tests:
 * `hours` is an ARRAY, ordered newest-first, and each element carries
 * its own hour as a STRING. The previous implementation ran
 * `Object.entries()` over it and used the key — the array INDEX — as the
 * hour, so the timeline was silently reversed and every playback range
 * it produced pointed at the wrong time.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchRecordingsSummary = vi.hoisted(() => vi.fn());

vi.mock("./frigate.client.js", () => ({
  fetchRecordingsSummary,
}));

// `vi.mock` is hoisted above imports, so a static import here still gets
// the mocked client — and unlike a top-level `await import`, it
// typechecks under the package's CommonJS module setting.
import { getRecordingsSummary } from "./camera.service.js";

/** Verbatim from `GET /api/<cam>/recordings/summary` on Frigate 0.17.1. */
const FRIGATE_0_17_SUMMARY = [
  {
    day: "2026-08-13",
    events: 21,
    hours: [
      { hour: "15", events: 0, motion: 11, objects: 0, duration: 2859 },
      { hour: "14", events: 0, motion: 3, objects: 0, duration: 3586 },
      { hour: "13", events: 0, motion: 954, objects: 0, duration: 3586 },
      { hour: "12", events: 0, motion: 160, objects: 0, duration: 3587 },
      { hour: "11", events: 0, motion: 0, objects: 0, duration: 3586 },
      { hour: "04", events: 3, motion: 774, objects: 75, duration: 3586 },
    ],
  },
];

describe("getRecordingsSummary — Frigate 0.17 array shape", () => {
  beforeEach(() => {
    fetchRecordingsSummary.mockReset();
  });

  it("takes the hour from the entry, not from its position in the array", async () => {
    fetchRecordingsSummary.mockResolvedValue(FRIGATE_0_17_SUMMARY);

    const [day] = await getRecordingsSummary("cam");
    const hours = day.hours.map((h) => h.hour);

    // Index-keyed parsing would produce [0,1,2,3,4,5]. The real hours are
    // these, and the array's newest-first order must not survive into the
    // output — the timeline renders left-to-right by hour.
    expect(hours).toEqual([4, 11, 12, 13, 14, 15]);
    expect(hours).not.toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("keeps each hour's own stats attached to that hour", async () => {
    fetchRecordingsSummary.mockResolvedValue(FRIGATE_0_17_SUMMARY);

    const [day] = await getRecordingsSummary("cam");
    const byHour = new Map(day.hours.map((h) => [h.hour, h]));

    // Hour 13 is the busy one (motion 954). Under index-keying its stats
    // landed on hour 2 — the graphic was not just relabelled, the values
    // moved with it.
    expect(byHour.get(13)?.motion).toBe(954);
    expect(byHour.get(15)?.duration).toBe(2859);
    expect(byHour.get(4)?.events).toBe(3);
    expect(byHour.get(4)?.objects).toBe(75);
  });

  it("reports a fully-recorded hour with no motion as having footage", async () => {
    fetchRecordingsSummary.mockResolvedValue(FRIGATE_0_17_SUMMARY);

    const [day] = await getRecordingsSummary("cam");
    const quiet = day.hours.find((h) => h.hour === 11);

    // 3586s of continuous footage over a still scene. Anything keyed on
    // motion calls this hour empty; `duration` is what makes it visible.
    expect(quiet?.motion).toBe(0);
    expect(quiet?.duration).toBeGreaterThan(3500);
  });

  it("preserves motion magnitude instead of clamping it to 0-100", async () => {
    fetchRecordingsSummary.mockResolvedValue([
      {
        day: "2026-08-13",
        events: 0,
        hours: [
          { hour: "01", motion: { value: 42 }, duration: 3600 },
          { hour: "02", motion: -5, duration: 3600 },
          { hour: "03", motion: 954, duration: 3600 },
          { hour: "04", motion: 774, duration: 3600 },
          { hour: "05", duration: 3600 },
        ],
      },
    ]);

    const [day] = await getRecordingsSummary("cam");
    const byHour = new Map(day.hours.map((h) => [h.hour, h.motion]));

    expect(byHour.get(1)).toBe(42); // object-valued variant
    expect(byHour.get(2)).toBe(0); // negatives floored, not passed through
    expect(byHour.get(5)).toBe(0); // absent

    // The two busy hours must stay DISTINGUISHABLE. A 0-100 clamp makes
    // both 100, which is why the heat-map had no range at the top end.
    expect(byHour.get(3)).toBe(954);
    expect(byHour.get(4)).toBe(774);
    expect(byHour.get(3)).not.toBe(byHour.get(4));
  });
});

describe("getRecordingsSummary — legacy dict shape", () => {
  beforeEach(() => {
    fetchRecordingsSummary.mockReset();
  });

  it("still keys off the dict key when entries carry no hour field", async () => {
    fetchRecordingsSummary.mockResolvedValue([
      {
        day: "2026-08-12",
        events: 4,
        duration: 7200,
        hours: {
          "09": { events: 1, motion: 20, duration: 3600 },
          "17": { events: 3, motion: 60, duration: 3600 },
        },
      },
    ]);

    const [day] = await getRecordingsSummary("cam");

    expect(day.hours.map((h) => h.hour)).toEqual([9, 17]);
    expect(day.hours.find((h) => h.hour === 17)?.events).toBe(3);
  });

  it("prefers the entry's own hour over a disagreeing dict key", async () => {
    // Defensive: if a build ever emits both, the value that travels with
    // the stats is the one that describes them.
    fetchRecordingsSummary.mockResolvedValue([
      {
        day: "2026-08-12",
        hours: { "0": { hour: "22", events: 2, duration: 3600 } },
      },
    ]);

    const [day] = await getRecordingsSummary("cam");
    expect(day.hours.map((h) => h.hour)).toEqual([22]);
  });

  it("drops entries whose hour cannot be resolved rather than inventing one", async () => {
    fetchRecordingsSummary.mockResolvedValue([
      {
        day: "2026-08-12",
        hours: [
          { hour: "not-an-hour", duration: 3600 },
          { hour: "99", duration: 3600 },
          { hour: "07", duration: 3600 },
        ],
      },
    ]);

    const [day] = await getRecordingsSummary("cam");
    expect(day.hours.map((h) => h.hour)).toEqual([7]);
  });

  it("passes the caller's timezone through to Frigate", async () => {
    fetchRecordingsSummary.mockResolvedValue([]);

    await getRecordingsSummary("cam", "America/Los_Angeles");

    // Without this, Frigate buckets in UTC while the browser builds
    // playback ranges in local time — a 7-hour disagreement for a PDT
    // operator, which is how a click on 15:00 asked for 22:00 UTC.
    expect(fetchRecordingsSummary).toHaveBeenCalledWith("cam", "America/Los_Angeles");
  });
});
