/**
 * WARP-3266 — expand recurring ICS events into stored occurrences.
 *
 * A subscribed feed's weekly meeting used to be stored as its first instance
 * only. `expandIcsEvents` turns the parsed feed into the rows `syncSource`
 * persists: one row per occurrence inside a bounded window, keyed stably so a
 * re-sync updates rather than duplicates.
 *
 * No RRULE library is installed in the repo, so this implements the subset
 * real feeds (Google, Outlook, iCloud) emit: FREQ DAILY/WEEKLY/MONTHLY/YEARLY,
 * INTERVAL, COUNT, UNTIL, BYDAY (ordinals for MONTHLY, and YEARLY with
 * BYMONTH), BYMONTHDAY, BYMONTH and WKST, plus EXDATE and RECURRENCE-ID
 * overrides (a STATUS:CANCELLED override removes its instance). Anything else
 * (BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR…, sub-daily FREQ) is NOT guessed: the
 * series is stored as its first instance with `recurrence = "unexpanded"`, so
 * clients can say "repeats" instead of the series vanishing. RDATE is ignored.
 *
 * Keys: a non-recurring event keeps its UID (unchanged from before). An
 * occurrence is `<UID>::<original start ISO>` — the RECURRENCE-ID value — so a
 * moved instance keeps its row, and an override lands on the row the master
 * generated.
 */

import { localPartsOf, zonedWallClockToUtc } from "../lib/zoned-time.js";
import { parseIcsDateTime, type IcsEvent } from "./ics.js";

export type Recurrence = "none" | "occurrence" | "unexpanded";

export interface ExpandedIcsEvent extends IcsEvent {
  /** Idempotency key persisted as `CalendarEvent.externalUid`. */
  key: string;
  recurrence: Recurrence;
}

export const RECURRENCE_PAST_MONTHS = 12;
export const RECURRENCE_FUTURE_MONTHS = 18;
/** Per series. A daily series over the 30-month window is ~915. */
export const MAX_OCCURRENCES_PER_SERIES = 1000;
/** Per sync. Feeds may be 50 MB; past this, further series are stored
 *  unexpanded (marked) rather than growing the table without bound. */
export const MAX_OCCURRENCES_PER_FEED = 50_000;
/** Loop guard: periods walked from DTSTART (a daily series since 1970 fits). */
const MAX_PERIODS = 25_000;

export const OCCURRENCE_KEY_SEPARATOR = "::";

const DAY_MS = 86_400_000;
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]; // index 0 = Monday

type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";

interface Rule {
  freq: Freq;
  interval: number;
  count?: number;
  /** UNTIL as an instant, or as a day for the DATE form. */
  until?: { at: number } | { ymd: string };
  byDay?: Array<{ n: number; wd: number }>;
  byMonthDay?: number[];
  byMonth?: number[];
  wkst: number;
}

const SUPPORTED = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "WKST"]);

function ints(v: string, min: number, max: number): number[] | null {
  const out = v.split(",").map((x) => Number(x.trim()));
  return out.every((n) => Number.isInteger(n) && n !== 0 && Math.abs(n) >= min && Math.abs(n) <= max)
    ? out
    : null;
}

