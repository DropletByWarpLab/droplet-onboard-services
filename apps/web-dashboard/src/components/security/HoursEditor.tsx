"use client";

/**
 * WARP-2977 P2b (ADR-059 §3.6, spec §8 "/security/settings") — the usual
 * weekly opening hours.
 *
 * What the owner edits is a DRAFT. Nothing reaches the server until Save:
 * the presets ("Weekdays 9–5", …) only fill the draft, so a curious click can
 * never change when Droplet thinks the site is empty. Save sends exactly the
 * seven days, Monday first, with the `version` the draft was started from as
 * `expectedVersion` — if someone else saved in between, the server answers
 * VERSION_CONFLICT and the draft is kept, with an offer to load theirs. A
 * background refresh never overwrites a draft that has unsaved edits.
 *
 * One window per day, owned by the day it OPENS on: a close earlier than the
 * open means "the next day" (Fri 18:00–02:00 runs into Saturday), and equal
 * times are refused — a day that never closes is "Open all day".
 *
 * Below manage (useModuleLevel) the same hours render as plain text, with no
 * control at all, and the one line saying who can change them. The server's
 * `requireFeatureAccess('security','manage')` is the boundary; hiding the
 * controls keeps a click from turning into a denial the threat mirror shows.
 *
 * Mobile: each day is its own card, and its controls wrap inside it.
 */
import { useEffect, useId, useState } from "react";
import { Clock, Loader2 } from "lucide-react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { formatSiteTime, formatWallTime, hhmmToMinutes, siteDateOf } from "@/lib/security-time";
import type { SecurityDayKind, SecurityHoursBody, SecurityHoursDay, SecurityHoursView } from "@/lib/types";
import { TimezoneSelect, fill } from "./TimezoneSelect";

export const COPY = {
  pageTitle: "Opening hours",
  pageSub:
    "When the site is normally open. Droplet uses this to tell ordinary activity from after-hours activity. " +
    "It is set here, not read from your calendar. Nothing here locks doors or sends alerts.",
  usualTitle: "Usual hours",
  notSet: "No opening hours are set yet, so Droplet counts the site as open all the time.",
  presetsIntro: "Start from a common week, then adjust any day. Nothing changes until you save.",
  presetsLabel: "Start from",
  presetWeekdays: "Weekdays 9–5",
  presetMonSat: "Mon–Sat 9–6",
  presetEveryDay: "Every day 8–8",
  presetAlways: "Always open",
  kindClosed: "Closed",
  kindAllDay: "Open all day",
  kindHours: "Open",
  opens: "Opens",
  closes: "Closes",
  nextDay: "Closes at {time} the next day",
  range: "{from} – {to}",
  rangeNextDay: "{from} – {to} the next day",
  kindGroup: "{day}: open or closed",
  onDay: " on {day}",
  sameTimes: "Opening and closing times can't be the same. For a day that never closes, choose Open all day.",
  missingTimes: "Enter both an opening and a closing time.",
  save: "Save opening hours",
  saving: "Saving…",
  discard: "Discard changes",
  unsaved: "You have unsaved changes.",
  conflict: "Someone else changed the opening hours while you were editing, so yours weren't saved.",
  showTheirs: "Show their changes",
  clear: "Clear opening hours",
  clearTitle: "Clear the opening hours?",
  clearBody:
    "Droplet will count the site as open all the time, and every special day is removed too. " +
    "You can set the hours again at any time.",
  clearConfirm: "Clear hours",
  readOnlyNote: "Only people who manage Security can change opening hours.",
  savedToast: "Opening hours saved.",
  savedUnreadToast: "Opening hours saved. Droplet couldn't show the latest version yet. Refresh to see it.",
  clearedToast: "Opening hours cleared. Droplet now counts the site as open all the time.",
  loadFailed: "Droplet couldn't load the opening hours",
  retry: "Retry",
  previewTitle: "Next 7 days",
  previewSub: "From the saved hours, in {tz}.",
  previewNone: "Closed for all of the next 7 days.",
  today: "Today",
  tomorrow: "Tomorrow",
  yesterday: "Yesterday",
  allDay: "Open all day",
  allDayThrough: "Open all day through {day}",
  until: "{from} until {day}, {to}",
  openNowUntil: "Open now, until {to}",
  openNowUntilNextDay: "Open now, until {to} the next day",
  openNowUntilDay: "Open now, until {day}, {to}",
  openNowMidnight: "Open now, until midnight",
  openNowThrough: "Open now, all day through {day}",
  openNowAllWeek: "Open now, and for all of the next 7 days",
  opensAt: "Opens at {from}",
  loading: "Loading the opening hours…",
  profileTitle: "What your business profile says",
} as const;

