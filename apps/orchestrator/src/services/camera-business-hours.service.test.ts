import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { BUSINESS_HOURS_KEY, cameraBusinessHoursSchema, emptyCameraBusinessHours,
  getCameraBusinessHours, isOutsideBusinessHours, saveCameraBusinessHours,
  type CameraBusinessHours } from "./camera-business-hours.service.js";

const epoch = (iso: string) => Date.parse(iso) / 1000;
function schedule(timezone = "America/Los_Angeles"): CameraBusinessHours {
  const hours = emptyCameraBusinessHours();
  hours.configured = true;
  hours.timezone = timezone;
  for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday"] as const) {
    hours.days[day] = { open: "09:00", close: "17:00" };
  }
  return hours;
}

describe("camera business hours", () => {
  it("leaves activity unclassified until a schedule is saved", () => {
    expect(isOutsideBusinessHours(emptyCameraBusinessHours(), epoch("2026-10-05T18:00:00Z"))).toBeNull();
  });
  it("uses the saved timezone with opening inclusive and closing exclusive", () => {
    const hours = schedule();
    expect(isOutsideBusinessHours(hours, epoch("2026-10-05T15:59:59Z"))).toBe(true);
    expect(isOutsideBusinessHours(hours, epoch("2026-10-05T16:00:00Z"))).toBe(false);
    expect(isOutsideBusinessHours(hours, epoch("2026-10-06T00:00:00Z"))).toBe(true);
    expect(isOutsideBusinessHours(hours, epoch("2026-10-10T17:00:00Z"))).toBe(true);
  });
  it("classifies the whole span, including activity crossing closing time", () => {
    const hours = schedule();
    const start = epoch("2026-10-05T23:59:00Z");
    expect(isOutsideBusinessHours(hours, start, epoch("2026-10-06T00:00:00Z"))).toBe(false);
    expect(isOutsideBusinessHours(hours, start, epoch("2026-10-06T00:00:00.001Z"))).toBe(true);
    expect(isOutsideBusinessHours(hours, start, null, epoch("2026-10-06T00:01:00Z"))).toBe(true);
    expect(isOutsideBusinessHours(hours, epoch("2026-10-05T16:00:00Z"), epoch("2026-10-06T16:01:00Z"))).toBe(true);
  });
  it("carries an overnight opening into a closed following day and across Sunday", () => {
    const hours = emptyCameraBusinessHours();
    hours.configured = true;
    hours.days.friday = { open: "22:00", close: "06:00" };
    hours.days.sunday = { open: "22:00", close: "06:00" };
    expect(isOutsideBusinessHours(hours, epoch("2026-10-10T05:59:00Z"))).toBe(false);
    expect(isOutsideBusinessHours(hours, epoch("2026-10-10T06:00:00Z"))).toBe(true);
    expect(isOutsideBusinessHours(hours, epoch("2026-10-05T02:00:00Z"))).toBe(false);
  });
  it("handles spring-forward gaps without inventing missing local minutes", () => {
    const hours = schedule();
    hours.days.sunday = { open: "01:00", close: "04:00" };
    expect(isOutsideBusinessHours(hours, epoch("2026-03-08T09:00:00Z"), epoch("2026-03-08T11:00:00Z"))).toBe(false);
    hours.days.sunday = { open: "01:00", close: "02:30" };
    expect(isOutsideBusinessHours(hours, epoch("2026-03-08T09:00:00Z"), epoch("2026-03-08T10:00:00Z"))).toBe(false);
    expect(isOutsideBusinessHours(hours, epoch("2026-03-08T09:00:00Z"), epoch("2026-03-08T10:01:00Z"))).toBe(true);
  });
  it("handles repeated fall-back minutes inside a span whose endpoints are open", () => {
    const hours = schedule();
    hours.days.sunday = { open: "01:30", close: "02:30" };
    expect(isOutsideBusinessHours(hours, epoch("2026-11-01T08:30:00Z"))).toBe(false);
    expect(isOutsideBusinessHours(hours, epoch("2026-11-01T09:30:00Z"))).toBe(false);
    expect(isOutsideBusinessHours(hours, epoch("2026-11-01T08:30:00Z"), epoch("2026-11-01T09:45:00Z"))).toBe(true);
    hours.days.sunday = { open: "00:00", close: "04:00" };
    expect(isOutsideBusinessHours(hours, epoch("2026-11-01T08:30:00Z"), epoch("2026-11-01T09:45:00Z"))).toBe(false);
  });
  it("supports explicitly closed weeks and 24-hour days", () => {
    const hours = emptyCameraBusinessHours();
    hours.configured = true;
    expect(isOutsideBusinessHours(hours, epoch("2026-10-05T02:00:00Z"))).toBe(true);
    hours.days.monday = { open: "00:00", close: "24:00" };
    expect(isOutsideBusinessHours(hours, epoch("2026-10-05T23:59:00Z"))).toBe(false);
    expect(isOutsideBusinessHours(hours, epoch("2026-10-06T00:00:00Z"))).toBe(true);
  });
  it("rejects ambiguous times, invalid zones and incomplete weeks", () => {
    const hours = schedule();
    expect(cameraBusinessHoursSchema.safeParse({ ...hours, timezone: "Not/A_Zone" }).success).toBe(false);
    for (const window of [{ open: "9:00", close: "17:00" }, { open: "24:00", close: "17:00" },
      { open: "09:00", close: "09:00" }, { open: "09:00", close: "24:01" }]) {
      expect(cameraBusinessHoursSchema.safeParse({ ...hours, days: { ...hours.days, monday: window } }).success).toBe(false);
    }
    expect(cameraBusinessHoursSchema.safeParse({ ...hours, days: { monday: null } }).success).toBe(false);
  });
  it("roundtrips one persistent SystemFlag and never persists invalid input", async () => {
    let stored: unknown;
    const upsert = vi.fn(async (args: { create: { valueJson: unknown } }) => { stored = args.create.valueJson; });
    const prisma = { systemFlag: { upsert, findUnique: vi.fn(async () => stored === undefined ? null : { valueJson: stored }) } } as unknown as PrismaClient;
    expect(await getCameraBusinessHours(prisma)).toEqual(emptyCameraBusinessHours());
    const hours = schedule();
    expect(await saveCameraBusinessHours(prisma, hours)).toEqual(hours);
    expect(await getCameraBusinessHours(prisma)).toEqual(hours);
    expect(upsert.mock.calls[0][0]).toMatchObject({ where: { key: BUSINESS_HOURS_KEY } });
    await expect(saveCameraBusinessHours(prisma, { ...hours, timezone: "invalid" })).rejects.toThrow();
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
