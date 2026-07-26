/**
 * WARP-463 (C2) — tool-schedule-ticker semantics.
 *
 * Drives `tickToolSchedules` with a fake clock + injected dispatcher
 * and asserts:
 *   - due rows fire, in-future rows do not
 *   - writes && !reversible specs SKIP + advance + emit warn ActivityRow
 *   - draft / deleted specs SKIP without firing
 *   - parse-failure RRULEs disable the schedule + emit system warn row
 *   - the imperative walker is reached with the right StepDispatcher
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { tickToolSchedules } from "../services/tool-schedule-ticker.service.js";
import type { StepDispatcher } from "../services/tool-spec-runner.service.js";

interface SpecRow {
  id: string;
  slug: string;
  name: string;
  status: "live" | "draft" | "suggested";
  /** WARP-1580 — the attributed principal a scheduled fire runs as. */
  ownerId: string | null;
  writes: boolean;
  reversible: boolean;
  steps: Array<{ id: string; idx: number; kind: string; args: unknown }>;
}
interface ScheduleRow {
  id: string;
  specId: string;
  rrule: string;
  nextFireAt: Date;
  enabled: boolean;
}

function createPrismaMock(opts: {
  schedules?: ScheduleRow[];
  specs?: SpecRow[];
} = {}) {
  const schedules = [...(opts.schedules ?? [])];
  const specs = new Map<string, SpecRow>(
    (opts.specs ?? []).map((s) => [s.id, s]),
  );
  const runs: Array<{
    specId: string;
    triggeredBy: string | null;
    status: string;
    error: string | null;
  }> = [];

  return {
    schedules,
    specs,
    runs,
    toolSchedule: {
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
            .filter((s) => s.nextFireAt.getTime() <= where.nextFireAt.lte.getTime())
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
          data: { nextFireAt?: Date; enabled?: boolean };
        }) => {
          const row = schedules.find((s) => s.id === where.id);
          if (!row) throw new Error("not found");
          if (data.nextFireAt) row.nextFireAt = data.nextFireAt;
          if (data.enabled !== undefined) row.enabled = data.enabled;
          return row;
        },
      ),
    },
    toolSpec: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          specs.get(where.id) ?? null,
      ),
    },
    // WARP-1580 — a scheduled fire now runs as the spec's attributed creator
    // (`ToolSpec.ownerId`), resolved fresh on every fire. This suite's specs
    // are owned by an ACTIVE owner-tier row, so the access gate is a no-op
    // and every WARP-463 semantic below is pinned exactly as before. The
    // narrowed / unattributable / deactivated cases live in
    // tool-spec-access.test.ts.
    user: {
      findUnique: vi.fn(async () => ({
        role: "owner",
        directoryStatus: "ACTIVE",
        accessRoleId: null,
        accessRole: null,
      })),
    },
    toolRun: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            specId: string;
            triggeredBy: string | null;
            status: "ok" | "failed" | "cancelled";
            error: string | null;
          };
        }) => {
          const row = {
            id: `run-${runs.length + 1}`,
            ...data,
          };
          runs.push(row);
          return row;
        },
      ),
    },
  };
}

const okDispatcher: StepDispatcher = {
  call: vi.fn().mockResolvedValue({ ok: true }),
};

beforeEach(() => {
  recordActivityMock.mockClear();
  vi.clearAllMocks();
});

