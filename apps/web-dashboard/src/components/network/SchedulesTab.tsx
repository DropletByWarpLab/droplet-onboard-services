"use client";
import { useState } from "react";
import { useSchedules } from "@/lib/hooks/useSchedules";
import { ScheduleRow } from "./ScheduleRow";
import { ScheduleActivityFeed } from "./ScheduleActivityFeed";
import { ScheduleEditorModal } from "./ScheduleEditorModal";
import { SchedulePresetCards } from "./SchedulePresetCards";
import { OverrideModal } from "./OverrideModal";
import { isRecurringPreset } from "./schedule-presets";
import type {
  SchedulePreset,
  RecurringSchedulePresetId,
} from "./schedule-presets";

type EditorState =
  | { mode: "new"; preset?: SchedulePreset }
  | { mode: "edit"; id: string }
  | null;

export function SchedulesTab() {
  const { data, isLoading } = useSchedules();
  const [editorOpenFor, setEditorOpenFor] = useState<EditorState>(null);
  const [overrideModalOpen, setOverrideModalOpen] =
    useState<SchedulePreset | null>(null);
  const schedules = data?.schedules ?? [];

  const scheduleIdProp =
    editorOpenFor === null
      ? null
      : editorOpenFor.mode === "new"
        ? "new"
        : editorOpenFor.id;

  // Any recurring preset in SCHEDULE_PRESETS flows through `initialPreset`;
  // the modal delegates to `presetById` for both the name and the windows.
  // Override presets (e.g. `homework`) open `OverrideModal` instead, so they
  // don't reach this branch.
  const initialPresetProp: RecurringSchedulePresetId | undefined =
    editorOpenFor?.mode === "new" &&
    editorOpenFor.preset &&
    isRecurringPreset(editorOpenFor.preset)
      ? editorOpenFor.preset.id
      : undefined;

  return (
    <div className="space-y-6">
      {/* Preset cards (WARP-99 / T8) */}
      <SchedulePresetCards
        onUseRecurring={(preset) =>
          setEditorOpenFor({ mode: "new", preset })
        }
        onUseOverride={(preset) => setOverrideModalOpen(preset)}
      />

      {/* Schedules list */}
      <section aria-labelledby="schedules-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2
            id="schedules-heading"
            className="type-title-3 text-[color:var(--text)]"
          >
            Schedules
          </h2>
          <button
            type="button"
            onClick={() => setEditorOpenFor({ mode: "new" })}
            className="btn primary"
          >
            + New schedule
          </button>
        </div>
        {isLoading ? (
          <div className="card text-[color:var(--text-muted)]">Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="card text-center">
            <p className="type-headline text-[color:var(--text)]">
              No schedules yet
            </p>
            <p className="type-footnote text-[color:var(--text-muted)] mt-1">
              Pick a preset above, or create a custom schedule.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {schedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                onEdit={() => setEditorOpenFor({ mode: "edit", id: s.id })}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Recent activity */}
      <ScheduleActivityFeed />

      {/* Editor modal (WARP-96 / T5) */}
      <ScheduleEditorModal
        scheduleId={scheduleIdProp}
        initialPreset={initialPresetProp}
        onClose={() => setEditorOpenFor(null)}
      />

      {/* Override modal — launched from the Homework preset card (WARP-99 / T8).
          Subject is intentionally blank; the modal's subject picker lets the
          user choose a device or group at apply-time. */}
      {overrideModalOpen && (
        <OverrideModal
          subject={{ type: "device" }}
          defaultAction="block"
          defaultDurationMin={overrideModalOpen.overrideDurationMin}
          onClose={() => setOverrideModalOpen(null)}
        />
      )}
    </div>
  );
}
