import type { PrismaClient } from "@prisma/client";
import { z } from "zod";

export const BUSINESS_HOURS_KEY = "cameras.business_hours";
export const BUSINESS_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type BusinessDay = (typeof BUSINESS_DAYS)[number];
export interface BusinessHoursWindow { open: string; close: string }
export interface CameraBusinessHours {
  configured: boolean;
  timezone: string;
  days: Record<BusinessDay, BusinessHoursWindow | null>;
}
export type BusinessHoursFilter = "outside" | "inside";

const opening = /^([01]\d|2[0-3]):[0-5]\d$/;
const closing = /^(?:([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const windowSchema = z.object({ open: z.string().regex(opening), close: z.string().regex(closing) })
  .strict().refine((v) => v.open !== v.close, { message: "Opening and closing times must differ" }).nullable();
const daysSchema = z.object({ monday: windowSchema, tuesday: windowSchema, wednesday: windowSchema,
  thursday: windowSchema, friday: windowSchema, saturday: windowSchema, sunday: windowSchema }).strict();
export const cameraBusinessHoursSchema = z.object({
  configured: z.boolean(),
  timezone: z.string().min(1).max(64).refine((value) => {
    if (!/^[A-Za-z][A-Za-z0-9+_\-]*(\/[A-Za-z0-9+_\-]+)*$/.test(value)) return false;
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
  }, { message: "Choose a valid IANA timezone" }),
  days: daysSchema,
}).strict();

export function emptyCameraBusinessHours(): CameraBusinessHours {
  return { configured: false, timezone: "UTC", days: { monday: null, tuesday: null, wednesday: null,
    thursday: null, friday: null, saturday: null, sunday: null } };
}

export async function getCameraBusinessHours(prisma: PrismaClient): Promise<CameraBusinessHours> {
  const row = await prisma.systemFlag.findUnique({ where: { key: BUSINESS_HOURS_KEY } });
  if (!row) return emptyCameraBusinessHours();
  // Corrupt settings must not label activity safe under an invented schedule.
  return cameraBusinessHoursSchema.parse(row.valueJson);
}

export async function saveCameraBusinessHours(prisma: PrismaClient, input: unknown): Promise<CameraBusinessHours> {
  const hours = cameraBusinessHoursSchema.parse(input);
  const valueJson = { ...hours, days: { ...hours.days } };
  await prisma.systemFlag.upsert({ where: { key: BUSINESS_HOURS_KEY },
    create: { key: BUSINESS_HOURS_KEY, valueJson }, update: { valueJson } });
  return hours;
}

const WEEK_MINUTES = 7 * 24 * 60;
const WEEK_SECONDS = WEEK_MINUTES * 60;
// 1970-01-05 00:00 UTC was Monday, the weekly schedule's index zero.
const MONDAY_EPOCH = 4 * 24 * 60 * 60;
const minuteOfDay = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

/** Compile once per listing. Any activity outside the saved windows is marked
 * outside; opening is inclusive, closing exclusive. Overnight windows belong
 * to their opening day. Local wall time comes from the saved zone, not the box.
 * Offset changes split spans, so missing/repeated DST minutes are skipped or
 * counted exactly as they occur. */
export function createBusinessHoursClassifier(hours: CameraBusinessHours):
  (start: number, end: number | null, now?: number) => boolean | null {
  if (!hours.configured) return () => null;
  const open = new Uint8Array(WEEK_MINUTES);
  for (let day = 0; day < BUSINESS_DAYS.length; day++) {
    const window = hours.days[BUSINESS_DAYS[day]];
    if (!window) continue;
    const start = minuteOfDay(window.open);
    let end = minuteOfDay(window.close);
    if (end < start) end += 1440;
    for (let minute = start; minute < end; minute++) open[(day * 1440 + minute) % WEEK_MINUTES] = 1;
  }
  const closedPrefix = new Uint32Array(WEEK_MINUTES + 1);
  for (let i = 0; i < WEEK_MINUTES; i++) closedPrefix[i + 1] = closedPrefix[i] + (open[i] ? 0 : 1);
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: hours.timezone, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const offsetAt = (epoch: number): number => {
    const fields: Record<string, number> = {};
    for (const part of formatter.formatToParts(new Date(epoch * 1000))) {
      if (part.type !== "literal") fields[part.type] = Number(part.value);
    }
    return Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second) / 1000 - Math.floor(epoch);
  };
  // Integral of closed wall-clock seconds since Monday. Subtraction handles
  // partial minutes, midnight, overnight windows and arbitrary multi-day spans.
  const closedUntil = (wallEpoch: number): number => {
    const relative = wallEpoch - MONDAY_EPOCH;
    const weeks = Math.floor(relative / WEEK_SECONDS);
    const inWeek = relative - weeks * WEEK_SECONDS;
    const minute = Math.floor(inWeek / 60);
    return weeks * closedPrefix[WEEK_MINUTES] * 60 + closedPrefix[minute] * 60
      + (open[minute] ? 0 : inWeek - minute * 60);
  };
  return (start, end, now = Date.now() / 1000) => {
    if (!Number.isFinite(start)) return null;
    const finish = end === null ? Math.max(start, now) : end;
    if (!Number.isFinite(finish) || finish < start) return null;
    if (closedPrefix[WEEK_MINUTES] === 0) return false;
    if (closedPrefix[WEEK_MINUTES] === WEEK_MINUTES) return true;
    let cursor = start;
    let offset = offsetAt(cursor);
    if (finish === start) return closedUntil(start + offset + 0.001) > closedUntil(start + offset);
    while (cursor < finish) {
      // Current IANA zones have at most one offset transition per UTC day.
      let boundary = Math.min(finish, cursor + 86400);
      const nextOffset = offsetAt(boundary);
      if (nextOffset !== offset) {
        let low = Math.floor(cursor), high = Math.ceil(boundary);
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (offsetAt(middle) === offset) low = middle; else high = middle;
        }
        boundary = high;
      }
      if (closedUntil(boundary + offset) - closedUntil(cursor + offset) > 0) return true;
      cursor = boundary;
      offset = offsetAt(cursor);
    }
    return false;
  };
}

export function isOutsideBusinessHours(hours: CameraBusinessHours, start: number, end: number | null = start,
  now?: number): boolean | null {
  return createBusinessHoursClassifier(hours)(start, end, now);
}