export const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

export const KIND_LABEL: Record<SecurityDayKind, string> = {
  closed: COPY.kindClosed,
  open_all_day: COPY.kindAllDay,
  hours: COPY.kindHours,
};

const KINDS: SecurityDayKind[] = ["closed", "open_all_day", "hours"];

/**
 * One day being edited. `opens`/`closes` are 'HH:MM' (or "" while a time input
 * is cleared) and are KEPT when the kind changes, so Closed → Open restores
 * the times; only `kind === "hours"` sends them.
 */
export interface DayDraft {
  kind: SecurityDayKind;
  opens: string;
  closes: string;
}

/** Seven drafts, index 0 = Monday (ISO weekday 1). */
export type WeekDraft = DayDraft[];

const DEFAULT_OPENS = "09:00";
const DEFAULT_CLOSES = "17:00";

const closedDay = (): DayDraft => ({ kind: "closed", opens: "", closes: "" });
const hoursDay = (opens: string, closes: string): DayDraft => ({ kind: "hours", opens, closes });
const allDay = (): DayDraft => ({ kind: "open_all_day", opens: "", closes: "" });
const times = (n: number, day: () => DayDraft): DayDraft[] => Array.from({ length: n }, day);

export interface HoursPreset {
  id: string;
  label: string;
  week: () => WeekDraft;
}

/** Shown only while no hours are set. Each FILLS the draft; none saves. */
export const PRESETS: readonly HoursPreset[] = [
  {
    id: "weekdays_9_5",
    label: COPY.presetWeekdays,
    week: () => [...times(5, () => hoursDay("09:00", "17:00")), closedDay(), closedDay()],
  },
  {
    id: "mon_sat_9_6",
    label: COPY.presetMonSat,
    week: () => [...times(6, () => hoursDay("09:00", "18:00")), closedDay()],
  },
  { id: "every_day_8_8", label: COPY.presetEveryDay, week: () => times(7, () => hoursDay("08:00", "20:00")) },
  { id: "always_open", label: COPY.presetAlways, week: () => times(7, allDay) },
];

/**
 * The draft a week editor starts from: the saved week — or, while no hours are
 * set, "Always open", which is what not_set means ("counts the site as open all
 * the time"). The server sends seven `closed` rows for not_set; seeding from
 * those made the first natural action on a new site (accepting the suggested
 * timezone) arm a Save that flipped it from open all the time to never open.
 */
export function startingWeek(hours: SecurityHoursView): WeekDraft {
  return hours.state === "not_set" ? times(7, allDay) : draftWeekFromView(hours.days);
}

/** The server's 7 days (any order) → a Monday-first draft. A missing weekday reads as closed. */
export function draftWeekFromView(days: readonly SecurityHoursDay[]): WeekDraft {
  return WEEKDAY_NAMES.map((_, i) => {
    const d = days.find((x) => x.weekday === i + 1);
    if (!d) return closedDay();
    return { kind: d.kind, opens: d.opens ?? "", closes: d.closes ?? "" };
  });
}

export type DayProblem = "missing" | "same" | null;

/** What stops this day from being saved, if anything. Only an Open day with times can be wrong. */
export function dayProblem(d: DayDraft): DayProblem {
  if (d.kind !== "hours") return null;
  const o = hhmmToMinutes(d.opens);
  const c = hhmmToMinutes(d.closes);
  if (o === null || c === null) return "missing";
  if (o === c) return "same";
  return null;
}

