/**
 * WARP-2977 P2b — lib/security-mode.ts: the effective mode and what each
 * action does to it (spec §6.3's table), over (source × manualEnd × action ×
 * hours state × scheduled mode). Pure; every case runs under three process
 * zones like the evaluator's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  effectiveSince,
  isManualExpired,
  modeChangeSummary,
  planModeAction,
  resolveMode,
  sameModeFields,
  type ModeFields,
} from "./security-mode.js";
import { hhmmToMinutes, weekFrom, type DayHours, type SiteHours } from "./security-hours.js";
import { zonedWallClockToUtc } from "./zoned-time.js";

const ORIGINAL_TZ = process.env.TZ;
const SYSTEM_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const PROCESS_ZONES: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["Pacific/Kiritimati", "Pacific/Kiritimati"],
  ["Pacific/Pago_Pago", "Pacific/Pago_Pago"],
];

const TZ = "Europe/London";
const closed: DayHours = { kind: "closed" };
const nineToFive: DayHours = { kind: "hours", opensMin: hhmmToMinutes("09:00")!, closesMin: hhmmToMinutes("17:00")! };
/** Mon–Fri 09:00–17:00, Europe/London. 2026-09-23 is a Wednesday. */
const HOURS: SiteHours = {
  state: "set",
  timezone: TZ,
  week: weekFrom(([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, ...(weekday <= 5 ? nineToFive : closed) }))),
  exceptions: new Map(),
};
const NEVER_OPEN: SiteHours = {
  state: "set",
  timezone: TZ,
  week: weekFrom(([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, ...closed }))),
  exceptions: new Map(),
};
const ALWAYS_OPEN: SiteHours = {
  state: "set",
  timezone: TZ,
  week: weekFrom(([1, 2, 3, 4, 5, 6, 7] as const).map((weekday) => ({ weekday, kind: "open_all_day" as const }))),
  exceptions: new Map(),
};
const NOT_SET: SiteHours = { state: "not_set" };

function at(ymd: string, time: string): Date {
  const [y, mo, d] = ymd.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  return zonedWallClockToUtc(y!, mo!, d!, h!, mi!, 0, TZ);
}

const schedule = (mode: "open" | "closed"): ModeFields => ({ mode, modeSource: "schedule", manualEnd: "none", manualUntil: null });
const closedUntil = (until: Date): ModeFields => ({ mode: "closed", modeSource: "manual", manualEnd: "next_opening", manualUntil: until });
const closedUntilChanged: ModeFields = { mode: "closed", modeSource: "manual", manualEnd: "until_changed", manualUntil: null };
const openUntil = (until: Date): ModeFields => ({ mode: "open", modeSource: "manual", manualEnd: "at_time", manualUntil: until });
const away: ModeFields = { mode: "away", modeSource: "manual", manualEnd: "until_changed", manualUntil: null };

const WED_NOON = at("2026-09-23", "12:00");
const WED_20 = at("2026-09-23", "20:00");
const THU_0830 = at("2026-09-24", "08:30");
const THU_09 = at("2026-09-24", "09:00");

