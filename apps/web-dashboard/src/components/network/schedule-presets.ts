/**
 * Canned preset templates rendered on the Schedules tab (WARP-99 / T8).
 *
 * Also the single source of truth for the Bedtime preset consumed by
 * `QuickSchedulePopover` and `ScheduleEditorModal` — callers should import
 * from here rather than hard-coding window bitmasks inline.
 */

export interface SchedulePresetWindow {
  /** Day-of-week bitmask: Sun=1, Mon=2, Tue=4, Wed=8, Thu=16, Fri=32, Sat=64. */
  daysOfWeek: number;
  /** Start minute-of-day, [0, 1440). */
  startMin: number;
  /** End minute-of-day, [0, 1440). If endMin <= startMin, window wraps past midnight. */
  endMin: number;
}

export interface SchedulePreset {
  id: "bedtime" | "school" | "homework";
  name: string;
  kind: "recurring" | "override";
  description: string;
  /** Lucide icon name; looked up against the `lucide-react` namespace at render time. */
  icon: string;
  /** Pre-filled windows for `recurring` presets. Undefined for overrides. */
  windows?: SchedulePresetWindow[];
  /** Duration chip pre-selection for `override` presets. Undefined for recurring. */
  overrideDurationMin?: number;
}

export const SCHEDULE_PRESETS: SchedulePreset[] = [
  {
    id: "bedtime",
    name: "Bedtime",
    kind: "recurring",
    description: "Sun–Thu 9pm–7am, Fri–Sat 11pm–8am",
    icon: "Moon",
    windows: [
      // Sun=1, Mon=2, Tue=4, Wed=8, Thu=16 → 31
      { daysOfWeek: 31, startMin: 21 * 60, endMin: 7 * 60 },
      // Fri=32, Sat=64 → 96
      { daysOfWeek: 96, startMin: 23 * 60, endMin: 8 * 60 },
    ],
  },
  {
    id: "school",
    name: "School hours",
    kind: "recurring",
    description: "Mon–Fri 8am–3pm",
    icon: "Backpack",
    windows: [
      // Mon=2, Tue=4, Wed=8, Thu=16, Fri=32 → 62
      { daysOfWeek: 62, startMin: 8 * 60, endMin: 15 * 60 },
    ],
  },
  {
    id: "homework",
    name: "Homework mode",
    kind: "override",
    description: "Block for 90 minutes",
    icon: "Clock",
    overrideDurationMin: 90,
  },
];

export function presetById(
  id: SchedulePreset["id"],
): SchedulePreset | undefined {
  return SCHEDULE_PRESETS.find((p) => p.id === id);
}
