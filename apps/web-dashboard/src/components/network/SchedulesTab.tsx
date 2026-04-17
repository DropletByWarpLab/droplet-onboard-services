"use client";
import { useState } from "react";
import { useSchedules } from "@/lib/hooks/useSchedules";
import { ScheduleRow } from "./ScheduleRow";
import { ScheduleActivityFeed } from "./ScheduleActivityFeed";
import { ScheduleEditorModal } from "./ScheduleEditorModal";

export function SchedulesTab() {
  const { data, isLoading } = useSchedules();
  const [editorOpenFor, setEditorOpenFor] = useState<string | "new" | null>(
    null,
  );
  const schedules = data?.schedules ?? [];

  return (
    <div className="space-y-6">
      {/* Preset placeholder — real preset cards land in WARP-99 / T8. */}
      <section aria-label="Presets">
        <div className="dp-card p-4 text-label-tertiary type-footnote">
          Presets coming soon (WARP-99 / T8)
        </div>
      </section>

      {/* Schedules list */}
      <section aria-labelledby="schedules-heading" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="schedules-heading" className="type-title-3 text-label-primary">
            Schedules
          </h2>
          <button
            type="button"
            onClick={() => setEditorOpenFor("new")}
            className="dp-button-primary"
          >
            + New schedule
          </button>
        </div>
        {isLoading ? (
          <div className="dp-card p-4 text-label-tertiary">Loading…</div>
        ) : schedules.length === 0 ? (
          <div className="dp-card p-6 text-center">
            <p className="type-headline text-label-primary">No schedules yet</p>
            <p className="type-footnote text-label-tertiary mt-1">
              Pick a preset above, or create a custom schedule.
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {schedules.map((s) => (
              <ScheduleRow
                key={s.id}
                schedule={s}
                onEdit={() => setEditorOpenFor(s.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Recent activity */}
      <ScheduleActivityFeed />

      {/* Editor modal (WARP-96 / T5) */}
      <ScheduleEditorModal
        scheduleId={editorOpenFor}
        onClose={() => setEditorOpenFor(null)}
      />
    </div>
  );
}