/** Parse the supported subset. `null` ⇒ outside the subset (store unexpanded). */
export function parseRrule(text: string, tzid: string | undefined): Rule | null {
  const parts = new Map<string, string>();
  for (const p of text.trim().replace(/^RRULE:/i, "").split(";")) {
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) return null;
    parts.set(p.slice(0, eq).toUpperCase(), p.slice(eq + 1).trim());
  }
  for (const k of parts.keys()) if (!SUPPORTED.has(k)) return null;
  const freq = parts.get("FREQ")?.toUpperCase();
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const rule: Rule = { freq, interval: 1, wkst: 0 };

  const interval = parts.get("INTERVAL");
  if (interval !== undefined) {
    rule.interval = Number(interval);
    if (!Number.isInteger(rule.interval) || rule.interval < 1) return null;
  }
  const count = parts.get("COUNT");
  if (count !== undefined) {
    rule.count = Number(count);
    if (!Number.isInteger(rule.count) || rule.count < 1) return null;
  }
  const until = parts.get("UNTIL");
  if (until !== undefined) {
    if (/^\d{8}$/.test(until)) {
      rule.until = { ymd: `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` };
    } else {
      // RFC 5545: UNTIL is UTC when DTSTART has a TZID; a floating UNTIL is
      // read in DTSTART's zone, like DTSTART itself.
      const at = parseIcsDateTime(until, until.endsWith("Z") ? undefined : tzid).getTime();
      if (!Number.isFinite(at)) return null;
      rule.until = { at };
    }
  }
  const wkst = parts.get("WKST");
  if (wkst !== undefined) {
    rule.wkst = WEEKDAYS.indexOf(wkst.toUpperCase());
    if (rule.wkst < 0) return null;
  }
  const byDay = parts.get("BYDAY");
  if (byDay !== undefined) {
    rule.byDay = [];
    for (const d of byDay.split(",")) {
      const m = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/i.exec(d.trim());
      if (!m) return null;
      const n = m[1] ? Number(m[1]) : 0;
      if (n !== 0 && (Math.abs(n) > 5 || (freq !== "MONTHLY" && freq !== "YEARLY"))) return null;
      rule.byDay.push({ n, wd: WEEKDAYS.indexOf(m[2]!.toUpperCase()) });
    }
  }
  const byMonthDay = parts.get("BYMONTHDAY");
  if (byMonthDay !== undefined) {
    if (freq === "WEEKLY") return null; // RFC 5545: not valid with WEEKLY
    const v = ints(byMonthDay, 1, 31);
    if (!v) return null;
    rule.byMonthDay = v;
  }
  const byMonth = parts.get("BYMONTH");
  if (byMonth !== undefined) {
    const v = ints(byMonth, 1, 12);
    if (!v || v.some((n) => n < 0)) return null;
    rule.byMonth = v;
  }
  // BYDAY in a YEARLY rule without BYMONTH means "every Monday of the year"
  // or "the 20th Monday of the year" — outside the subset.
  if (freq === "YEARLY" && rule.byDay && !rule.byMonth) return null;
  return rule;
}

// ── day-number arithmetic (days since 1970-01-01, a Thursday) ──────────────