describe.each(PROCESS_ZONES)("security-mode — process TZ %s", (_label, zone) => {
  beforeAll(() => {
    if (zone) process.env.TZ = zone;
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ ?? SYSTEM_ZONE;
  });

  describe("resolveMode", () => {
    it("schedule follows the hours; not set reads open", () => {
      expect(resolveMode(schedule("open"), HOURS, WED_20)).toMatchObject({ mode: "closed", source: "schedule" });
      expect(resolveMode(schedule("closed"), HOURS, WED_NOON)).toMatchObject({ mode: "open", source: "schedule" });
      expect(resolveMode(schedule("closed"), NOT_SET, WED_20)).toMatchObject({ mode: "open", source: "schedule" });
    });

    it("a manual mode that ends at a time ends AT manualUntil (>=), not a moment later", () => {
      const s = closedUntil(THU_09);
      expect(resolveMode(s, HOURS, new Date(THU_09.getTime() - 1))).toEqual({
        mode: "closed",
        source: "manual",
        manualEnd: "next_opening",
        manualUntil: THU_09,
      });
      expect(resolveMode(s, HOURS, THU_09)).toEqual({ mode: "open", source: "schedule", manualEnd: "none", manualUntil: null });
      expect(isManualExpired(s, THU_09)).toBe(true);
      expect(isManualExpired(openUntil(THU_09), THU_09)).toBe(true);
    });

    it("until-changed modes never expire", () => {
      const later = at("2027-09-23", "12:00");
      expect(resolveMode(away, HOURS, later)).toMatchObject({ mode: "away", source: "manual" });
      expect(resolveMode(closedUntilChanged, HOURS, later)).toMatchObject({ mode: "closed", source: "manual" });
      expect(isManualExpired(away, later)).toBe(false);
    });
  });

  describe("planModeAction — close", () => {
    it("in hours → closed until tomorrow's opening", () => {
      const p = planModeAction(schedule("open"), HOURS, { action: "close" }, WED_NOON);
      expect(p).toMatchObject({ changed: true, next: closedUntil(THU_09) });
    });

    it("with no hours set → closed until someone changes it", () => {
      expect(planModeAction(schedule("open"), NOT_SET, { action: "close" }, WED_NOON)).toMatchObject({
        changed: true,
        next: closedUntilChanged,
      });
    });

    it("with no opening ahead (open around the clock) → until changed", () => {
      expect(planModeAction(schedule("open"), ALWAYS_OPEN, { action: "close" }, WED_NOON)).toMatchObject({
        changed: true,
        next: closedUntilChanged,
      });
    });

    it("from Away while hours that never open have it closed → back to the hours", () => {
      expect(planModeAction(away, NEVER_OPEN, { action: "close" }, WED_NOON)).toMatchObject({ changed: true, next: schedule("closed") });
    });

    it("while the hours already have it closed → changed:false", () => {
      const p = planModeAction(schedule("closed"), HOURS, { action: "close" }, WED_20);
      expect(p.changed).toBe(false);
      expect(p.next).toEqual(schedule("closed"));
    });

    it("an expired stored override that the hours now close → changed:false (effective, not stored)", () => {
      expect(planModeAction(openUntil(at("2026-09-23", "19:00")), HOURS, { action: "close" }, WED_20).changed).toBe(false);
    });

    it("after hours, from a manual Open up, Away or closed-until-changed → back to the hours (closed)", () => {
      for (const current of [openUntil(at("2026-09-23", "22:00")), away, closedUntilChanged]) {
        expect(planModeAction(current, HOURS, { action: "close" }, WED_20)).toMatchObject({ changed: true, next: schedule("closed") });
      }
    });

    it("already closed up until the next opening → changed:false", () => {
      expect(planModeAction(closedUntil(THU_09), HOURS, { action: "close" }, WED_NOON).changed).toBe(false);
      expect(planModeAction(closedUntil(THU_09), HOURS, { action: "close" }, WED_20).changed).toBe(false);
    });
  });

  describe("planModeAction — open", () => {
    it("Open up 2 h at 20:00 → open until 22:00", () => {
      expect(planModeAction(schedule("closed"), HOURS, { action: "open", for: "2h" }, WED_20)).toMatchObject({
        changed: true,
        next: openUntil(at("2026-09-23", "22:00")),
      });
    });

    it("Open up 2 h at 08:30 with a 09:00 opening → capped at 09:00", () => {
      expect(planModeAction(schedule("closed"), HOURS, { action: "open", for: "2h" }, THU_0830).next).toEqual(openUntil(THU_09));
    });

    it("1 h and 4 h", () => {
      expect(planModeAction(away, HOURS, { action: "open", for: "1h" }, WED_20).next).toEqual(openUntil(at("2026-09-23", "21:00")));
      expect(planModeAction(away, HOURS, { action: "open", for: "4h" }, WED_20).next).toEqual(openUntil(at("2026-09-24", "00:00")));
    });

    it("never open again ahead → uncapped, still bounded by the hours chosen", () => {
      expect(planModeAction(schedule("closed"), NEVER_OPEN, { action: "open", for: "4h" }, WED_20).next).toEqual(
        openUntil(new Date(WED_20.getTime() + 4 * 3_600_000)),
      );
    });

    it("while the hours have it open: ends a manual mode; otherwise changed:false", () => {
      expect(planModeAction(closedUntil(THU_09), HOURS, { action: "open", for: "2h" }, WED_NOON)).toMatchObject({
        changed: true,
        next: schedule("open"),
      });
      expect(planModeAction(schedule("open"), HOURS, { action: "open", for: "2h" }, WED_NOON).changed).toBe(false);
    });

    it("with no hours set (open all the time): ends Away, else changed:false", () => {
      expect(planModeAction(away, NOT_SET, { action: "open", for: "1h" }, WED_20)).toMatchObject({ changed: true, next: schedule("open") });
      expect(planModeAction(schedule("open"), NOT_SET, { action: "open", for: "1h" }, WED_20).changed).toBe(false);
    });
  });

  describe("planModeAction — away and resume", () => {
    it("away from anything but away; away again is changed:false", () => {
      expect(planModeAction(schedule("open"), HOURS, { action: "away" }, WED_NOON)).toMatchObject({ changed: true, next: away });
      expect(planModeAction(closedUntil(THU_09), HOURS, { action: "away" }, WED_NOON)).toMatchObject({ changed: true, next: away });
      expect(planModeAction(away, HOURS, { action: "away" }, WED_NOON).changed).toBe(false);
    });

    it("resume → the hours' mode now; already following them → changed:false", () => {
      expect(planModeAction(away, HOURS, { action: "resume" }, WED_20)).toMatchObject({ changed: true, next: schedule("closed") });
      expect(planModeAction(away, HOURS, { action: "resume" }, WED_NOON)).toMatchObject({ changed: true, next: schedule("open") });
      expect(planModeAction(schedule("open"), HOURS, { action: "resume" }, WED_NOON).changed).toBe(false);
      // A stale stored row that already expired is "following the hours".
      expect(planModeAction(closedUntil(WED_NOON), HOURS, { action: "resume" }, WED_20).changed).toBe(false);
    });
  });

  describe("effectiveSince", () => {
    const setAt = at("2026-09-23", "10:00");
    it("stored = effective → the stored setAt", () => {
      expect(effectiveSince({ ...schedule("open"), setAt }, HOURS, WED_NOON)).toEqual(setAt);
    });

    it("an expired override → the moment it ended", () => {
      expect(effectiveSince({ ...closedUntil(THU_09), setAt }, HOURS, at("2026-09-24", "09:00"))).toEqual(THU_09);
      // Ticker down past a later boundary: stamped at the later boundary.
      expect(effectiveSince({ ...openUntil(at("2026-09-23", "12:30")), setAt }, HOURS, WED_20)).toEqual(at("2026-09-23", "17:00"));
    });

    it("a schedule flip not yet written → the last boundary, never before setAt, never after now", () => {
      expect(effectiveSince({ ...schedule("open"), setAt }, HOURS, WED_20)).toEqual(at("2026-09-23", "17:00"));
      const lateSetAt = at("2026-09-23", "18:00");
      expect(effectiveSince({ ...schedule("open"), setAt: lateSetAt }, HOURS, WED_20)).toEqual(lateSetAt);
      const futureSetAt = at("2026-09-23", "23:00");
      expect(effectiveSince({ ...schedule("open"), setAt: futureSetAt }, HOURS, WED_20)).toEqual(WED_20);
    });
  });

  it("modeChangeSummary: the feed row's words, times in the site zone", () => {
    expect(modeChangeSummary(schedule("closed"), { type: "schedule" }, TZ)).toBe("Closed (opening hours)");
    expect(modeChangeSummary(schedule("open"), { type: "hours_changed" }, null)).toBe("Open (opening hours changed)");
    expect(modeChangeSummary(closedUntil(THU_09), { type: "user", name: "Maria" }, TZ)).toBe("Closed up by Maria");
    expect(modeChangeSummary(openUntil(at("2026-09-23", "21:00")), { type: "user", name: "Maria" }, TZ)).toBe(
      "Opened by Maria until 9:00 PM",
    );
    expect(modeChangeSummary(away, { type: "user", name: "Stefan" }, TZ)).toBe("Set to away by Stefan");
    expect(modeChangeSummary(schedule("open"), { type: "user", name: "Maria" }, TZ)).toBe("Back to opening hours (Maria)");
  });

  it("sameModeFields compares manualUntil by instant", () => {
    expect(sameModeFields(closedUntil(new Date(THU_09.getTime())), closedUntil(THU_09))).toBe(true);
    expect(sameModeFields(closedUntil(THU_09), closedUntil(new Date(THU_09.getTime() + 1)))).toBe(false);
    expect(sameModeFields(closedUntilChanged, closedUntil(THU_09))).toBe(false);
  });
});
