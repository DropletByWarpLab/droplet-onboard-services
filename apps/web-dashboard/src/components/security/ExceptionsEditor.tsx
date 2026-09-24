"use client";

/**
 * WARP-2977 P2b (ADR-059 §3.6, spec §6.2 / §8) — special days: a date whose
 * hours differ from the usual week (a holiday, a late night).
 *
 * A special day replaces ONLY its own date's window. The evening before still
 * ends when it normally would, so a Saturday marked Closed does not cut short
 * a Friday that runs to 2:00 AM — the explainer says exactly that, because it
 * is the one rule an owner would otherwise guess wrong.
 *
 * Dates are the SITE's calendar dates ('YYYY-MM-DD'), never the device's:
 * `today` comes from the page, computed in the site timezone. The server
 * accepts site-local yesterday up to a year ahead; this form offers today up
 * to a year ahead. Saving a date that already has special hours replaces
 * them (the server's PUT is per date).
 *
 * Below manage there is no form and no Remove — only the list.
 */
import { useId, useState } from "react";
import { CalendarDays, Loader2, Plus } from "lucide-react";
import type { SecurityHoursException, SecurityHoursExceptionBody } from "@/lib/types";
import { DayHoursFields, dayProblem, describeDay, formatSiteDate, ymdAddDays, type DayDraft } from "./HoursEditor";
import { fill } from "./TimezoneSelect";

export const COPY = {
  title: "Special days",
  explainer:
    "A special day replaces that date's normal hours. Late hours from the evening before still end when they normally would.",
  empty: "No special days coming up.",
  needsHours: "Set the usual hours first, then add special days.",
  add: "Add a day",
  date: "Date",
  note: "Note (optional)",
  notePlaceholder: "Holiday, stocktake, late opening",
  save: "Save special day",
  saving: "Saving…",
  cancel: "Cancel",
  remove: "Remove",
  removeDay: "Remove {day}",
  specialDay: "Special day",
  replaces: "This date already has special hours. Saving replaces them.",
  dateRange: "Pick a date from today up to a year ahead.",
  savedToast: "Special day saved.",
  savedUnreadToast: "Special day saved. Droplet couldn't show the latest version yet. Refresh to see it.",
  removedToast: "Special day removed.",
  // A lost race on the hours version: the page has re-read, so the list shows the latest.
  conflictToast: "Someone else changed the opening hours just now, so nothing was changed. The latest hours are showing now. Try again.",
} as const;

/** Special days can be added this many days ahead of the site's today (the server allows 366). */
export const EXCEPTION_MAX_DAYS_AHEAD = 366;
export const NOTE_MAX = 80;

const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Everything but `expectedVersion`, which the page adds from the hours it read. */
export type SpecialDayInput = Omit<SecurityHoursExceptionBody, "expectedVersion">;

/**
 * What the server refuses in a note (routes/security-site.ts, via
 * `hasUnsafeDisplayChars`): C0/C1 controls, line and paragraph separators,
 * bidi embeddings / overrides / isolates, U+FEFF.
 */
const NOTE_UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069\uFEFF]/gu;

/**
 * The PUT body for one special day: times only when Open, the note trimmed
 * and omitted when empty. The characters the server refuses (a pasted tab, a
 * bidi override) are dropped here rather than bounced as a VALIDATION_ERROR —
 * the note is shown to every Security viewer and signed into the audit chain.
 */
export function buildExceptionInput(day: DayDraft, note: string): SpecialDayInput {
  const trimmed = note.replace(NOTE_UNSAFE, "").trim();
  return {
    kind: day.kind,
    ...(day.kind === "hours" ? { opens: day.opens, closes: day.closes } : {}),
    ...(trimmed ? { note: trimmed } : {}),
  };
}

export interface ExceptionsEditorProps {
  exceptions: readonly SecurityHoursException[];
  /** Whether usual hours are set — special days need them (the server answers HOURS_NOT_SET). */
  hoursSet: boolean;
  /** The site's today, 'YYYY-MM-DD', in the SITE timezone. null when hours are not set. */
  today: string | null;
  canManage: boolean;
  /** PUT …/exceptions/:date. Resolves true when saved; the page renders any error. */
  onSave: (date: string, input: SpecialDayInput) => Promise<boolean>;
  /** DELETE …/exceptions/:date. Resolves true when removed. */
  onDelete: (date: string) => Promise<boolean>;
}