/** True when the day closes after midnight: its close is earlier than its open. */
export function crossesMidnight(d: DayDraft): boolean {
  if (d.kind !== "hours" || dayProblem(d) !== null) return false;
  return hhmmToMinutes(d.closes)! < hhmmToMinutes(d.opens)!;
}

/** "9:00 AM – 5:00 PM", "6:00 PM – 2:00 AM the next day", "Open all day", "Closed". */
export function describeDay(d: Pick<DayDraft, "kind"> & { opens: string | null; closes: string | null }): string {
  if (d.kind !== "hours") return KIND_LABEL[d.kind];
  const draft: DayDraft = { kind: "hours", opens: d.opens ?? "", closes: d.closes ?? "" };
  if (dayProblem(draft) !== null) return KIND_LABEL.hours;
  const span = { from: formatWallTime(draft.opens), to: formatWallTime(draft.closes) };
  return fill(crossesMidnight(draft) ? COPY.rangeNextDay : COPY.range, span);
}

/**
 * The PUT /api/security/hours body: exactly seven days, weekdays 1..7 in
 * order, times only on Open days (the server's schema is strict), and the
 * version the draft was read at.
 */
export function buildHoursBody(week: WeekDraft, timezone: string, expectedVersion: number): SecurityHoursBody {
  if (week.length !== 7) throw new RangeError(`a week has 7 days, got ${week.length}`);
  return {
    state: "set",
    timezone,
    expectedVersion,
    days: week.map((d, i) =>
      d.kind === "hours"
        ? { weekday: i + 1, kind: "hours", opens: d.opens, closes: d.closes }
        : { weekday: i + 1, kind: d.kind },
    ),
  };
}

/**
 * The zone a draft starts in: the saved site zone; else (no hours yet) the
 * business's own zone when it is valid; else the device's. Never UTC — ""
 * when none is known, and Save waits for a pick.
 */
export function initialZone(hours: SecurityHoursView, deviceZone: string | null): string {
  return hours.timezone ?? hours.hint.workspaceTimezone ?? deviceZone ?? "";
}

/**
 * Whether two reads of the hours carry the same WEEK (state, zone, the seven
 * days). The server's `version` also moves on every special-day write, and a
 * week save leaves special days alone — so a draft whose base week is
 * unchanged may safely advance its expectedVersion. Without this, adding a
 * special day mid-edit would make the owner's own week save read as
 * "someone else changed this".
 */
export function sameWeek(a: SecurityHoursView, b: SecurityHoursView): boolean {
  if (a.state !== b.state || a.timezone !== b.timezone) return false;
  const wa = draftWeekFromView(a.days);
  const wb = draftWeekFromView(b.days);
  return wa.every((d, i) => {
    const e = wb[i]!;
    if (d.kind !== e.kind) return false;
    return d.kind !== "hours" || (d.opens === e.opens && d.closes === e.closes);
  });
}

// ── Site calendar dates ('YYYY-MM-DD'), shared with the special-day list ─────

/** 'YYYY-MM-DD' + n calendar days, in pure calendar arithmetic (no zone involved). */
export function ymdAddDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

