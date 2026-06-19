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
  formatLocalTime,
  isDaily,
  localTimezoneLabel,
  type DayCode,
} from "@/lib/scene-rrule";
import { describeRrule } from "@/lib/rrule-describe";

/**
 * Schedule a routine (Scene) on a recurring cadence — owner/admin only.
 * Wired to GET/POST/PATCH/DELETE /api/scenes/:id/schedules via
 * useSceneSchedules. The owner picks day chips + a local time; the editor
 * converts that LOCAL wall-clock to a UTC RRULE (the orchestrator's parser
 * is UTC-only) and says so plainly, because a "7am" routine that silently
 * fired at 7am UTC would be the single biggest trap here.
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
      await create(built.rrule);
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
      <div className="p-5">
        <div className="flex items-start gap-3 mb-1">
          <span
            className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 bg-accent-subtle text-accent"
            aria-hidden
          >
            <CalendarClock size={18} />
          </span>
          <div className="min-w-0">
            <h2 id={headingId} className="type-title-3 text-label-primary">
              Schedule “{sceneName}”
            </h2>
            <p className="type-subheadline text-label-tertiary">
              Run this routine automatically on a repeating cadence.
            </p>
          </div>
        </div>

        {/* New-schedule form */}
        <div className="mt-4 dp-card p-4 space-y-4">
          <div>
            <span className="type-subheadline text-label-secondary block mb-2">
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
                    className={[
                      "px-3 py-1.5 rounded-full type-footnote font-medium",
                      "transition-colors duration-150 ease-smooth",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      active
                        ? "bg-accent text-accent-foreground"
                        : "bg-surface-secondary text-label-secondary hover:text-label-primary",
                    ].join(" ")}
                  >
                    {dayLabel(d)}
                  </button>
                );
              })}
            </div>
            {isDaily(days) && (
              <p className="type-caption-1 text-label-tertiary mt-1.5">
                No day selected — runs <strong className="font-medium">every day</strong>.
              </p>
            )}
          </div>

          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label
                htmlFor={timeId}
                className="type-subheadline text-label-secondary block mb-1.5"
              >
                Time
              </label>
              <input
                id={timeId}
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="dp-input w-36"
              />
            </div>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!canAdd}
              className="dp-btn-primary flex items-center gap-2"
            >
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
              Add schedule
            </button>
          </div>

          {/* UTC honesty line — the single most important affordance here. */}
          <p className="flex items-start gap-2 type-caption-1 text-label-tertiary">
            <Clock size={13} className="mt-0.5 flex-shrink-0" aria-hidden />
            <span>
              {built ? describeLocalSchedule(draft) : "Pick a valid time"} —{" "}
              shown in <strong className="font-medium text-label-secondary">{tz}</strong> (your
              local time). Saved and run in UTC, so it always fires at{" "}
              <strong className="font-medium text-label-secondary">
                {formatLocalTime(hour, minute)}
              </strong>{" "}
              where you are.
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
          <h3 className="type-subheadline text-label-secondary mb-2">
            Active schedules
          </h3>

          {isLoading ? (
            <div className="flex items-center gap-2 py-6 text-label-tertiary justify-center">
              <Loader2 size={16} className="animate-spin" />
              <span className="type-subheadline">Loading…</span>
            </div>
          ) : error ? (
            <p className="type-subheadline text-system-red">
              Couldn’t load schedules.
            </p>
          ) : schedules.length === 0 ? (
            <div className="rounded-lg border border-dashed border-label-quaternary/40 px-4 py-6 text-center">
              <p className="type-subheadline text-label-secondary">No schedules yet</p>
              <p className="type-caption-1 text-label-tertiary mt-0.5">
                Add one above to run this routine on a repeating cadence.
              </p>
            </div>
          ) : (
            <ul className="space-y-2">
              {schedules.map((s) => {
                let summary: string;
                try {
                  summary = describeRrule(s.rrule);
                } catch {
                  summary = PARSE_FAIL;
                }
                return (
                  <li
                    key={s.id}
                    className="flex items-center gap-3 bg-surface-secondary/60 rounded-lg px-3 py-2.5"
                  >
                    <span className="text-label-tertiary flex-shrink-0" aria-hidden>
                      <Clock size={16} />
                    </span>
                    <div className="flex-1 min-w-0">
                      <p
                        className={[
                          "type-subheadline truncate",
                          s.enabled ? "text-label-primary" : "text-label-tertiary",
                        ].join(" ")}
                      >
                        {summary}
                      </p>
                      <p className="type-caption-2 text-label-tertiary">
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
                      className="text-label-tertiary hover:text-system-red transition-colors p-1"
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
