/**
 * WARP-2979 (ADR-059 P4 §6.12.3) — the chat tools' periods, resolved on the
 * server. PURE: no I/O, no clock (the caller passes `now`), no process zone.
 *
 * The model names a period in words (`last_night`) or gives two instants
 * WITH their offset; the server turns either into `[from, to]` in the SITE
 * zone, so the model never converts a time:
 *
 *   · last_hour / last_24h / last_7_days — back from now; need no zone.
 *   · today — site-local midnight to now.
 *   · last_night — with opening hours: the most recent CLOSED spell that
 *     started at or before now, from its close to the next opening (or to
 *     now, while it is still closed). Without hours, or hours that never
 *     change within the look-back: 6 PM yesterday to 8 AM today, site-local
 *     (to now, before 8 AM).
 *   · today and last_night with no site zone → NO_SITE_TIMEZONE: the tool
 *     asks for exact times rather than guess the zone.
 *   · from/to — ISO-8601 WITH an offset (an offset-less time is the model
 *     guessing the zone); `to` defaults to now and is clamped to it; the
 *     span is at most 30 days and `from` is never older than the caller's
 *     retention floor.
 *
 * No period and no from/to is `null`: no window at all, newest first.
 */
import { lastChangeAtOrBefore, scheduledModeAt, siteDayClockCopy, type SiteHours } from "./security-hours.js";
import { localPartsOf, ymdAddDays, zonedDateMinuteToUtc } from "./zoned-time.js";

export const ASSISTANT_PERIODS = ["last_hour", "today", "last_night", "last_24h", "last_7_days"] as const;
export type AssistantPeriodName = (typeof ASSISTANT_PERIODS)[number];

/** The widest from/to a tool may ask for. */
export const ASSISTANT_SPAN_MAX_MS = 30 * 24 * 3_600_000;

const H = 3_600_000;
const BACK_FROM_NOW: Readonly<Record<"last_hour" | "last_24h" | "last_7_days", { ms: number; label: string }>> = {
  last_hour: { ms: H, label: "the last hour" },
  last_24h: { ms: 24 * H, label: "the last 24 hours" },
  last_7_days: { ms: 7 * 24 * H, label: "the last 7 days" },
};

/** The no-hours night, site-local: 18:00 yesterday to 08:00 today. */
const NIGHT_FROM_MIN = 18 * 60;
const NIGHT_TO_MIN = 8 * 60;

/** ISO-8601 with an explicit offset (`Z` or `±HH:MM`), seconds and millis optional. */
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface AssistantSite {
  hours: SiteHours;
  /** The site zone (hours set), else the workspace's (`resolveSecurityTimezone`); null when neither is known. */
  timezone: string | null;
}

export interface AssistantPeriodInput {
  period?: string;
  from?: string;
  to?: string;
}

export interface ResolvedAssistantPeriod {
  from: Date;
  to: Date;
  /** Plain words for the window ("last night", "the last hour"); from/to reads "the times asked for". */
  label: string;
}

export type AssistantPeriodResult =
  | { ok: true; period: ResolvedAssistantPeriod | null }
  | { ok: false; code: "BAD_REQUEST" | "NO_SITE_TIMEZONE"; message: string };

/** An instant as every tool returns it: the ISO time, and the site-local copy ("Tue 2:14 AM") when the zone is known. */
export function assistantInstant(at: Date, tz: string | null, now: Date): { at: string; local: string | null } {
  return { at: at.toISOString(), local: tz ? siteDayClockCopy(at, tz, now) : null };
}

const bad = (message: string): AssistantPeriodResult => ({ ok: false, code: "BAD_REQUEST", message });

/**
 * One instant WITH its offset, or null. Exported for A5's `at` (WARP-2980
 * PR-E): the same rule as from/to, so an offset-less time is refused there too.
 */
export function parseAssistantInstant(raw: string): Date | null {
  if (!ISO_WITH_OFFSET.test(raw)) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The no-hours night in `tz`, ending at `now` at the latest. */
function plainNight(tz: string, now: Date): ResolvedAssistantPeriod {
  const today = localPartsOf(now, tz).ymd;
  const from = zonedDateMinuteToUtc(ymdAddDays(today, -1), NIGHT_FROM_MIN, tz);
  const morning = zonedDateMinuteToUtc(today, NIGHT_TO_MIN, tz);
  return { from, to: new Date(Math.min(morning.getTime(), now.getTime())), label: "last night" };
}

/** The most recent closed spell that started at or before `now`; null when the hours never change within the look-back. */
function closedSpell(hours: SiteHours, now: Date): ResolvedAssistantPeriod | null {
  if (hours.state !== "set") return null;
  if (scheduledModeAt(hours, now) === "closed") {
    const closedAt = lastChangeAtOrBefore(hours, now);
    return closedAt ? { from: closedAt, to: now, label: "last night" } : null;
  }
  const openedAt = lastChangeAtOrBefore(hours, now);
  if (!openedAt) return null;
  const closedAt = lastChangeAtOrBefore(hours, new Date(openedAt.getTime() - 1));
  return closedAt ? { from: closedAt, to: openedAt, label: "last night" } : null;
}

export function resolveAssistantPeriod(
  input: AssistantPeriodInput,
  site: AssistantSite,
  now: Date,
  /** The oldest instant the caller still keeps (retention). */
  oldest: Date,
): AssistantPeriodResult {
  const hasRange = input.from !== undefined || input.to !== undefined;
  if (input.period !== undefined && hasRange) return bad("Give a period or from/to, not both.");

  if (input.period !== undefined) {
    const name = input.period;
    if (name === "last_hour" || name === "last_24h" || name === "last_7_days") {
      const { ms, label } = BACK_FROM_NOW[name];
      return { ok: true, period: { from: new Date(now.getTime() - ms), to: now, label } };
    }
    if (name !== "today" && name !== "last_night") {
      return bad(`period must be one of ${ASSISTANT_PERIODS.join(", ")}.`);
    }
    const tz = site.timezone;
    if (!tz) {
      return { ok: false, code: "NO_SITE_TIMEZONE", message: "Droplet doesn't know this site's time zone. Ask for exact times instead." };
    }
    if (name === "today") {
      return { ok: true, period: { from: zonedDateMinuteToUtc(localPartsOf(now, tz).ymd, 0, tz), to: now, label: "today" } };
    }
    return { ok: true, period: closedSpell(site.hours, now) ?? plainNight(tz, now) };
  }

  if (!hasRange) return { ok: true, period: null };
  if (input.from === undefined) return bad("to needs a from.");
  const from = parseAssistantInstant(input.from);
  const to = input.to === undefined ? now : parseAssistantInstant(input.to);
  if (!from || !to) return bad("from and to must be ISO-8601 times with an offset, like 2026-09-22T21:00:00+01:00.");
  const end = new Date(Math.min(to.getTime(), now.getTime()));
  if (from.getTime() >= end.getTime()) return bad("from must be before to, and in the past.");
  if (end.getTime() - from.getTime() > ASSISTANT_SPAN_MAX_MS) return bad("from and to can be at most 30 days apart.");
  if (from.getTime() < oldest.getTime()) return bad("from is older than Droplet keeps this.");
  return { ok: true, period: { from, to: end, label: "the times asked for" } };
}