/** Whole calendar days from `a` to `b` (both 'YYYY-MM-DD'). */
export function ymdDiff(a: string, b: string): number {
  const ms = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return Date.UTC(y!, m! - 1, d!);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

/** 'YYYY-MM-DD' → "Thu, Dec 25" (with the year when it is not `today`'s year). A calendar date, formatted as one. */
export function formatSiteDate(ymd: string, today: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const sameYear = ymd.slice(0, 4) === today.slice(0, 4);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** "Today" / "Tomorrow" / "Yesterday" / "Fri, Sep 25", relative to the site's today. */
export function siteDayLabel(ymd: string, today: string): string {
  const diff = ymdDiff(today, ymd);
  if (diff === 0) return COPY.today;
  if (diff === 1) return COPY.tomorrow;
  if (diff === -1) return COPY.yesterday;
  return formatSiteDate(ymd, today);
}

/** Minutes since site-local midnight of an instant. */
function siteMinuteOf(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return (get("hour") % 24) * 60 + get("minute");
}

/**
 * Whether a preview bound is the server's CUT rather than an opening or a
 * closing. The server clips its windows to [now, now + 7 days), so the window
 * open right now starts at the server's clock, and the last one may end at
 * it. Real bounds are wall times in whole-minute offsets, so they land on a
 * whole minute; a cut carries the server clock's seconds.
 */
export function isPreviewCut(at: Date): boolean {
  return at.getTime() % 60_000 !== 0;
}

/**
 * One server preview window, in the SITE zone: which day it starts on, and
 * its span — "9:00 AM – 5:00 PM", "6:00 PM – 2:00 AM the next day",
 * "Open all day", "Open all day through Tue, Sep 29", or for anything else
 * "9:00 AM until Thu, Sep 24, 5:00 PM".
 *
 * A window that is open at `now` (or whose start is the server's cut) never
 * shows its start as an opening time: "Open now, until 5:00 PM". A window
 * whose end is the cut at the 7-day horizon never shows a closing time:
 * "Opens at 9:00 AM". Printing either cut as a time would tell the owner the
 * site opens at 10:32 AM or closes at the minute they happened to load the page.
 */
export function describeWindow(
  w: { startsAt: string; endsAt: string },
  timeZone: string,
  today: string,
  now: Date | null = null,
): { day: string; span: string } {
  const start = new Date(w.startsAt);
  const end = new Date(w.endsAt);
  const startDay = siteDateOf(start, timeZone);
  const endDay = siteDateOf(end, timeZone);
  const days = ymdDiff(startDay, endDay);
  const day = siteDayLabel(startDay, today);
  const endCut = isPreviewCut(end);
  const to = formatSiteTime(end, timeZone);
  if (isPreviewCut(start) || (now !== null && start.getTime() <= now.getTime())) {
    if (endCut) return { day, span: COPY.openNowAllWeek };
    if (siteMinuteOf(end, timeZone) === 0 && days >= 1) {
      return {
        day,
        span:
          days === 1
            ? COPY.openNowMidnight
            : fill(COPY.openNowThrough, { day: formatSiteDate(ymdAddDays(endDay, -1), today) }),
      };
    }
    if (days === 0) return { day, span: fill(COPY.openNowUntil, { to }) };
    if (days === 1) return { day, span: fill(COPY.openNowUntilNextDay, { to }) };
    return { day, span: fill(COPY.openNowUntilDay, { day: formatSiteDate(endDay, today), to }) };
  }
  if (endCut) return { day, span: fill(COPY.opensAt, { from: formatSiteTime(start, timeZone) }) };
  if (siteMinuteOf(start, timeZone) === 0 && siteMinuteOf(end, timeZone) === 0 && days >= 1) {
    return {
      day,
      span: days === 1 ? COPY.allDay : fill(COPY.allDayThrough, { day: siteDayLabel(ymdAddDays(endDay, -1), today) }),
    };
  }
  const from = formatSiteTime(start, timeZone);
  if (days === 0) return { day, span: fill(COPY.range, { from, to }) };
  if (days === 1) return { day, span: fill(COPY.rangeNextDay, { from, to }) };
  return { day, span: fill(COPY.until, { from, day: siteDayLabel(endDay, today), to }) };
}

// ── One day's fields (shared with the special-day form) ──────────────────────

const inputCls =
  "w-full px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[color:var(--text)] focus:border-[var(--brand)]";

export interface DayHoursFieldsProps {
  value: DayDraft;
  onChange: (next: DayDraft) => void;
  /** Group name for assistive tech, e.g. "Monday". */
  groupLabel: string;
  /** Appended (visually hidden) to the Opens/Closes labels so each is unique on the page, e.g. " on Monday". */
  labelSuffix?: string;
}

/** The Closed / Open all day / Open pills, and for Open two native time inputs with their hint or error. */
export function DayHoursFields({ value, onChange, groupLabel, labelSuffix = "" }: DayHoursFieldsProps) {
  const uid = useId();
  const opensId = `${uid}-opens`;
  const closesId = `${uid}-closes`;
  const msgId = `${uid}-msg`;
  const problem = dayProblem(value);
  const nextDay = crossesMidnight(value);

  const setKind = (kind: SecurityDayKind) => {
    if (kind === "hours") {
      onChange({ kind, opens: value.opens || DEFAULT_OPENS, closes: value.closes || DEFAULT_CLOSES });
    } else {
      onChange({ ...value, kind });
    }
  };

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px", minWidth: 0 }}>
      <div className="pills" role="group" aria-label={fill(COPY.kindGroup, { day: groupLabel })}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={value.kind === k ? "active" : ""}
            aria-pressed={value.kind === k}
            onClick={() => setKind(k)}
          >
            {KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {value.kind === "hours" && (
        // Grows to a full row on a phone, so Opens and Closes sit side by side.
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, minWidth: 0, flex: "1 1 260px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 128px", maxWidth: 180, minWidth: 0 }}>
            <label htmlFor={opensId} style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {COPY.opens}
              {labelSuffix && <span className="sr-only">{labelSuffix}</span>}
            </label>
            <input
              id={opensId}
              type="time"
              value={value.opens}
              onChange={(e) => onChange({ ...value, opens: e.target.value })}
              aria-invalid={problem !== null}
              aria-describedby={problem || nextDay ? msgId : undefined}
              className={inputCls}
            />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 128px", maxWidth: 180, minWidth: 0 }}>
            <label htmlFor={closesId} style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {COPY.closes}
              {labelSuffix && <span className="sr-only">{labelSuffix}</span>}
            </label>
            <input
              id={closesId}
              type="time"
              value={value.closes}
              onChange={(e) => onChange({ ...value, closes: e.target.value })}
              aria-invalid={problem !== null}
              aria-describedby={problem || nextDay ? msgId : undefined}
              className={inputCls}
            />
          </div>
        </div>
      )}
      {/* Equal times is a real mistake, announced. A cleared field is also what a
          native time input reports mid-typing, so it is shown but not announced. */}
      {problem !== null && (
        <p
          id={msgId}
          role={problem === "same" ? "alert" : undefined}
          style={{ margin: 0, flexBasis: "100%", fontSize: 12.5, color: "var(--danger)" }}
        >
          {problem === "same" ? COPY.sameTimes : COPY.missingTimes}
        </p>
      )}
      {problem === null && nextDay && (
        <p id={msgId} style={{ margin: 0, flexBasis: "100%", fontSize: 12.5, color: "var(--text-muted)" }}>
          {fill(COPY.nextDay, { time: formatWallTime(value.closes) })}
        </p>
      )}
    </div>
  );
}

