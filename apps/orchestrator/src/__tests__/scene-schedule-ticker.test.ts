/**
 * feat/scene-schedules — scene-schedule-ticker semantics.
 *
 * Drives `tickSceneSchedules` with a fake clock + injected Matter
 * dispatcher and asserts (cloned from the WARP-463 tool-schedule-ticker
 * test):
 *   - due rows fire via executeScene(triggeredBy="scheduler"); in-future
 *     rows do not
 *   - a missing parent Scene disables the schedule (+ audit)
 *   - a parse-failure RRULE disables the schedule (+ system warn row)
 *   - nextFireAt advance math matches nextFireFromRrule
 *   - a successful fire sets lastFiredAt
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { tickSceneSchedules } from "../services/scene-schedule-ticker.service.js";
import type { MatterDispatcher } from "../routes/scenes.js";

interface ScheduleRow {
  id: string;
  sceneId: string;
  rrule: string;
  nextFireAt: Date;
  enabled: boolean;
  lastFiredAt: Date | null;
  timezone: string;
}
interface SceneActionRow {
  id: string;
  sceneId: string;
  idx: number;
  deviceNodeId: string;
  command: string;
  args: unknown;
}
interface SceneRow {
  id: string;
  name: string;
  icon: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  actions: SceneActionRow[];
}

function createPrismaMock(opts: {
  schedules?: ScheduleRow[];
  scenes?: SceneRow[];
} = {}) {
  const schedules = [...(opts.schedules ?? [])];
  const scenes = new Map<string, SceneRow>(
    (opts.scenes ?? []).map((s) => [s.id, s]),
  );
  const activityRows: Array<{ kind: string; what: string }> = [];

  return {
    schedules,
    scenes,
    activityRows,
    sceneSchedule: {
      findMany: vi.fn(
        async ({
          where,
          take,
        }: {
          where: { enabled: boolean; nextFireAt: { lte: Date } };
          orderBy?: unknown;
          take?: number;
        }) => {
          const due = schedules
            .filter((s) => s.enabled === where.enabled)
            .filter(
              (s) =>
                s.nextFireAt.getTime() <= where.nextFireAt.lte.getTime(),
            )
            .sort((a, b) => a.nextFireAt.getTime() - b.nextFireAt.getTime());
          return take ? due.slice(0, take) : due;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { nextFireAt?: Date; enabled?: boolean; lastFiredAt?: Date };
        }) => {
          const row = schedules.find((s) => s.id === where.id);
          if (!row) throw new Error("not found");
          if (data.nextFireAt) row.nextFireAt = data.nextFireAt;
          if (data.enabled !== undefined) row.enabled = data.enabled;
          if (data.lastFiredAt) row.lastFiredAt = data.lastFiredAt;
          return row;
        },
      ),
    },
    scene: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          scenes.get(where.id) ?? null,
      ),
    },
  };
}

function okMatter(): MatterDispatcher {
  return { sendCommand: vi.fn().mockResolvedValue({ status: "ok" }) };
}

function sceneWith(id: string, actions: SceneActionRow[]): SceneRow {
  return {
    id,
    name: `Scene ${id}`,
    icon: null,
    createdBy: null,
    createdAt: new Date("2026-05-01T00:00:00Z"),
    updatedAt: new Date("2026-05-01T00:00:00Z"),
    actions,
  };
}

beforeEach(() => {
  recordActivityMock.mockClear();
  vi.clearAllMocks();
});

describe("feat/scene-schedules — tickSceneSchedules", () => {
  it("fires due rows via the Matter dispatcher; advances nextFireAt + sets lastFiredAt; ignores in-future rows", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const future = new Date("2026-05-27T10:00:00Z");
    const matter = okMatter();
    const prisma = createPrismaMock({
      schedules: [
        { id: "due-1", sceneId: "scene-1", rrule: "FREQ=DAILY;BYHOUR=9", nextFireAt: past, enabled: true, lastFiredAt: null, timezone: "UTC" },
        { id: "fut-1", sceneId: "scene-1", rrule: "FREQ=DAILY;BYHOUR=10", nextFireAt: future, enabled: true, lastFiredAt: null, timezone: "UTC" },
      ],
      scenes: [
        sceneWith("scene-1", [
          { id: "a1", sceneId: "scene-1", idx: 0, deviceNodeId: "n1", command: "toggle", args: null },
        ]),
      ],
    });

    const result = await tickSceneSchedules(prisma as any, matter, now);

    expect(result).toEqual({ inspected: 1, fired: 1, skipped: 0, disabled: 0 });
    // The due scene fired exactly its actions; the in-future one did not.
    expect(matter.sendCommand).toHaveBeenCalledTimes(1);
    expect(matter.sendCommand).toHaveBeenCalledWith("n1", "toggle", { type: "ai", id: null }, undefined);
    const due = prisma.schedules.find((s) => s.id === "due-1");
    // Advanced to next 9 AM UTC (tomorrow, today's 9 AM is the past seed).
    expect(due?.nextFireAt.toISOString()).toBe("2026-05-28T09:00:00.000Z");
    expect(due?.lastFiredAt?.toISOString()).toBe(now.toISOString());
  });

  it("dispatches scene actions in idx order with args forwarded", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const matter = okMatter();
    const prisma = createPrismaMock({
      schedules: [
        { id: "s", sceneId: "scene-2", rrule: "FREQ=DAILY;BYHOUR=9", nextFireAt: past, enabled: true, lastFiredAt: null, timezone: "UTC" },
      ],
      scenes: [
        sceneWith("scene-2", [
          { id: "a1", sceneId: "scene-2", idx: 0, deviceNodeId: "n1", command: "toggle", args: null },
          { id: "a2", sceneId: "scene-2", idx: 1, deviceNodeId: "n2", command: "set_brightness", args: { brightness: 40 } },
        ]),
      ],
    });

    await tickSceneSchedules(prisma as any, matter, now);

    const calls = (matter.sendCommand as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(["n1", "toggle", { type: "ai", id: null }, undefined]);
    expect(calls[1]).toEqual(["n2", "set_brightness", { type: "ai", id: null }, { brightness: 40 }]);
  });

  it("disables the schedule when the parent Scene is missing (+ audit)", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const matter = okMatter();
    const prisma = createPrismaMock({
      schedules: [
        { id: "orphan", sceneId: "gone", rrule: "FREQ=DAILY;BYHOUR=9", nextFireAt: past, enabled: true, lastFiredAt: null, timezone: "UTC" },
      ],
      scenes: [],
    });

    const result = await tickSceneSchedules(prisma as any, matter, now);

    expect(result.disabled).toBe(1);
    expect(result.fired).toBe(0);
    expect(prisma.schedules[0].enabled).toBe(false);
    expect(matter.sendCommand).not.toHaveBeenCalled();
    const audit = recordActivityMock.mock.calls.find(
      (c) => c[0].what === "Scene schedule disabled (routine deleted)",
    );
    expect(audit).toBeDefined();
    expect(audit?.[0].severity).toBe("warn");
  });

  it("disables the schedule on RRULE parse failure (+ system warn row); never pins the ticker", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const matter = okMatter();
    const prisma = createPrismaMock({
      schedules: [
        { id: "bad", sceneId: "scene-3", rrule: "FREQ=YEARLY", nextFireAt: past, enabled: true, lastFiredAt: null, timezone: "UTC" },
      ],
      scenes: [
        sceneWith("scene-3", [
          { id: "a1", sceneId: "scene-3", idx: 0, deviceNodeId: "n1", command: "toggle", args: null },
        ]),
      ],
    });

    const result = await tickSceneSchedules(prisma as any, matter, now);

    // It fires once (rule is "due now"), then the advance can't compute a
    // next time → disables so it can't loop on nextFireAt <= now forever.
    expect(result.fired).toBe(1);
    const sched = prisma.schedules[0];
    expect(sched.enabled).toBe(false);
    const warn = recordActivityMock.mock.calls.find(
      (c) => c[0].what === "Scene schedule disabled (RRULE parse failed)",
    );
    expect(warn).toBeDefined();
    expect(warn?.[0].severity).toBe("warn");
  });

  it("advances a weekly schedule to the next matching weekday", async () => {
    // 2026-05-27 is a Wednesday. A MO/FR weekly rule at 06:00 fires next
    // on Friday 2026-05-29.
    const now = new Date("2026-05-27T06:00:01Z");
    const past = new Date("2026-05-27T05:59:00Z");
    const matter = okMatter();
    const prisma = createPrismaMock({
      schedules: [
        { id: "wk", sceneId: "scene-4", rrule: "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=6", nextFireAt: past, enabled: true, lastFiredAt: null, timezone: "UTC" },
      ],
      scenes: [sceneWith("scene-4", [
        { id: "a1", sceneId: "scene-4", idx: 0, deviceNodeId: "n1", command: "toggle", args: null },
      ])],
    });

    await tickSceneSchedules(prisma as any, matter, now);

    expect(prisma.schedules[0].nextFireAt.toISOString()).toBe(
      "2026-05-29T06:00:00.000Z",
    );
  });

  it("is partial-failure tolerant: a dead device does not abort the rest, and still advances", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const matter: MatterDispatcher = {
      sendCommand: vi.fn(async (nodeId: string) => {
        if (nodeId === "n2") throw new Error("Device n2 unreachable");
        return { status: "ok" };
      }),
    };
    const prisma = createPrismaMock({
      schedules: [
        { id: "s", sceneId: "scene-5", rrule: "FREQ=DAILY;BYHOUR=9", nextFireAt: past, enabled: true, lastFiredAt: null, timezone: "UTC" },
      ],
      scenes: [sceneWith("scene-5", [
        { id: "a1", sceneId: "scene-5", idx: 0, deviceNodeId: "n1", command: "toggle", args: null },
        { id: "a2", sceneId: "scene-5", idx: 1, deviceNodeId: "n2", command: "toggle", args: null },
        { id: "a3", sceneId: "scene-5", idx: 2, deviceNodeId: "n3", command: "toggle", args: null },
      ])],
    });

    const result = await tickSceneSchedules(prisma as any, matter, now);

    expect(result.fired).toBe(1);
    expect((matter.sendCommand as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(3);
    // Still advanced + recorded the fire despite the partial failure.
    expect(prisma.schedules[0].nextFireAt.toISOString()).toBe(
      "2026-05-28T09:00:00.000Z",
    );
    expect(prisma.schedules[0].lastFiredAt).not.toBeNull();
  });
});

describe("KAN-6 — tickSceneSchedules recomputes nextFireAt against the stored timezone (DST-correct)", () => {
  it("advances a 07:00 America/Los_Angeles daily schedule to the DST-correct UTC instant across the fall-back boundary", async () => {
    // DST ends 2026-11-01 02:00 local, so by `now` we are already in PST.
    // The schedule's prior fire was the day before (07:00 PDT on Oct 31 =
    // 14:00 UTC). The NEXT fire must be 07:00 PST = 15:00 UTC, NOT 14:00 UTC
    // (which is now 06:00 PST — the drift bug). The ticker reads the row's
    // timezone and recomputes the wall-clock against it.
    const now = new Date("2026-11-01T06:00:00Z"); // 2026-10-31 23:00 PDT
    const past = new Date("2026-10-31T14:00:00Z"); // last fire: 07:00 PDT Oct 31
    const matter = okMatter();
    const prisma = createPrismaMock({
      schedules: [
        {
          id: "la",
          sceneId: "scene-tz",
          rrule: "FREQ=DAILY;BYHOUR=7;BYMINUTE=0",
          nextFireAt: past,
          enabled: true,
          lastFiredAt: null,
          timezone: "America/Los_Angeles",
        },
      ],
      scenes: [
        sceneWith("scene-tz", [
          { id: "a1", sceneId: "scene-tz", idx: 0, deviceNodeId: "n1", command: "toggle", args: null },
        ]),
      ],
    });

    const result = await tickSceneSchedules(prisma as any, matter, now);

    expect(result.fired).toBe(1);
    // 2026-11-01 07:00 PST = 15:00 UTC — the wall-clock stayed at 07:00 local
    // and the UTC instant shifted forward an hour because PST is UTC-8. The
    // pre-KAN-6 frozen-UTC behaviour would have advanced to 14:00 UTC here.
    expect(prisma.schedules[0].nextFireAt.toISOString()).toBe(
      "2026-11-01T15:00:00.000Z",
    );
  });

  it("a row with the legacy 'UTC' timezone advances exactly as before (no behaviour change)", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const matter = okMatter();
    const prisma = createPrismaMock({
      schedules: [
        {
          id: "legacy",
          sceneId: "scene-utc",
          rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
          nextFireAt: past,
          enabled: true,
          lastFiredAt: null,
          timezone: "UTC",
        },
      ],
      scenes: [
        sceneWith("scene-utc", [
          { id: "a1", sceneId: "scene-utc", idx: 0, deviceNodeId: "n1", command: "toggle", args: null },
        ]),
      ],
    });

    await tickSceneSchedules(prisma as any, matter, now);

    expect(prisma.schedules[0].nextFireAt.toISOString()).toBe(
      "2026-05-28T09:00:00.000Z",
    );
  });
});
