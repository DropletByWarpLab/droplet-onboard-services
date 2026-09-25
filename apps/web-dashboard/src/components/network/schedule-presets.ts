/**
 * Canned preset templates rendered on the Schedules tab (WARP-99 / T8).
 *
 * Also the single source of truth for the After-hours preset consumed by
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

export const SCHEDULE_PRESETS = [
  // Business-only build: the `bedtime` / `school` ids are persisted in
  // existing schedules and never user-visible, so they stay; the display
  // names and default windows are business ones (same rule as `homework`).
  {
    id: "bedtime",
    name: "After hours",
    kind: "recurring",
    description: "Every day 7pm–7am",
    icon: "Moon",
    windows: [
      // Sun..Sat → 127
      { daysOfWeek: 127, startMin: 19 * 60, endMin: 7 * 60 },
    ],
  },
  {
    id: "school",
    name: "Business hours",
    kind: "recurring",
    description: "Mon–Fri 9am–5pm",
    icon: "Briefcase",
    windows: [
      // Mon=2, Tue=4, Wed=8, Thu=16, Fri=32 → 62
      { daysOfWeek: 62, startMin: 9 * 60, endMin: 17 * 60 },
    ],
  },
  {
    // WARP-1341: display name went business-neutral ("Focus mode"); the
    // wire/registry id stays `homework` — it's persisted in existing
    // schedules and never user-visible.
    id: "homework",
    name: "Focus mode",
    kind: "override",
    description: "Block for 90 minutes",
    icon: "Clock",
    overrideDurationMin: 90,
  },
] as const satisfies readonly SchedulePreset[];

/** Every preset id in the registry (`"bedtime" | "school" | "homework"`). */
export type SchedulePresetId = (typeof SCHEDULE_PRESETS)[number]["id"];

/**
 * Ids of the `recurring` presets only (`"bedtime" | "school"`) — the ones that
 * flow through `ScheduleEditorModal`. Derived from the registry via `as const`
 * literal preservation, so adding a new `kind: "recurring"` preset to
 * `SCHEDULE_PRESETS` widens this union automatically with no other edits
 * (WARP-102). Override presets (e.g. `homework`) are excluded by `Extract`.
 */
export type RecurringSchedulePresetId = Extract<
  (typeof SCHEDULE_PRESETS)[number],
  { kind: "recurring" }
>["id"];

export function presetById(
  id: SchedulePresetId,
): SchedulePreset | undefined {
  return SCHEDULE_PRESETS.find((p) => p.id === id);
}

/**
 * Narrowing guard for the recurring presets. `SchedulePreset` declares `id`
 * and `kind` as independent flat unions (not a discriminated union), so a bare
 * `preset.kind === "recurring"` check does NOT narrow `preset.id` from the full
 * `SchedulePresetId` down to `RecurringSchedulePresetId`. This predicate makes
 * that narrowing explicit so call sites (e.g. `SchedulesTab`) can pass
 * `preset.id` to a `RecurringSchedulePresetId` slot without an `as` cast
 * (WARP-102).
 */
export function isRecurringPreset(
  preset: SchedulePreset,
): preset is SchedulePreset & { id: RecurringSchedulePresetId } {
  return preset.kind === "recurring";
}
