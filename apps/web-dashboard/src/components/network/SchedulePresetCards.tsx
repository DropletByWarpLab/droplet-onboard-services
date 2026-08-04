"use client";
import * as Icons from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SCHEDULE_PRESETS, type SchedulePreset } from "./schedule-presets";

/**
 * Top-row preset picker on the Schedules tab (WARP-99 / T8).
 *
 * Three cards — Bedtime, School hours, Homework mode. The first two open the
 * full schedule editor pre-filled with the preset's windows + name; Homework
 * opens the override picker with a 90-minute duration chip pre-selected and
 * a blank subject (user picks inside the modal).
 */

interface Props {
  /** Fired for `kind === "recurring"` presets. Opens `ScheduleEditorModal`. */
  onUseRecurring: (preset: SchedulePreset) => void;
  /** Fired for `kind === "override"` presets. Opens `OverrideModal`. */
  onUseOverride: (preset: SchedulePreset) => void;
}

function iconFor(name: string): LucideIcon {
  const lib = Icons as unknown as Record<string, LucideIcon | undefined>;
  return lib[name] ?? Icons.Sparkles;
}

export function SchedulePresetCards({ onUseRecurring, onUseOverride }: Props) {
  return (
    <section aria-label="Schedule presets">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {SCHEDULE_PRESETS.map((preset) => {
          const Icon = iconFor(preset.icon);
          return (
            <div
              key={preset.id}
              data-testid={`preset-card-${preset.id}`}
              className="card flex flex-col gap-2"
            >
              <div className="flex items-center gap-2">
                <Icon
                  className="w-5 h-5 text-[color:var(--text-muted)]"
                  aria-hidden="true"
                  data-testid={`preset-icon-${preset.id}`}
                />
                <span className="type-headline text-[color:var(--text)]">
                  {preset.name}
                </span>
              </div>
              <p className="type-footnote text-[color:var(--text-muted)]">
                {preset.description}
              </p>
              <div className="pt-1">
                <button
                  type="button"
                  onClick={() => {
                    if (preset.kind === "recurring") onUseRecurring(preset);
                    else onUseOverride(preset);
                  }}
                  className="btn sm"
                >
                  Use preset
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