export function ExceptionsEditor({ exceptions, hoursSet, today, canManage, onSave, onDelete }: ExceptionsEditorProps) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  // Upcoming only: the server also returns the site's yesterday (its late
  // hours may still be running), which is not something to plan around.
  const upcoming = [...exceptions]
    .filter((e) => today === null || e.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  const remove = async (date: string) => {
    setRemoving(date);
    try {
      await onDelete(date);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section className="card" aria-labelledby="security-special-days-title" data-testid="special-days">
      <div className="card-h">
        <span className="ci">
          <CalendarDays size={16} />
        </span>
        <h2 className="ct" id="security-special-days-title" style={{ margin: 0 }}>
          {COPY.title}
        </h2>
      </div>
      <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--text-muted)", maxWidth: "70ch" }}>{COPY.explainer}</p>

      {upcoming.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--text)" }}>{COPY.empty}</p>
      ) : (
        <ul className="rows" style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {upcoming.map((e) => {
            const when = today ? formatSiteDate(e.date, today) : e.date;
            return (
              <li className="lrow" key={e.date} data-date={e.date}>
                <span className="rt">
                  <span className="nm">{when}</span>
                  {/* The note is the owner's own words: wrap it rather than ellipsize it away on a phone. */}
                  <span className="sub" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                    {describeDay(e)}
                    {e.note ? ` · ${e.note}` : ""}
                  </span>
                </span>
                {canManage && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    aria-label={fill(COPY.removeDay, { day: when })}
                    disabled={removing !== null}
                    onClick={() => void remove(e.date)}
                  >
                    {removing === e.date && <Loader2 size={14} className="animate-spin" aria-hidden />}
                    {COPY.remove}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {canManage && !hoursSet && (
        <p style={{ margin: "12px 0 0", fontSize: 13, color: "var(--text-muted)" }}>{COPY.needsHours}</p>
      )}

      {canManage && hoursSet && today && !adding && (
        <button type="button" className="btn" style={{ marginTop: 14 }} onClick={() => setAdding(true)}>
          <Plus size={16} aria-hidden />
          {COPY.add}
        </button>
      )}

      {canManage && hoursSet && today && adding && (
        <AddSpecialDay
          today={today}
          existing={exceptions}
          onCancel={() => setAdding(false)}
          onSave={async (date, input) => {
            const ok = await onSave(date, input);
            if (ok) setAdding(false);
          }}
        />
      )}
    </section>
  );
}

function AddSpecialDay({
  today,
  existing,
  onCancel,
  onSave,
}: {
  today: string;
  existing: readonly SecurityHoursException[];
  onCancel: () => void;
  onSave: (date: string, input: SpecialDayInput) => Promise<void>;
}) {
  const uid = useId();
  const [date, setDate] = useState("");
  const [day, setDay] = useState<DayDraft>({ kind: "closed", opens: "", closes: "" });
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const max = ymdAddDays(today, EXCEPTION_MAX_DAYS_AHEAD);
  const dateOk = isYmd(date) && date >= today && date <= max;
  const valid = dateOk && dayProblem(day) === null && note.trim().length <= NOTE_MAX;
  const replaces = dateOk && existing.some((e) => e.date === date);

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await onSave(date, buildExceptionInput(day, note));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      aria-label={COPY.add}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      style={{
        marginTop: 14,
        paddingTop: 14,
        borderTop: "1px solid var(--card-bd)",
        display: "flex",
        flexDirection: "column",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 220 }}>
        <label htmlFor={`${uid}-date`} style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {COPY.date}
        </label>
        <input
          id={`${uid}-date`}
          type="date"
          value={date}
          min={today}
          max={max}
          onChange={(e) => setDate(e.target.value)}
          aria-invalid={date !== "" && !dateOk}
          aria-describedby={date !== "" && !dateOk ? `${uid}-date-msg` : undefined}
          className="w-full px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[color:var(--text)] focus:border-[var(--brand)]"
        />
        {date !== "" && !dateOk && (
          <p id={`${uid}-date-msg`} role="alert" style={{ margin: 0, fontSize: 12.5, color: "var(--danger)" }}>
            {COPY.dateRange}
          </p>
        )}
        {replaces && <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)" }}>{COPY.replaces}</p>}
      </div>

      <DayHoursFields value={day} onChange={setDay} groupLabel={COPY.specialDay} />

      <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 420 }}>
        <label htmlFor={`${uid}-note`} style={{ fontSize: 12, color: "var(--text-muted)" }}>
          {COPY.note}
        </label>
        <input
          id={`${uid}-note`}
          type="text"
          value={note}
          maxLength={NOTE_MAX}
          placeholder={COPY.notePlaceholder}
          onChange={(e) => setNote(e.target.value)}
          className="w-full px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[color:var(--text)] focus:border-[var(--brand)]"
        />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <button type="submit" className="btn primary" disabled={!valid || saving}>
          {saving && <Loader2 size={16} className="animate-spin" aria-hidden />}
          {saving ? COPY.saving : COPY.save}
        </button>
        <button type="button" className="btn ghost" disabled={saving} onClick={onCancel}>
          {COPY.cancel}
        </button>
      </div>
    </form>
  );
}
