"use client";

import { useId, useMemo, useState } from "react";
import { Clock, Plus, Trash2, Loader2, AlertCircle, CalendarClock } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { ToggleSwitch } from "./ToggleSwitch";
import { useSceneSchedules } from "@/lib/hooks/useSceneSchedules";
import {
  ALL_DAYS,
  buildSceneRrule,
  describeLocalSchedule,
  dayLabel,
  isDaily,
  localTimezoneLabel,
  type DayCode,
} from "@/lib/scene-rrule";
import { describeRrule } from "@/lib/rrule-describe";

/**
 * Schedule a routine (Scene) on a recurring cadence — owner/admin only.
 * Wired to GET/POST/PATCH/DELETE /api/scenes/:id/schedules via
 * useSceneSchedules. The owner picks day chips + a local time; the editor
 * stores that LOCAL wall-clock verbatim plus the browser's IANA timezone
 * (KAN-6). The orchestrator recomputes each fire against that zone, so a
 * "7am" routine keeps firing at 7am local across a daylight-saving change —
 * the pre-KAN-6 UTC-only behaviour drifted it an hour, which is why the old
 * editor carried a DST caveat. That caveat is gone now; the copy just names
 * the zone.
 *
 * Motion is restraint-first: the Dialog owns the open/close transition and
 * the ToggleSwitch its own 200ms flip — nothing else animates. Chip
 * selection is an instant token swap (a state change, not a flourish).
 */

const PARSE_FAIL = "Couldn't read this schedule's rule.";

