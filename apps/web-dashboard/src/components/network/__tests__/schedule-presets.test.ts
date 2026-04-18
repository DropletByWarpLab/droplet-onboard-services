import { describe, it, expect } from "vitest";
import { SCHEDULE_PRESETS, presetById } from "../schedule-presets";

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
