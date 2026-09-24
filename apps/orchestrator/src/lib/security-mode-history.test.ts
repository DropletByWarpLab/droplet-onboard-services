/**
 * WARP-2978 (ADR-059 P3 spec §6.4, D20) — the site mode at an instant, from
 * the `mode_changed` rows plus the stored state and the hours.
 *
 *   · a row after t → the EARLIEST one's fromMode (never the latest row ≤ t:
 *     that reads the wrong mode whenever the ticker lags a boundary);
 *   · no row after t → resolveMode(stored, hours, t), which covers a lagging
 *     ticker, a manual mode that expired (`>=`) and an Open up that ended;
 *   · hours unreadable → the stored mode, labelled `stored_fallback`.
 *
 * Pure; every case runs with the process zone unset and in Pacific/Kiritimati
 * (UTC+14), like the evaluator's own tests.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modeAt, nonOpenWithin, parseModeRow, type ModeHistoryRow, type ModeTimeline } from "./security-mode-history.js";
import type { ModeFields } from "./security-mode.js";
import { hhmmToMinutes, weekFrom, type DayHours, type SiteHours } from "./security-hours.js";
import { zonedWallClockToUtc } from "./zoned-time.js";

const ORIGINAL_TZ = process.env.TZ;
const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PROCESS_ZONES: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["Pacific/Kiritimati", "Pacific/Kiritimati"],
];

const TZ = "Europe/London";
const closedDay: DayHours = { kind: "closed" };
const nineToFive: DayHours = { kind: "hours", opensMin: hhmmToMinutes("09:00")!, closesMin: hhmmToMinutes("17:00")! };
/** Mon–Fri 09:00–17:00, Europe/London. 2026-09-23 is a Wednesday. */
const HOURS: SiteHours = {
  state: "set",
  timezone: TZ,
  week: weekFrom(([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, ...(weekday <= 5 ? nineToFive : closedDay) }))),
  exceptions: new Map(),
};
const NOT_SET: SiteHours = { state: "not_set" };

function at(ymd: string, time: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return zonedWallClockToUtc(y!, mo!, d!, h!, mi!, 0, TZ);
}
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

const schedule = (mode: "open" | "closed"): ModeFields => ({ mode, modeSource: "schedule", manualEnd: "none", manualUntil: null });
const row = (when: Date, mode: ModeHistoryRow["mode"], source: ModeHistoryRow["source"], fromMode: ModeHistoryRow["fromMode"]): ModeHistoryRow => ({
  at: when,
  mode,
  source,
  fromMode,
});

const WED_1659 = at("2026-09-23", "16:59");
const WED_17 = at("2026-09-23", "17:00");
const WED_1730 = at("2026-09-23", "17:30");
const WED_20 = at("2026-09-23", "20:00");
const WED_2130 = at("2026-09-23", "21:30");
const WED_NOON = at("2026-09-23", "12:00");