const dayNumber = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY_MS;
const weekdayOf = (dn: number) => (((dn + 3) % 7) + 7) % 7; // 0 = Monday
function ymdOf(dn: number): { y: number; m: number; d: number; ymd: string } {
  const t = new Date(dn * DAY_MS);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  const d = t.getUTCDate();
  return { y, m, d, ymd: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
}
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** Candidate days of a month under BYMONTHDAY / BYDAY (their intersection
 *  when both are set), or DTSTART's day of the month when neither is. */
function monthDays(y: number, m: number, rule: Rule, baseDay: number): number[] {
  const len = daysInMonth(y, m);
  const first = dayNumber(y, m, 1);
  let doms: number[] | null = null;
  if (rule.byMonthDay) {
    doms = rule.byMonthDay.map((n) => (n > 0 ? n : len + 1 + n)).filter((n) => n >= 1 && n <= len);
  }
  if (rule.byDay) {
    const fromDays: number[] = [];
    for (const { n, wd } of rule.byDay) {
      const all: number[] = [];
      for (let dom = 1; dom <= len; dom++) if (weekdayOf(first + dom - 1) === wd) all.push(dom);
      if (n === 0) fromDays.push(...all);
      else {
        const pick = n > 0 ? all[n - 1] : all[all.length + n];
        if (pick !== undefined) fromDays.push(pick);
      }
    }
    doms = doms ? doms.filter((d) => fromDays.includes(d)) : fromDays;
  }
  if (!doms) doms = baseDay <= len ? [baseDay] : []; // Jan 31 monthly skips short months (RFC)
  return [...new Set(doms)].sort((a, b) => a - b).map((dom) => first + dom - 1);
}

/** Days of period `k`, sorted, and the first day of that period. */
function period(rule: Rule, k: number, base: { dn: number; y: number; m: number; d: number }): { start: number; days: number[] } {
  const step = k * rule.interval;
  switch (rule.freq) {
    case "DAILY": {
      const dn = base.dn + step;
      const { m, d } = ymdOf(dn);
      const ok =
        (!rule.byMonth || rule.byMonth.includes(m)) &&
        (!rule.byMonthDay || rule.byMonthDay.some((n) => (n > 0 ? n : daysInMonth(ymdOf(dn).y, m) + 1 + n) === d)) &&
        (!rule.byDay || rule.byDay.some((b) => b.wd === weekdayOf(dn)));
      return { start: dn, days: ok ? [dn] : [] };
    }
    case "WEEKLY": {
      const weekStart = base.dn - ((weekdayOf(base.dn) - rule.wkst + 7) % 7) + step * 7;
      const wds = rule.byDay ? rule.byDay.map((b) => b.wd) : [weekdayOf(base.dn)];
      const days = [...new Set(wds.map((wd) => weekStart + ((wd - rule.wkst + 7) % 7)))]
        .filter((dn) => !rule.byMonth || rule.byMonth.includes(ymdOf(dn).m))
        .sort((a, b) => a - b);
      return { start: weekStart, days };
    }
    case "MONTHLY": {
      const idx = base.y * 12 + (base.m - 1) + step;
      const y = Math.floor(idx / 12);
      const m = (idx % 12) + 1;
      const days = !rule.byMonth || rule.byMonth.includes(m) ? monthDays(y, m, rule, base.d) : [];
      return { start: dayNumber(y, m, 1), days };
    }
    case "YEARLY": {
      const y = base.y + step;
      const months = rule.byMonth
        ? [...rule.byMonth].sort((a, b) => a - b)
        : rule.byMonthDay
          ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
          : [base.m];
      return { start: dayNumber(y, 1, 1), days: months.flatMap((m) => monthDays(y, m, rule, base.d)) };
    }
  }
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  out.setUTCMonth(out.getUTCMonth() + n);
  return out;
}

/**
 * Flatten a parsed feed into the rows to store. Non-recurring events pass
 * through unchanged (key = UID). `now` is injectable for tests.
 */
export function expandIcsEvents(events: IcsEvent[], now: Date = new Date()): ExpandedIcsEvent[] {
  const windowStart = addMonths(now, -RECURRENCE_PAST_MONTHS).getTime();
  const windowEnd = addMonths(now, RECURRENCE_FUTURE_MONTHS).getTime();

  const masters = new Map<string, IcsEvent>();
  const overrides = new Map<string, IcsEvent[]>();
  for (const ev of events) {
    if (!ev.uid) continue;
    if (ev.recurrenceId) {
      const list = overrides.get(ev.uid) ?? [];
      list.push(ev);
      overrides.set(ev.uid, list);
    } else {
      masters.set(ev.uid, ev); // a repeated UID: the last one wins, as before
    }
  }

  const out: ExpandedIcsEvent[] = [];
  const occKey = (uid: string, originalStart: number) =>
    `${uid}${OCCURRENCE_KEY_SEPARATOR}${new Date(originalStart).toISOString()}`;
  const inWindow = (s: number, e: number) => e > windowStart && s < windowEnd;

  for (const uid of new Set([...masters.keys(), ...overrides.keys()])) {
    const master = masters.get(uid);
    const byRid = new Map((overrides.get(uid) ?? []).map((o) => [o.recurrenceId!.getTime(), o]));
    const rule =
      master?.rrule && out.length < MAX_OCCURRENCES_PER_FEED ? parseRrule(master.rrule, master.tzid) : null;

    if (master && !master.rrule) out.push({ ...master, key: uid, recurrence: "none" });
    if (master && master.rrule && !rule) out.push({ ...master, key: uid, recurrence: "unexpanded" });

    if (master && rule) {
      const duration = master.endsAt.getTime() - master.startsAt.getTime();
      // DTSTART's wall clock, in the zone it was written in.
      let baseYmd: string;
      let minuteOfDay = 0;
      if (master.allDay) {
        baseYmd = master.startsAt.toISOString().slice(0, 10);
      } else if (master.tzid) {
        const lp = localPartsOf(master.startsAt, master.tzid);
        baseYmd = lp.ymd;
        minuteOfDay = lp.minuteOfDay;
      } else {
        baseYmd = master.startsAt.toISOString().slice(0, 10);
        minuteOfDay = master.startsAt.getUTCHours() * 60 + master.startsAt.getUTCMinutes();
      }
      const seconds = master.startsAt.getUTCSeconds();
      const [by, bm, bd] = baseYmd.split("-").map(Number) as [number, number, number];
      const base = { dn: dayNumber(by, bm, bd), y: by, m: bm, d: bd };
      const startOf = (dn: number): number => {
        const { y, m, d } = ymdOf(dn);
        if (master.allDay) return dn * DAY_MS;
        const h = Math.floor(minuteOfDay / 60);
        const mi = minuteOfDay % 60;
        return master.tzid
          ? zonedWallClockToUtc(y, m, d, h, mi, seconds, master.tzid).getTime()
          : Date.UTC(y, m - 1, d, h, mi, seconds);
      };
      const exAt = new Set((master.exdates ?? []).map((d) => d.getTime()));
      const exDays = new Set(master.exdateDays ?? []);
      const windowEndDn = Math.floor(windowEnd / DAY_MS) + 1;

      let generated = 0;
      let stored = 0;
      const emit = (dn: number, start: number): boolean => {
        generated++;
        if (rule.count !== undefined && generated > rule.count) return false;
        if (exAt.has(start) || exDays.has(ymdOf(dn).ymd)) return true; // EXDATE counts toward COUNT
        const ov = byRid.get(start);
        byRid.delete(start);
        if (ov) {
          if (ov.status !== "CANCELLED" && inWindow(ov.startsAt.getTime(), ov.endsAt.getTime())) {
            out.push({ ...ov, key: occKey(uid, start), recurrence: "occurrence" });
            stored++;
          }
        } else if (inWindow(start, start + duration)) {
          out.push({
            ...master,
            startsAt: new Date(start),
            endsAt: new Date(start + duration),
            key: occKey(uid, start),
            recurrence: "occurrence",
          });
          stored++;
        }
        return stored < MAX_OCCURRENCES_PER_SERIES;
      };

      // RFC 5545: DTSTART is always the first instance.
      let going = emit(base.dn, master.startsAt.getTime());
      for (let k = 0; going && k < MAX_PERIODS; k++) {
        const p = period(rule, k, base);
        if (p.start > windowEndDn) break;
        for (const dn of p.days) {
          if (dn <= base.dn) continue;
          const start = startOf(dn);
          if (rule.until) {
            const past = "at" in rule.until ? start > rule.until.at : ymdOf(dn).ymd > rule.until.ymd;
            if (past) {
              going = false;
              break;
            }
          }
          if (!(going = emit(dn, start))) break;
        }
      }
    }

    // Overrides whose instance the master did not generate (master missing,
    // unexpanded, or the instance lies outside the walked range) still show.
    for (const [rid, ov] of byRid) {
      if (ov.status !== "CANCELLED" && inWindow(ov.startsAt.getTime(), ov.endsAt.getTime())) {
        out.push({ ...ov, key: occKey(uid, rid), recurrence: "occurrence" });
      }
    }
  }
  return out;
}
