/**
 * WARP-2671 — the derived readback.
 *
 * The property that matters: the sentence a person reads before turning a
 * routine on is built from its STEPS and the live registry, never from the
 * spec's own `description`. A routine that misdescribes itself — a miner
 * suggestion, or later a model-authored draft — must not be able to talk its
 * way past the confirmation.
 */
import { describe, it, expect } from "vitest";
import {
  describeRoutine,
  describeSchedule,
  readbackSentence,
} from "./routine-readback";
import type { RoutineSchedule, RoutineStep, ToolCatalogEntry } from "./types";

function tool(
  name: string,
  homeDescription: string,
  requiresWrite = false,
): ToolCatalogEntry {
  return {
    name,
    domain: "files",
    description: `[agent] ${name}`,
    homeDescription,
    requiresWrite,
    requiresConfirmation: false,
  };
}

const CATALOG = new Map<string, ToolCatalogEntry>([
  ["list_recent_files", tool("list_recent_files", "Read your recent files")],
  ["get_system_health", tool("get_system_health", "Check how the box is doing")],
  [
    "send_notification",
    tool("send_notification", "Send you a notification", true),
  ],
]);

const callStep = (idx: number, toolName: string, as?: string): RoutineStep => ({
  id: `s${idx}`,
  idx,
  kind: "call",
  args: { tool: toolName, args: {}, ...(as ? { as } : {}) },
});

const schedule = (over: Partial<RoutineSchedule> = {}): RoutineSchedule => ({
  id: "sch-1",
  specId: "spec-1",
  rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=8;BYMINUTE=0",
  timezone: "UTC",
  nextFireAt: new Date().toISOString(),
  enabled: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  ...over,
});

describe("describeSchedule", () => {
  it("names the weekday pattern rather than listing five days", () => {
    expect(describeSchedule(schedule())).toBe("Every weekday at 8:00 UTC");
  });

  it("renders a daily rule", () => {
    expect(
      describeSchedule(schedule({ rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=30" })),
    ).toBe("Every day at 9:30 UTC");
  });

  it("shows the operator's own zone when it is not UTC", () => {
    expect(
      describeSchedule(
        schedule({
          rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0",
          timezone: "America/Los_Angeles",
        }),
      ),
    ).toBe("Every day at 7:00 America/Los_Angeles");
  });

  it("lists specific days in full", () => {
    expect(
      describeSchedule(
        schedule({ rrule: "FREQ=WEEKLY;BYDAY=MO,TH;BYHOUR=6;BYMINUTE=5" }),
      ),
    ).toBe("Every Monday and Thursday at 6:05 UTC");
  });

  it("says plainly when it cannot read the rule instead of inventing a cadence", () => {
    const out = describeSchedule(schedule({ rrule: "FREQ=SECONDLY" }));
    expect(out).toContain("cannot read");
  });
});

describe("describeRoutine", () => {
  const steps: RoutineStep[] = [
    callStep(0, "get_system_health", "health"),
    callStep(1, "list_recent_files"),
    { id: "s2", idx: 2, kind: "summarize", args: {} },
  ];

  it("builds one clause per step from the registry's home copy", () => {
    const r = describeRoutine({
      steps,
      catalog: CATALOG,
      schedules: [schedule()],
      writes: false,
      reversible: true,
    });
    expect(r.actions).toEqual([
      "check how the box is doing",
      "read your recent files",
      "write you a summary of what it found",
    ]);
    expect(r.cadence).toBe("Every weekday at 8:00 UTC");
  });

  it("reads as one sentence", () => {
    const r = describeRoutine({
      steps,
      catalog: CATALOG,
      schedules: [schedule()],
      writes: false,
      reversible: true,
    });
    expect(readbackSentence(r)).toBe(
      "Every weekday at 8:00 UTC — check how the box is doing, read your recent files, then write you a summary of what it found.",
    );
  });

  it("says a routine with no schedule runs only on demand", () => {
    const r = describeRoutine({
      steps,
      catalog: CATALOG,
      schedules: [],
      writes: false,
      reversible: true,
    });
    expect(r.cadence).toBeNull();
    expect(readbackSentence(r)).toMatch(/^When you run it —/);
  });

  it("ignores a PAUSED schedule when stating the cadence", () => {
    const r = describeRoutine({
      steps,
      catalog: CATALOG,
      schedules: [schedule({ enabled: false })],
      writes: false,
      reversible: true,
    });
    expect(r.cadence).toBeNull();
  });

  it("names the write tools it found in the steps", () => {
    const r = describeRoutine({
      steps: [callStep(0, "list_recent_files"), callStep(1, "send_notification")],
      catalog: CATALOG,
      writes: true,
      reversible: true,
    });
    expect(r.writeTools).toEqual(["send_notification"]);
  });

  it("takes its impact from the SERVER's flags, not its own recount", () => {
    // The orchestrator derives `writes` from the same registry (WARP-2665) and
    // is what actually gates run-now and the scheduler. A readback that
    // disagreed with the gate would be worse than no readback.
    const readOnlySteps = [callStep(0, "list_recent_files")];

    expect(
      describeRoutine({
        steps: readOnlySteps,
        catalog: CATALOG,
        writes: false,
        reversible: true,
      }).impactLine,
    ).toBe("Reads only. Changes nothing.");

    expect(
      describeRoutine({
        steps: readOnlySteps,
        catalog: CATALOG,
        writes: true,
        reversible: true,
      }).impact,
    ).toBe("writes");

    const destructive = describeRoutine({
      steps: readOnlySteps,
      catalog: CATALOG,
      writes: true,
      reversible: false,
    });
    expect(destructive.impact).toBe("destructive");
    expect(destructive.impactLine).toContain("never run unattended");
  });

  it("falls back to the tool's name when the registry has no entry", () => {
    const r = describeRoutine({
      steps: [callStep(0, "some_unregistered_tool")],
      catalog: CATALOG,
      writes: false,
      reversible: true,
    });
    expect(r.actions).toEqual(["some unregistered tool"]);
    // Not counted as a write: the server owns that decision, and guessing
    // "writes" on every catalog gap would cry wolf.
    expect(r.writeTools).toEqual([]);
  });

  it("says so rather than staying silent about a step it cannot read", () => {
    const r = describeRoutine({
      steps: [{ id: "x", idx: 0, kind: "call", args: {} }],
      catalog: CATALOG,
      writes: false,
      reversible: true,
    });
    expect(r.actions).toEqual(["run a step this box cannot read"]);
  });
});