export function SceneScheduleEditor({
  sceneId,
  sceneName,
  onClose,
}: {
  sceneId: string;
  sceneName: string;
  onClose: () => void;
}) {
  const headingId = useId();
  const timeId = useId();
  const { schedules, isLoading, error, create, toggle, remove } =
    useSceneSchedules(sceneId);

  // Draft for the new schedule. Default: every day at 7:00 AM local.
  const [days, setDays] = useState<DayCode[]>([]); // empty = every day
  const [time, setTime] = useState("07:00");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [hour, minute] = useMemo(() => {
    const [h, m] = time.split(":");
    return [Number.parseInt(h ?? "0", 10), Number.parseInt(m ?? "0", 10)];
  }, [time]);

  const draft = { days, hour, minute };
  const built = buildSceneRrule(draft);
  const tz = localTimezoneLabel();
  const canAdd = !saving && built !== null;

  function toggleDay(d: DayCode) {
    setDays((cur) => {
      // The chip row starts in "every day" (none selected). First click
      // selects a single day; clicking an active one removes it (back to
      // every-day when the last is cleared).
      if (cur.includes(d)) return cur.filter((x) => x !== d);
      return [...cur, d];
    });
  }

  async function handleAdd() {
    if (!built) return;
    setSaving(true);
    setFormError(null);
    try {
      // KAN-6 — send the wall-clock rrule AND the browser's IANA zone so the
      // server stores the zone and recomputes each fire against it (no DST
      // drift). The orchestrator defaults to UTC if timezone is omitted.
      await create(built.rrule, built.timezone);
      // Reset to the default cadence for the next add.
      setDays([]);
      setTime("07:00");
    } catch (e) {
      setFormError(
        e instanceof Error ? e.message : "Couldn't save this schedule.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} labelledBy={headingId} maxWidth="lg">
      {/* Body padding comes from the <Dialog> primitive (WARP-1153). */}
      <div>
        <div className="flex items-start gap-3 mb-1">
          <span
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
            aria-hidden
          >
            <CalendarClock size={18} />
          </span>
          <div className="min-w-0">
            <h2 id={headingId} className="type-title-3" style={{ color: "var(--text)" }}>
              Schedule “{sceneName}”
            </h2>
            <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
              Run this routine automatically on a repeating cadence.
            </p>
          </div>
        </div>

        {/* New-schedule form */}
        <div className="mt-4 card space-y-4" style={{ padding: "16px" }}>
          <div>
            <span className="type-subheadline block mb-2" style={{ color: "var(--text-muted)" }}>
              Repeat on
            </span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days to repeat">
              {ALL_DAYS.map((d) => {
                const active = days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={active}
                    onClick={() => toggleDay(d)}
                    className={`chip ${active ? "on" : ""} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]`}
                  >
                    {dayLabel(d)}
                  </button>
                );
              })}
            </div>
            {isDaily(days) && (
              <p className="type-caption-1 mt-1.5" style={{ color: "var(--text-muted)" }}>
                No day selected — runs <strong className="font-medium">every day</strong>.
              </p>
            )}
          </div>

          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label
                htmlFor={timeId}
                className="type-subheadline block mb-1.5"
                style={{ color: "var(--text-muted)" }}
              >
                Time
              </label>
              <input
                id={timeId}
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="w-36 px-3 py-2.5 rounded-[var(--radius-input)] outline-none transition-colors bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] focus:border-[var(--brand)]"
              />
            </div>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!canAdd}
              className="btn primary"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              Add schedule
            </button>
          </div>

          {/* Confirmation line — leads with what the routine will do, then
              names the zone. KAN-6 stores the zone per row, so this fires at
              the chosen local time and stays correct across daylight-saving
              changes; no caveat needed. */}
          <p className="flex items-start gap-2 type-caption-1" style={{ color: "var(--text-muted)" }}>
            <Clock size={13} className="mt-0.5 flex-shrink-0" aria-hidden />
            <span>
              <span style={{ color: "var(--text-muted)" }}>
                {built ? describeLocalSchedule(draft) : "Pick a valid time"}
              </span>{" "}
              in <strong className="font-medium" style={{ color: "var(--text-muted)" }}>{tz}</strong> (your
              local time).
            </span>
          </p>

          {formError && (
            <div
              role="alert"
              className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
            >
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" aria-hidden />
              <span>{formError}</span>
            </div>
          )}
        </div>

        {/* Existing schedules */}
        <div className="mt-5">
          <h3 className="type-subheadline mb-2" style={{ color: "var(--text-muted)" }}>
            Active schedules
          </h3>

          {isLoading ? (
            <div className="flex items-center gap-2 py-6 justify-center" style={{ color: "var(--text-muted)" }}>
              <Loader2 size={16} className="animate-spin" />
              <span className="type-subheadline">Loading…</span>
            </div>
          ) : error ? (
            <p className="type-subheadline text-system-red">
              Couldn’t load schedules.
            </p>
          ) : schedules.length === 0 ? (
            <div
              className="rounded-lg border border-dashed px-4 py-6 text-center"
              style={{ borderColor: "var(--card-bd)" }}
            >
              <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>No schedules yet</p>
              <p className="type-caption-1 mt-0.5" style={{ color: "var(--text-muted)" }}>
                Add one above to run this routine on a repeating cadence.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {schedules.map((s) => {
                let summary: string;
                try {
                  // KAN-6 — the rrule's wall-clock is local to s.timezone.
                  summary = describeRrule(s.rrule, s.timezone);
                } catch {
                  summary = PARSE_FAIL;
                }
                return (
                  <li
                    key={s.id}
                    className="flex items-center gap-3 rounded-lg px-3 py-2.5"
                    style={{ background: "var(--card-inner)" }}
                  >
                    <span className="flex-shrink-0" style={{ color: "var(--text-muted)" }} aria-hidden>
                      <Clock size={16} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p
                        className="type-subheadline truncate"
                        style={{ color: s.enabled ? "var(--text)" : "var(--text-muted)" }}
                      >
                        {summary}
                      </p>
                      <p className="type-caption-2" style={{ color: "var(--text-muted)" }}>
                        {s.enabled
                          ? `Next: ${new Date(s.nextFireAt).toLocaleString()}`
                          : "Paused"}
                      </p>
                    </div>
                    <ToggleSwitch
                      on={s.enabled}
                      onToggle={() => void toggle(s.id, !s.enabled)}
                    />
                    <button
                      type="button"
                      onClick={() => void remove(s.id)}
                      aria-label="Remove schedule"
                      className="transition-colors p-1 text-[var(--text-muted)] hover:text-system-red"
                    >
                      <Trash2 size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex justify-end pt-4">
          <button type="button" onClick={onClose} className="btn ghost">
            Done
          </button>
        </div>
      </div>
    </Dialog>
  );
}