// ── The weekly editor ─────────────────────────────────────────────────────────

/** How the page's save went: `conflict` = VERSION_CONFLICT (the page has already said so in a toast). */
export type HoursSaveOutcome = "saved" | "conflict" | "failed";

export interface HoursEditorProps {
  hours: SecurityHoursView;
  /** `levelAtLeast(useModuleLevel("security"), "manage")`. Below it, text only. */
  canManage: boolean;
  /** `deviceTimeZone()` — a suggestion next to the site zone, and the last-resort pre-selection. */
  deviceZone: string | null;
  /** PUT /api/security/hours. Resolves with the outcome; the page renders any error. */
  onSave: (body: SecurityHoursBody) => Promise<HoursSaveOutcome>;
  /** Re-read the hours (after a conflict, to show the other person's save). */
  onReload: () => Promise<unknown>;
  /** The timezone list; defaults to the runtime's. Injected by tests. */
  zones?: readonly string[];
}

export function HoursEditor(props: HoursEditorProps) {
  return props.canManage ? <WeekEditor {...props} /> : <WeekReadOnly hours={props.hours} deviceZone={props.deviceZone} />;
}

function WeekReadOnly({ hours, deviceZone }: { hours: SecurityHoursView; deviceZone: string | null }) {
  const week = draftWeekFromView(hours.days);
  return (
    <section className="card" aria-labelledby="security-hours-title" data-testid="hours-readonly">
      <div className="card-h">
        <span className="ci">
          <Clock size={16} />
        </span>
        <h2 className="ct" id="security-hours-title" style={{ margin: 0 }}>
          {COPY.usualTitle}
        </h2>
      </div>
      {hours.state === "not_set" || !hours.timezone ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--text)" }}>{COPY.notSet}</p>
      ) : (
        <>
          <ul className="rows" style={{ listStyle: "none", margin: "0 0 12px", padding: 0 }}>
            {week.map((d, i) => (
              <li className="lrow" key={WEEKDAY_NAMES[i]}>
                <span className="rt">
                  <span className="nm">{WEEKDAY_NAMES[i]}</span>
                </span>
                <span className="rmeta">{describeDay(d)}</span>
              </li>
            ))}
          </ul>
          <TimezoneSelect value={hours.timezone} onChange={() => {}} deviceZone={deviceZone} readOnly />
        </>
      )}
      <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--text-muted)" }}>{COPY.readOnlyNote}</p>
    </section>
  );
}