describe.each(PROCESS_ZONES)("security mode history — process TZ %s", (_label, zone) => {
  beforeAll(() => {
    if (zone) process.env.TZ = zone;
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ ?? SYSTEM_ZONE;
  });

  describe("modeAt", () => {
    it("a row after t answers with the EARLIEST such row's fromMode — not the latest row at or before t", () => {
      // Closed by the schedule at 17:00 (row written), then Maria set Away at 21:30.
      const tl: ModeTimeline = {
        stored: { mode: "away", modeSource: "manual", manualEnd: "until_changed", manualUntil: null },
        hours: HOURS,
        rows: [row(WED_17, "closed", "schedule", "open"), row(WED_2130, "away", "manual", "closed")],
      };
      expect(modeAt(tl, WED_20)).toEqual({ mode: "closed", source: "schedule" });
      // Before the 17:00 row: that row's fromMode.
      expect(modeAt(tl, WED_1659).mode).toBe("open");
      // AT a row's instant the new mode applies.
      expect(modeAt(tl, WED_17).mode).toBe("closed");
    });

    it("ticker lag: no row yet for the 17:00 close, the stored row still says open → the schedule says closed at 17:30", () => {
      // The stored row and the only mode row are from this morning's opening.
      const tl: ModeTimeline = {
        stored: schedule("open"),
        hours: HOURS,
        rows: [row(at("2026-09-23", "09:00"), "open", "schedule", "closed")],
      };
      expect(modeAt(tl, WED_1730)).toEqual({ mode: "closed", source: "schedule" });
      expect(modeAt(tl, WED_NOON)).toEqual({ mode: "open", source: "schedule" });
    });

    it("an Open up that expired: at manualUntil (>=) the schedule answers again", () => {
      const until = at("2026-09-23", "19:00");
      const tl: ModeTimeline = {
        stored: { mode: "open", modeSource: "manual", manualEnd: "at_time", manualUntil: until },
        hours: HOURS,
        rows: [row(WED_1730, "open", "manual", "closed")],
      };
      expect(modeAt(tl, plus(until, -1))).toEqual({ mode: "open", source: "manual" });
      expect(modeAt(tl, until)).toEqual({ mode: "closed", source: "schedule" });
      expect(modeAt(tl, WED_20)).toEqual({ mode: "closed", source: "schedule" });
    });

    it("Close up then Open up: each instant reads the mode between its rows", () => {
      const closeUp = at("2026-09-23", "14:00");
      const openUp = at("2026-09-23", "15:00");
      const tl: ModeTimeline = {
        stored: { mode: "open", modeSource: "manual", manualEnd: "at_time", manualUntil: at("2026-09-23", "16:00") },
        hours: HOURS,
        rows: [row(closeUp, "closed", "manual", "open"), row(openUp, "open", "manual", "closed")],
      };
      expect(modeAt(tl, at("2026-09-23", "13:59")).mode).toBe("open");
      expect(modeAt(tl, at("2026-09-23", "14:30"))).toEqual({ mode: "closed", source: "manual" });
      expect(modeAt(tl, at("2026-09-23", "15:30"))).toEqual({ mode: "open", source: "manual" });
    });

    it("hours unreadable → the stored mode, labelled stored_fallback", () => {
      const tl: ModeTimeline = { stored: schedule("closed"), hours: null, rows: [] };
      expect(modeAt(tl, WED_NOON)).toEqual({ mode: "closed", source: "stored_fallback" });
    });

    it("hours not set and no manual mode → open all the time", () => {
      const tl: ModeTimeline = { stored: schedule("open"), hours: NOT_SET, rows: [] };
      expect(modeAt(tl, WED_2130)).toEqual({ mode: "open", source: "schedule" });
    });

    it("a history answer whose previous row is not loaded says `unknown` for the source, never a guess", () => {
      const tl: ModeTimeline = { stored: schedule("open"), hours: HOURS, rows: [row(at("2026-09-24", "09:00"), "open", "schedule", "closed")] };
      expect(modeAt(tl, WED_20)).toEqual({ mode: "closed", source: "unknown" });
    });
  });

  describe("nonOpenWithin", () => {
    const tl: ModeTimeline = { stored: schedule("closed"), hours: HOURS, rows: [row(WED_17, "closed", "schedule", "open")] };

    it("closed at the start → the start", () => {
      expect(nonOpenWithin(tl, WED_20, plus(WED_20, 60_000))).toEqual({ at: WED_20, mode: "closed", source: "schedule" });
    });

    it("open at the start, closed at the end (a straddle) → the first non-open instant inside, the row", () => {
      expect(nonOpenWithin(tl, plus(WED_17, -120_000), plus(WED_17, 60_000))).toEqual({
        at: WED_17,
        mode: "closed",
        source: "schedule",
      });
    });

    it("a straddle the ticker has not written yet is still caught at the end", () => {
      const lag: ModeTimeline = { stored: schedule("open"), hours: HOURS, rows: [] };
      const end = plus(WED_17, 30_000);
      expect(nonOpenWithin(lag, plus(WED_17, -60_000), end)).toEqual({ at: end, mode: "closed", source: "schedule" });
    });

    it("a closed spell strictly inside an open span is caught at its row", () => {
      const inside: ModeTimeline = {
        stored: schedule("open"),
        hours: HOURS,
        rows: [row(at("2026-09-23", "12:10"), "closed", "manual", "open"), row(at("2026-09-23", "12:20"), "open", "schedule", "closed")],
      };
      expect(nonOpenWithin(inside, WED_NOON, at("2026-09-23", "12:30"))).toEqual({
        at: at("2026-09-23", "12:10"),
        mode: "closed",
        source: "manual",
      });
    });

    it("open throughout → null", () => {
      expect(nonOpenWithin(tl, WED_NOON, plus(WED_NOON, 600_000))).toBeNull();
    });
  });

  describe("parseModeRow", () => {
    it("reads [mode, modeSource, fromMode]", () => {
      expect(parseModeRow({ startedAt: WED_17, labels: ["closed", "schedule", "open"] })).toEqual(row(WED_17, "closed", "schedule", "open"));
    });

    it.each([
      [["closed", "schedule"]],
      [["shut", "schedule", "open"]],
      [["closed", "someone", "open"]],
      [["closed", "schedule", "closed"]],
    ])("refuses %j (the CHECK's shape, re-checked)", (labels) => {
      expect(parseModeRow({ startedAt: WED_17, labels })).toBeNull();
    });
  });
});
