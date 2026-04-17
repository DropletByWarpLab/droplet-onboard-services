import { describe, it, expect } from "vitest";
import { computeDesiredBlocked } from "./schedule.service.js";

// Test fixtures — Tuesday 2026-04-14 10:00 local
const NOW = new Date("2026-04-14T10:00:00");

const device = (overrides?: Partial<any>) => ({
  mac: "AA:BB:CC:DD:EE:FF",
  manualBlock: false,
  groups: [{ id: "g1", name: "Kids" }],
  ...overrides,
});

const window = (d: number, s: number, e: number) => ({ daysOfWeek: d, startMin: s, endMin: e });
const tueWorkHours = window(4, 9 * 60, 17 * 60); // Tuesday 9am-5pm

describe("computeDesiredBlocked", () => {
  it("returns false when nothing applies", () => {
    expect(
      computeDesiredBlocked({
        device: device(),
        deviceSchedules: [],
        groupSchedules: [],
        activeOverrides: [],
        now: NOW,
      }),
    ).toEqual({ blocked: false, reason: "schedule_window_end" });
  });

  it("override action=block wins over everything", () => {
    expect(
      computeDesiredBlocked({
        device: device({ manualBlock: true }),
        deviceSchedules: [
          { id: "s1", enabled: true, subjectType: "device", windows: [tueWorkHours] },
        ],
        groupSchedules: [],
        activeOverrides: [{ id: "o1", action: "block", startAt: NOW, endAt: NOW }],
        now: NOW,
      }),
    ).toEqual({ blocked: true, reason: "override_applied" });
  });

  it("override action=allow wins over manualBlock", () => {
    expect(
      computeDesiredBlocked({
        device: device({ manualBlock: true }),
        deviceSchedules: [],
        groupSchedules: [
          { id: "s1", enabled: true, subjectType: "group", windows: [tueWorkHours] },
        ],
        activeOverrides: [{ id: "o1", action: "allow", startAt: NOW, endAt: NOW }],
        now: NOW,
      }),
    ).toEqual({ blocked: false, reason: "override_applied" });
  });

  it("override block wins over override allow if both present", () => {
    expect(
      computeDesiredBlocked({
        device: device(),
        deviceSchedules: [],
        groupSchedules: [],
        activeOverrides: [
          { id: "o1", action: "allow", startAt: NOW, endAt: NOW },
          { id: "o2", action: "block", startAt: NOW, endAt: NOW },
        ],
        now: NOW,
      }),
    ).toEqual({ blocked: true, reason: "override_applied" });
  });

  it("manualBlock wins when no active overrides", () => {
    expect(
      computeDesiredBlocked({
        device: device({ manualBlock: true }),
        deviceSchedules: [
          { id: "s1", enabled: true, subjectType: "device", windows: [tueWorkHours] },
        ],
        groupSchedules: [],
        activeOverrides: [],
        now: NOW,
      }),
    ).toEqual({ blocked: true, reason: "manual_block" });
  });

  it("device schedule active → blocked (device-level precedence)", () => {
    expect(
      computeDesiredBlocked({
        device: device(),
        deviceSchedules: [
          { id: "sd", enabled: true, subjectType: "device", windows: [tueWorkHours] },
        ],
        groupSchedules: [
          {
            id: "sg",
            enabled: true,
            subjectType: "group",
            windows: [
              window(4, 0, 9 * 60), // Tuesday midnight-9am (should be ignored — device schedule wins)
            ],
          },
        ],
        activeOverrides: [],
        now: NOW,
      }),
    ).toEqual({ blocked: true, reason: "schedule_window_start" });
  });

  it("device has NO device-level schedule → group schedule evaluated", () => {
    expect(
      computeDesiredBlocked({
        device: device(),
        deviceSchedules: [],
        groupSchedules: [
          { id: "sg", enabled: true, subjectType: "group", windows: [tueWorkHours] },
        ],
        activeOverrides: [],
        now: NOW,
      }),
    ).toEqual({ blocked: true, reason: "schedule_window_start" });
  });

  it("device has device-level schedule (inactive now) → group schedule ignored", () => {
    expect(
      computeDesiredBlocked({
        device: device(),
        deviceSchedules: [
          {
            id: "sd",
            enabled: true,
            subjectType: "device",
            windows: [
              window(4, 18 * 60, 22 * 60), // Tue 6pm-10pm
            ],
          },
        ],
        groupSchedules: [
          { id: "sg", enabled: true, subjectType: "group", windows: [tueWorkHours] },
        ],
        activeOverrides: [],
        now: NOW,
      }),
    ).toEqual({ blocked: false, reason: "schedule_window_end" });
  });

  it("disabled schedule is ignored", () => {
    expect(
      computeDesiredBlocked({
        device: device(),
        deviceSchedules: [
          { id: "sd", enabled: false, subjectType: "device", windows: [tueWorkHours] },
        ],
        groupSchedules: [],
        activeOverrides: [],
        now: NOW,
      }),
    ).toEqual({ blocked: false, reason: "schedule_window_end" });
  });
});
