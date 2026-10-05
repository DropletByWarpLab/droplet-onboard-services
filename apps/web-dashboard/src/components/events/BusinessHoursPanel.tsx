"use client";

import { useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { useAuth } from "@/lib/auth";
import type { BusinessDay, CameraBusinessHours } from "@/lib/types";

const DAYS: BusinessDay[] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const DAY_LABEL = (day: BusinessDay) => day.charAt(0).toUpperCase() + day.slice(1);
const INPUT_CLASS = "px-3 py-2 rounded-[var(--radius-input)] outline-none bg-[var(--surface)] border border-[var(--border)] text-[color:var(--text)] focus:border-[var(--brand)] type-footnote";

function newSchedule(): CameraBusinessHours {
  return {
    configured: true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    days: Object.fromEntries(DAYS.map((day, i) => [day, i < 5 ? { open: "09:00", close: "17:00" } : null])) as CameraBusinessHours["days"],
  };
}

export function BusinessHoursPanel({ schedule, isLoading, error, onRetry, onSave, activityCount, outsideCount, activityLoading, activityError, hasMore }: {
  schedule: CameraBusinessHours | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  onSave: (schedule: CameraBusinessHours) => Promise<void>;
  activityCount: number;
  outsideCount: number;
  activityLoading: boolean;
  activityError: unknown;
  hasMore: boolean;
}) {
  const { user } = useAuth();
  const canManage = user?.role === "owner" || user?.role === "admin";
  const [draft, setDraft] = useState<CameraBusinessHours | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const timezoneOptions = useMemo(() => {
    const timezoneIntl = Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] };
    const commonZones = ["America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "Europe/Paris", "Asia/Tokyo", "Australia/Sydney"];
    const zones = timezoneIntl.supportedValuesOf?.("timeZone") ?? commonZones;
    return Array.from(new Set(["UTC", Intl.DateTimeFormat().resolvedOptions().timeZone, draft?.timezone, ...zones].filter((zone): zone is string => Boolean(zone)))).sort();
  }, [draft?.timezone]);

  function edit() {
    setDraft(schedule && (schedule.configured || Object.values(schedule.days).some(Boolean)) ? { ...structuredClone(schedule), configured: true } : newSchedule());
    setSaveError(null);
    setSaved(false);
  }

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setDraft(null);
      setSaved(true);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Could not save business hours");
    } finally {
      setSaving(false);
    }
  }

  const invalidDay = draft && DAYS.find((day) => {
    const window = draft.days[day];
    return window && (!/^([01]\d|2[0-3]):[0-5]\d$/.test(window.open)
      || !/^(([01]\d|2[0-3]):[0-5]\d|24:00)$/.test(window.close)
      || window.open === window.close);
  });

  return (
    <section className="card space-y-3" aria-label="Business hours settings">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 type-subheadline font-medium">
          <Clock size={16} /> Business hours
        </div>
        {canManage && schedule && !draft && (
          <button type="button" className="btn ghost sm" onClick={edit}>
            {schedule.configured ? "Edit hours" : "Set business hours"}
          </button>
        )}
      </div>
      {isLoading && <p className="type-footnote text-[color:var(--text-muted)]">Loading business hours…</p>}
      {error ? (
        <div role="alert" className="type-footnote">
          Could not load business hours. <button type="button" className="btn ghost sm" onClick={onRetry}>Retry hours</button>
        </div>
      ) : schedule && !draft && (
        schedule.configured ? (
          <>
            <p className="type-footnote text-[color:var(--text-muted)]">{schedule.timezone} · Outside hours includes closed days.</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 type-caption-1 text-[color:var(--text-muted)]">
              {DAYS.map((day) => (
                <span key={day}>{DAY_LABEL(day).slice(0, 3)}: {schedule.days[day] ? `${schedule.days[day]!.open}–${schedule.days[day]!.close}${schedule.days[day]!.close < schedule.days[day]!.open ? " (next day)" : ""}` : "Closed"}</span>
              ))}
            </div>
            <p className="type-footnote" role="status">
              {activityError ? "After-hours activity is unavailable while camera activity cannot be loaded."
                : activityLoading ? "Checking after-hours activity…"
                : `${outsideCount} outside business hours in ${activityCount} loaded results.${hasMore ? " Load more to check older activity." : ""}`}
            </p>
            <p className="type-caption-1 text-[color:var(--text-muted)]">Activity is outside hours when any part of it falls outside the saved schedule.</p>
          </>
        ) : (
          <p className="type-footnote text-[color:var(--text-muted)]">
            Business hours have not been set. {canManage ? "Save a weekly schedule to identify after-hours movement." : "Ask an owner or admin to set the weekly schedule."}
          </p>
        )
      )}
      {saved && <p role="status" className="type-footnote">Business hours saved.</p>}
      {draft && (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-3">
          <label className="flex items-center gap-2 type-footnote">
            <input type="checkbox" checked={draft.configured} disabled={saving} onChange={(e) => setDraft({ ...draft, configured: e.target.checked })} />
            Identify activity outside business hours
          </label>
          <label className="block type-footnote">
            Time zone
            <select
              required
              aria-label="Business hours time zone"
              value={draft.timezone}
              disabled={saving}
              onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
              className={`${INPUT_CLASS} w-full mt-1`}
              style={{ maxWidth: 360 }}
            >
              {timezoneOptions.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, " ").replace(/\//g, " / ")}</option>)}
            </select>
          </label>
          <p className="type-caption-1 text-[color:var(--text-muted)]">Choose the business&apos;s local time zone. Times use a 24-hour clock. Closed days count as outside hours.</p>
          <div className="space-y-2">
            {DAYS.map((day) => {
              const window = draft.days[day];
              return (
                <div key={day} className="flex flex-wrap items-center gap-3" role="group" aria-label={DAY_LABEL(day)}>
                  <label className="flex items-center gap-2 type-footnote" style={{ minWidth: 120 }}>
                    <input
                      type="checkbox"
                      aria-label={`${DAY_LABEL(day)} open`}
                      checked={window !== null}
                      disabled={saving}
                      onChange={(e) => setDraft({ ...draft, days: { ...draft.days, [day]: e.target.checked ? { open: "09:00", close: "17:00" } : null } })}
                    />
                    {DAY_LABEL(day)}
                  </label>
                  {window ? (
                    <>
                      <input type="time" required aria-label={`${DAY_LABEL(day)} opens`} className={INPUT_CLASS} value={window.open} disabled={saving} onChange={(e) => setDraft({ ...draft, days: { ...draft.days, [day]: { ...window, open: e.target.value } } })} />
                      <span className="type-caption-1 text-[color:var(--text-muted)]">to</span>
                      <input type="text" required aria-label={`${DAY_LABEL(day)} closes`} className={INPUT_CLASS} value={window.close} placeholder="17:00" pattern="([01][0-9]|2[0-3]):[0-5][0-9]|24:00" style={{ width: 100 }} disabled={saving} onChange={(e) => setDraft({ ...draft, days: { ...draft.days, [day]: { ...window, close: e.target.value } } })} />
                      {window.close < window.open && <span className="type-caption-1 text-[color:var(--text-muted)]">Ends next day</span>}
                    </>
                  ) : <span className="type-caption-1 text-[color:var(--text-muted)]">Closed</span>}
                </div>
              );
            })}
          </div>
          <p className="type-caption-1 text-[color:var(--text-muted)]">A closing time before opening continues into the next day. Use 00:00–24:00 for all day. Changes apply to past and new activity.</p>
          {invalidDay && <p role="alert" className="type-footnote">{DAY_LABEL(invalidDay)} needs different opening and closing times in HH:mm format.</p>}
          {saveError && <p role="alert" className="type-footnote">{saveError}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn primary sm" disabled={saving || Boolean(invalidDay)}>{saving ? "Saving…" : "Save hours"}</button>
            <button type="button" className="btn ghost sm" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
