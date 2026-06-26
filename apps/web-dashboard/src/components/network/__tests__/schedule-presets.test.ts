import { describe, it, expect } from "vitest";
import {
  SCHEDULE_PRESETS,
  presetById,
  type SchedulePreset,
  type RecurringSchedulePresetId,
} from "../schedule-presets";

// ---------------------------------------------------------------------------
// Compile-time proof for WARP-102: `RecurringSchedulePresetId` is derived from
// the `SCHEDULE_PRESETS` registry (entries with `kind: "recurring"`), not a
// hand-maintained string union. These assertions are checked by `tsc --noEmit`;
// if the derivation regresses to `never` or drifts from the registry, the
// build fails. They emit no runtime code.

// 1. The derived type equals exactly the two recurring ids today.
const _bedtime: RecurringSchedulePresetId = "bedtime";
const _school: RecurringSchedulePresetId = "school";

// 2. The override preset id is NOT assignable — `homework` (kind: "override")
//    must be excluded by the `Extract<…, { kind: "recurring" }>` filter.
// @ts-expect-error "homework" is an override preset, not recurring.
const _homeworkExcluded: RecurringSchedulePresetId = "homework";

// 3. A bogus id is rejected (guards against the derivation widening to `string`
//    or collapsing to `never`, which would silently accept/reject everything).
// @ts-expect-error "bogus" is not a registry id.
const _bogusRejected: RecurringSchedulePresetId = "bogus";

// 4. AC2 — adding a recurring preset flows through automatically. We model a
//    registry that gains a new recurring entry (`weekend`) at the *type* level,
//    apply the SAME derivation the production code uses, and assert the derived
//    id type picks the new id up — and STILL excludes the override. This is a
//    type-only fixture; it never mutates the runtime `SCHEDULE_PRESETS`.
type RegistryWithNewRecurringPreset = readonly [
  ...typeof SCHEDULE_PRESETS,
  { id: "weekend"; name: "Weekend"; kind: "recurring"; description: ""; icon: "Sun" },
];
type DerivedWithNewPreset = Extract<
  RegistryWithNewRecurringPreset[number],
  { kind: "recurring" }
>["id"];
// The new recurring id is now part of the derived union…
const _newPresetFlowsThrough: DerivedWithNewPreset = "weekend";
const _existingStillThere: DerivedWithNewPreset = "bedtime";
// …and the override id is still excluded after the addition.
// @ts-expect-error "homework" remains an override, even with a new recurring preset.
const _overrideStillExcluded: DerivedWithNewPreset = "homework";

// Reference the bindings so `noUnusedLocals` (if enabled) stays quiet; this is
// a no-op at runtime.
void [
  _bedtime,
  _school,
  _homeworkExcluded,
  _bogusRejected,
  _newPresetFlowsThrough,
  _existingStillThere,
  _overrideStillExcluded,
];

describe("SCHEDULE_PRESETS", () => {
  it("exports three presets with the expected ids", () => {
    expect(SCHEDULE_PRESETS.map((p) => p.id)).toEqual([
      "bedtime",
      "school",
      "homework",
    ]);
  });

  it("Bedtime has two windows with Sun-Thu = 31 and Fri-Sat = 96", () => {
    const bedtime = presetById("bedtime")!;
    expect(bedtime.kind).toBe("recurring");
    expect(bedtime.windows).toBeDefined();
    expect(bedtime.windows).toHaveLength(2);
    expect(bedtime.windows![0].daysOfWeek).toBe(31);
    expect(bedtime.windows![0].startMin).toBe(21 * 60);
    expect(bedtime.windows![0].endMin).toBe(7 * 60);
    expect(bedtime.windows![1].daysOfWeek).toBe(96);
    expect(bedtime.windows![1].startMin).toBe(23 * 60);
    expect(bedtime.windows![1].endMin).toBe(8 * 60);
  });

  it("School has a single Mon-Fri window with daysOfWeek = 62", () => {
    const school = presetById("school")!;
    expect(school.kind).toBe("recurring");
    expect(school.windows).toHaveLength(1);
    expect(school.windows![0].daysOfWeek).toBe(62);
    expect(school.windows![0].startMin).toBe(8 * 60);
    expect(school.windows![0].endMin).toBe(15 * 60);
  });

  it("Homework is an override preset with 90-minute duration", () => {
    const homework = presetById("homework")!;
    expect(homework.kind).toBe("override");
    expect(homework.overrideDurationMin).toBe(90);
    expect(homework.windows).toBeUndefined();
  });

  it("presetById returns undefined for an unknown id", () => {
    // @ts-expect-error exercising the runtime fallback for a bad id
    expect(presetById("bogus")).toBeUndefined();
  });
});