function WeekEditor({ hours, deviceZone, onSave, onReload, zones }: HoursEditorProps) {
  const [week, setWeek] = useState<WeekDraft>(() => startingWeek(hours));
  const [timezone, setTimezone] = useState<string>(() => initialZone(hours, deviceZone));
  // The version this draft was read at — sent as expectedVersion, so a save
  // over someone else's newer hours is refused instead of silently undoing them.
  const [base, setBase] = useState<SecurityHoursView>(hours);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // Follow the server while there is nothing unsaved; never overwrite edits.
  // With edits pending, advance the base only when the server's WEEK is still
  // the one the draft started from (a special-day write moved the version).
  // That also settles a conflict whose cause was only a special day (the page
  // re-reads on VERSION_CONFLICT): the next Save lands, so "Show their changes"
  // — which would throw the draft away for nothing visible — is withdrawn.
  useEffect(() => {
    if (!dirty) {
      setWeek(startingWeek(hours));
      setTimezone(initialZone(hours, deviceZone));
      setBase(hours);
      return;
    }
    if (base !== hours && sameWeek(base, hours)) {
      setBase(hours);
      setConflict(false);
    }
  }, [hours, deviceZone, dirty, base]);
  const baseVersion = base.version;

  const edit = (next: WeekDraft) => {
    setWeek(next);
    setDirty(true);
  };
  const editDay = (i: number, d: DayDraft) => edit(week.map((x, j) => (j === i ? d : x)));

  const problems = week.map(dayProblem);
  const valid = problems.every((p) => p === null) && timezone !== "";
  const canSave = dirty && valid && !saving;

  const run = async (body: SecurityHoursBody) => {
    setSaving(true);
    try {
      const outcome = await onSave(body);
      if (outcome === "saved") {
        setConflict(false);
        setDirty(false);
      } else if (outcome === "conflict") {
        setConflict(true);
      }
    } finally {
      setSaving(false);
    }
  };

  const showTheirs = async () => {
    await onReload();
    setConflict(false);
    setDirty(false);
  };

  return (
    <section className="card" aria-labelledby="security-hours-title" data-testid="hours-editor">
      <div className="card-h">
        <span className="ci">
          <Clock size={16} />
        </span>
        <h2 className="ct" id="security-hours-title" style={{ margin: 0 }}>
          {COPY.usualTitle}
        </h2>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {hours.state === "not_set" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--text)" }}>{COPY.notSet}</p>
            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)" }}>{COPY.presetsIntro}</p>
            <div className="chiprow" role="group" aria-label={COPY.presetsLabel}>
              {PRESETS.map((p) => (
                <button key={p.id} type="button" className="chip" onClick={() => edit(p.week())}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        <TimezoneSelect
          value={timezone}
          onChange={(tz) => {
            setTimezone(tz);
            setDirty(true);
          }}
          deviceZone={deviceZone}
          zones={zones}
        />

        <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {week.map((d, i) => {
            const name = WEEKDAY_NAMES[i];
            return (
              <li
                key={name}
                className="card"
                data-weekday={i + 1}
                aria-label={name}
                style={{ padding: 14, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px" }}
              >
                <span style={{ width: 96, flexShrink: 0, fontSize: 13.5, fontWeight: 600, color: "var(--text)" }}>
                  {name}
                </span>
                <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                  <DayHoursFields
                    value={d}
                    onChange={(next) => editDay(i, next)}
                    groupLabel={name}
                    labelSuffix={fill(COPY.onDay, { day: name })}
                  />
                </div>
              </li>
            );
          })}
        </ol>

        {conflict && (
          <div
            role="alert"
            style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, fontSize: 13, color: "var(--text)" }}
          >
            <span style={{ flex: "1 1 240px" }}>{COPY.conflict}</span>
            <button type="button" className="btn sm" onClick={() => void showTheirs()}>
              {COPY.showTheirs}
            </button>
          </div>
        )}

        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
          <button type="button" className="btn primary" disabled={!canSave} onClick={() => void run(buildHoursBody(week, timezone, baseVersion))}>
            {saving && <Loader2 size={16} className="animate-spin" aria-hidden />}
            {saving ? COPY.saving : COPY.save}
          </button>
          {dirty && (
            <button
              type="button"
              className="btn ghost"
              disabled={saving}
              onClick={() => {
                setDirty(false);
                setConflict(false);
              }}
            >
              {COPY.discard}
            </button>
          )}
          {dirty && <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{COPY.unsaved}</span>}
          {!dirty && hours.state === "set" && (
            <button type="button" className="btn ghost" disabled={saving} onClick={() => setConfirmClear(true)}>
              {COPY.clear}
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={COPY.clearTitle}
        description={COPY.clearBody}
        confirmLabel={COPY.clearConfirm}
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => run({ state: "not_set", expectedVersion: baseVersion })}
      />
    </section>
  );
}

// ── The server's 7-day preview and the business profile's own words ──────────

/**
 * The next 7 days of open windows, as the SERVER computed them from the saved
 * hours (the same evaluator the mode ticker uses), formatted in the site zone.
 * It deliberately does not follow the unsaved draft: it shows what Droplet
 * will actually do.
 */
export function HoursPreview({
  preview,
  timezone,
  now = new Date(),
}: {
  preview: SecurityHoursView["preview"];
  timezone: string;
  now?: Date;
}) {
  const today = siteDateOf(now, timezone);
  return (
    <section className="card" aria-labelledby="security-hours-preview-title" data-testid="hours-preview">
      <div className="card-h">
        <h2 className="ct" id="security-hours-preview-title" style={{ margin: 0 }}>
          {COPY.previewTitle}
        </h2>
      </div>
      <p style={{ margin: "0 0 8px", fontSize: 13, color: "var(--text-muted)" }}>
        {fill(COPY.previewSub, { tz: timezone })}
      </p>
      {preview.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--text)" }}>{COPY.previewNone}</p>
      ) : (
        <ul className="rows" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {preview.map((w) => {
            const { day, span } = describeWindow(w, timezone, today, now);
            return (
              <li className="lrow" key={w.startsAt}>
                <span className="rt">
                  <span className="nm">{day}</span>
                  <span className="sub">{span}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * The business profile's free-text "typical day", read-only and only when
 * there is one. A reminder of what the owner already wrote, never a source:
 * nothing copies it into the hours (there is no structure to copy).
 */
export function BusinessProfileHint({ typicalDay }: { typicalDay: string }) {
  const text = typicalDay.trim();
  if (!text) return null;
  return (
    <section className="card" aria-labelledby="security-profile-hint-title" data-testid="profile-hint">
      <div className="card-h">
        <h2 className="ct" id="security-profile-hint-title" style={{ margin: 0 }}>
          {COPY.profileTitle}
        </h2>
      </div>
      <blockquote
        style={{
          margin: 0,
          padding: "10px 14px",
          borderLeft: "3px solid var(--card-bd)",
          background: "var(--inset)",
          borderRadius: 8,
          fontSize: 13.5,
          color: "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {text}
      </blockquote>
    </section>
  );
}