describe("WARP-463 — tickToolSchedules", () => {
  it("fires due rows; advances nextFireAt; ignores in-future rows", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const future = new Date("2026-05-27T10:00:00Z");
    const prisma = createPrismaMock({
      schedules: [
        { id: "due-1", specId: "spec-1", rrule: "FREQ=DAILY;BYHOUR=9", nextFireAt: past, enabled: true },
        { id: "fut-1", specId: "spec-1", rrule: "FREQ=DAILY;BYHOUR=10", nextFireAt: future, enabled: true },
      ],
      specs: [
        {
          id: "spec-1",
          slug: "demo",
          ownerId: "user-owner",
          name: "Demo",
          status: "live",
          writes: false,
          reversible: true,
          steps: [{ id: "x", idx: 0, kind: "call", args: { tool: "list_files" } }],
        },
      ],
    });
    const result = await tickToolSchedules(prisma as any, okDispatcher, now);
    expect(result).toEqual({ inspected: 1, fired: 1, skipped: 0, disabled: 0 });
    expect(prisma.runs).toHaveLength(1);
    expect(prisma.runs[0].triggeredBy).toBe("scheduler");
    // Schedule advanced to next 9 AM (tomorrow because today's 9 AM
    // is the `past` value we seeded).
    const dueAfter = prisma.schedules.find((s) => s.id === "due-1");
    expect(dueAfter?.nextFireAt.toISOString()).toBe("2026-05-28T09:00:00.000Z");
  });

  it("safety gate: writes && !reversible SKIPS + advances + emits warn", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const prisma = createPrismaMock({
      schedules: [
        { id: "risky", specId: "spec-r", rrule: "FREQ=DAILY;BYHOUR=9", nextFireAt: past, enabled: true },
      ],
      specs: [
        {
          id: "spec-r",
          slug: "delete-all-logs",
          ownerId: "user-owner",
          name: "Wipe logs",
          status: "live",
          writes: true,
          reversible: false,
          steps: [{ id: "x", idx: 0, kind: "call", args: { tool: "delete_file" } }],
        },
      ],
    });
    const result = await tickToolSchedules(prisma as any, okDispatcher, now);
    expect(result.skipped).toBe(1);
    expect(result.fired).toBe(0);
    expect(prisma.runs).toHaveLength(0); // walker never invoked
    expect(okDispatcher.call).not.toHaveBeenCalled();
    const warn = recordActivityMock.mock.calls.find(
      (c) => c[0].what === "Scheduled run skipped (needs confirmation)",
    );
    expect(warn).toBeDefined();
    expect(warn?.[0].severity).toBe("warn");
    // Schedule advanced to tomorrow.
    expect(prisma.schedules[0].nextFireAt.toISOString()).toBe(
      "2026-05-28T09:00:00.000Z",
    );
  });

  it("skips a draft spec without firing (but advances cadence)", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const prisma = createPrismaMock({
      schedules: [
        { id: "d", specId: "spec-d", rrule: "FREQ=DAILY;BYHOUR=9", nextFireAt: past, enabled: true },
      ],
      specs: [
        {
          id: "spec-d",
          slug: "draft",
          ownerId: "user-owner",
          name: "Draft",
          status: "draft",
          writes: false,
          reversible: true,
          steps: [],
        },
      ],
    });
    const result = await tickToolSchedules(prisma as any, okDispatcher, now);
    expect(result.skipped).toBe(1);
    expect(prisma.runs).toHaveLength(0);
    expect(prisma.schedules[0].enabled).toBe(true); // still enabled (re-publish path)
    expect(prisma.schedules[0].nextFireAt.toISOString()).toBe(
      "2026-05-28T09:00:00.000Z",
    );
  });

  it("disables the schedule when the parent spec is missing", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const prisma = createPrismaMock({
      schedules: [
        { id: "orphan", specId: "spec-gone", rrule: "FREQ=DAILY;BYHOUR=9", nextFireAt: past, enabled: true },
      ],
      specs: [],
    });
    const result = await tickToolSchedules(prisma as any, okDispatcher, now);
    expect(result.disabled).toBe(1);
    expect(prisma.schedules[0].enabled).toBe(false);
  });

  it("disables the schedule on RRULE parse failure", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const prisma = createPrismaMock({
      schedules: [
        { id: "bad", specId: "spec-b", rrule: "FREQ=YEARLY", nextFireAt: past, enabled: true },
      ],
      specs: [
        {
          id: "spec-b",
          slug: "x",
          ownerId: "user-owner",
          name: "x",
          status: "live",
          writes: false,
          reversible: true,
          steps: [{ id: "x", idx: 0, kind: "call", args: { tool: "list_files" } }],
        },
      ],
    });
    const result = await tickToolSchedules(prisma as any, okDispatcher, now);
    expect(result.fired).toBe(1); // it fires once, then disables on advance
    const sched = prisma.schedules[0];
    expect(sched.enabled).toBe(false);
    const warn = recordActivityMock.mock.calls.find(
      (c) => c[0].what === "Tool schedule disabled (RRULE parse failed)",
    );
    expect(warn).toBeDefined();
  });

  it("dispatches through the StepDispatcher with the parsed tool args", async () => {
    const now = new Date("2026-05-27T09:00:00Z");
    const past = new Date("2026-05-27T08:55:00Z");
    const dispatcher: StepDispatcher = {
      call: vi.fn().mockResolvedValue({ rows: 3 }),
    };
    const prisma = createPrismaMock({
      schedules: [
        { id: "s", specId: "spec-d", rrule: "FREQ=DAILY;BYHOUR=9", nextFireAt: past, enabled: true },
      ],
      specs: [
        {
          id: "spec-d",
          slug: "demo",
          ownerId: "user-owner",
          name: "Demo",
          status: "live",
          writes: false,
          reversible: true,
          steps: [
            { id: "x", idx: 0, kind: "call", args: { tool: "list_recent_files", args: { limit: 5 } } },
          ],
        },
      ],
    });
    await tickToolSchedules(prisma as any, dispatcher, now);
    expect(dispatcher.call).toHaveBeenCalledWith("list_recent_files", { limit: 5 });
  });
});
