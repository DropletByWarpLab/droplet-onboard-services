/**
 * WARP-2665 — schedule CRUD, and the write classification the safety gates
 * actually trust.
 *
 * Two defects, tested together because they ship together: schedule CRUD is
 * what makes the (previously latent) write-classification hole live. Before
 * this, nothing in the repo could create a `ToolSchedule` row, so a spec
 * mis-declared `writes: false` never auto-fired — there was no schedule to
 * fire it from.
 *
 * Same supertest + fake-Prisma shape as tools.routes.test.ts (WARP-462). The
 * mock lives here rather than being shared out of that file so this ticket's
 * surface stays self-contained.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createToolsRouter } from "../routes/tools.js";
import type { StepDispatcher } from "../services/tool-spec-runner.service.js";
import type { AuthUser } from "../middleware/auth.js";

/** A registered tool with `requiresWrite: true` in @droplet/tools-core. */
const WRITE_TOOL = "send_notification";
/** A registered tool with `requiresWrite: false`. */
const READ_TOOL = "list_recent_files";

interface StepRow {
  id: string;
  specId: string;
  idx: number;
  kind: string;
  args: unknown;
}
interface SpecRow {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  version: number;
  status: "live" | "draft" | "suggested";
  ownerId: string | null;
  share: string | null;
  safety: number;
  writes: boolean;
  reversible: boolean;
  createdAt: Date;
  updatedAt: Date;
  steps: StepRow[];
}
interface ScheduleRow {
  id: string;
  specId: string;
  rrule: string;
  timezone: string;
  nextFireAt: Date;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Apply a Prisma-style `data` patch: `undefined` means "leave alone". */
function applyDefined<T extends object>(target: T, data: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(data)) {
    if (v !== undefined) (target as Record<string, unknown>)[k] = v;
  }
  return target;
}

function createPrismaMock(seed: SpecRow[] = []) {
  const specs = new Map<string, SpecRow>(seed.map((s) => [s.slug, s]));
  const schedules = new Map<string, ScheduleRow>();
  let n = 1;
  const mkId = (p: string) => `${p}-${n++}`;

  const tables = {
    specs,
    schedules,
    toolSpec: {
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        if (where.slug) return specs.get(where.slug) ?? null;
        return [...specs.values()].find((s) => s.id === where.id) ?? null;
      }),
      create: vi.fn(
        async ({
          data,
        }: {
          data: Record<string, unknown> & {
            slug: string;
            steps: { create: Array<{ idx: number; kind: string; args: unknown }> };
          };
        }) => {
          const id = mkId("spec");
          const now = new Date();
          const row: SpecRow = {
            id,
            slug: data.slug,
            name: data.name as string,
            category: (data.category as string | null) ?? null,
            description: (data.description as string | null) ?? null,
            version: 1,
            status: "draft",
            ownerId: (data.ownerId as string | null) ?? null,
            share: (data.share as string | null) ?? null,
            safety: (data.safety as number) ?? 1,
            writes: data.writes as boolean,
            reversible: data.reversible as boolean,
            createdAt: now,
            updatedAt: now,
            steps: data.steps.create.map((s, i) => ({
              id: `${id}-s${i}`,
              specId: id,
              ...s,
            })),
          };
          specs.set(row.slug, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { slug: string };
          data: Record<string, unknown> & {
            steps?: { create: Array<{ idx: number; kind: string; args: unknown }> };
            version?: { increment: number };
          };
        }) => {
          const row = specs.get(where.slug)!;
          const { steps, version, ...scalars } = data;
          applyDefined(row, scalars);
          if (version) row.version += version.increment;
          if (steps) {
            row.steps = steps.create.map((s, i) => ({
              id: `${row.id}-s${i}`,
              specId: row.id,
              ...s,
            }));
          }
          return row;
        },
      ),
    },
    toolStep: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    toolSchedule: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        schedules.get(where.id) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { specId: string } }) =>
        [...schedules.values()]
          .filter((s) => s.specId === where.specId)
          .sort((a, b) => a.nextFireAt.getTime() - b.nextFireAt.getTime()),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const now = new Date();
        const row: ScheduleRow = {
          id: mkId("sched"),
          specId: data.specId as string,
          rrule: data.rrule as string,
          timezone: data.timezone as string,
          nextFireAt: data.nextFireAt as Date,
          enabled: data.enabled as boolean,
          createdAt: now,
          updatedAt: now,
        };
        schedules.set(row.id, row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
          applyDefined(schedules.get(where.id)!, data),
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = schedules.get(where.id)!;
        schedules.delete(where.id);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(tables)),
  };
  return tables;
}

function mkSpec(over: Partial<SpecRow> = {}): SpecRow {
  const now = new Date();
  const id = over.id ?? "spec-seed";
  return {
    id,
    slug: "seeded",
    name: "Seeded",
    category: null,
    description: null,
    version: 1,
    status: "live",
    ownerId: "user-owner",
    share: null,
    safety: 1,
    writes: false,
    reversible: true,
    createdAt: now,
    updatedAt: now,
    steps: [
      { id: `${id}-s0`, specId: id, idx: 0, kind: "call", args: { tool: READ_TOOL, args: {} } },
    ],
    ...over,
  };
}

function mkUser(role: AuthUser["role"]): AuthUser {
  return { id: `user-${role}`, username: "stefan", displayName: "stefan", role };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>, user: AuthUser) {
  const dispatcher: StepDispatcher = { call: vi.fn().mockResolvedValue({ ok: true }) };
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createToolsRouter(prisma as any, dispatcher));
  return app;
}

beforeEach(() => {
  recordActivityMock.mockClear();
  vi.clearAllMocks();
});

// ── the write classification ─────────────────────────────────────
describe("WARP-2665 — writes is derived from the steps, not declared", () => {
  it("derives writes:true when a step calls a requiresWrite tool", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mkUser("owner")))
      .post("/api/tools")
      .send({
        slug: "notify-nightly",
        name: "Notify nightly",
        steps: [{ tool: READ_TOOL }, { tool: WRITE_TOOL, args: { title: "hi" } }],
      });
    expect(res.status).toBe(201);
    expect(res.body.writes).toBe(true);
  });

  it("derives writes:false for a read-only spec", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mkUser("owner")))
      .post("/api/tools")
      .send({ slug: "read-only", name: "Read only", steps: [{ tool: READ_TOOL }] });
    expect(res.status).toBe(201);
    expect(res.body.writes).toBe(false);
  });

  it("refuses a declared writes:false that the steps contradict, and names the tools", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mkUser("owner")))
      .post("/api/tools")
      .send({
        slug: "sneaky",
        name: "Sneaky",
        writes: false,
        steps: [{ tool: WRITE_TOOL, args: { title: "hi" } }],
      });
    expect(res.status).toBe(400);
    expect(res.body.writeTools).toEqual([WRITE_TOOL]);
    // Nothing was persisted — the refusal is before the create.
    expect(prisma.specs.size).toBe(0);
  });

  it("accepts a conservative writes:true on a read-only spec", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mkUser("owner")))
      .post("/api/tools")
      .send({
        slug: "cautious",
        name: "Cautious",
        writes: true,
        steps: [{ tool: READ_TOOL }],
      });
    expect(res.status).toBe(201);
    expect(res.body.writes).toBe(true);
  });

  it("a summarize step dispatches no tool and cannot make a spec look like it writes", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mkUser("owner")))
      .post("/api/tools")
      .send({
        slug: "briefing",
        name: "Briefing",
        steps: [{ tool: READ_TOOL }, { kind: "summarize", prompt: "brief me" }],
      });
    expect(res.status).toBe(201);
    expect(res.body.writes).toBe(false);
  });

  it("re-derives on a PATCH that replaces steps without mentioning writes", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "grow", writes: false })]);
    const res = await request(buildApp(prisma, mkUser("owner")))
      .patch("/api/tools/grow")
      .send({ steps: [{ tool: WRITE_TOOL, args: { title: "hi" } }] });
    expect(res.status).toBe(200);
    expect(res.body.writes).toBe(true);
  });

  it("refuses a PATCH lowering writes below what the STORED steps call", async () => {
    const prisma = createPrismaMock([
      mkSpec({
        slug: "already-writes",
        writes: true,
        steps: [
          {
            id: "s0",
            specId: "spec-seed",
            idx: 0,
            kind: "call",
            args: { tool: WRITE_TOOL, args: {} },
          },
        ],
      }),
    ]);
    const res = await request(buildApp(prisma, mkUser("owner")))
      .patch("/api/tools/already-writes")
      .send({ writes: false });
    expect(res.status).toBe(400);
    expect(res.body.writeTools).toEqual([WRITE_TOOL]);
    expect(prisma.specs.get("already-writes")!.writes).toBe(true);
  });

  it("an unrelated PATCH never silently lowers a conservative writes:true", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "cautious", writes: true })]);
    const res = await request(buildApp(prisma, mkUser("owner")))
      .patch("/api/tools/cautious")
      .send({ description: "just a note" });
    expect(res.status).toBe(200);
    expect(res.body.writes).toBe(true);
  });
});

// ── schedules ────────────────────────────────────────────────────
describe("WARP-2665 — ToolSchedule finally has a write path", () => {
  const RRULE = "FREQ=DAILY;BYHOUR=9;BYMINUTE=0";

  it("creates a schedule and computes nextFireAt from the rule", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "daily-report" })]);
    const res = await request(buildApp(prisma, mkUser("owner")))
      .post("/api/tools/daily-report/schedules")
      .send({ rrule: RRULE });
    expect(res.status).toBe(201);
    expect(res.body.timezone).toBe("UTC");
    expect(res.body.enabled).toBe(true);
    expect(new Date(res.body.nextFireAt).getUTCHours()).toBe(9);
  });

  it("honours the IANA timezone rather than reading the rule as UTC", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "daily-report" })]);
    const res = await request(buildApp(prisma, mkUser("owner")))
      .post("/api/tools/daily-report/schedules")
      .send({ rrule: RRULE, timezone: "America/Los_Angeles" });
    expect(res.status).toBe(201);
    expect(res.body.timezone).toBe("America/Los_Angeles");
    // 09:00 Pacific is never 09:00 UTC — this is the KAN-6 drift bug that
    // ToolSchedule would have shipped with had the column not come first.
    expect(new Date(res.body.nextFireAt).getUTCHours()).not.toBe(9);
  });

  it("refuses a rule the ticker could not fire, instead of accepting it and auto-disabling later", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "daily-report" })]);
    const bad = await request(buildApp(prisma, mkUser("owner")))
      .post("/api/tools/daily-report/schedules")
      .send({ rrule: "FREQ=SECONDLY" });
    expect(bad.status).toBe(400);

    const badZone = await request(buildApp(prisma, mkUser("owner")))
      .post("/api/tools/daily-report/schedules")
      .send({ rrule: RRULE, timezone: "Mars/Olympus_Mons" });
    expect(badZone.status).toBe(400);
    expect(prisma.schedules.size).toBe(0);
  });

  it("404s for an unknown spec", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mkUser("owner")))
      .post("/api/tools/nope/schedules")
      .send({ rrule: RRULE });
    expect(res.status).toBe(404);
  });

  it("lists a spec's schedules", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "daily-report" })]);
    const app = buildApp(prisma, mkUser("owner"));
    await request(app).post("/api/tools/daily-report/schedules").send({ rrule: RRULE });
    const res = await request(app).get("/api/tools/daily-report/schedules");
    expect(res.status).toBe(200);
    expect(res.body.schedules).toHaveLength(1);
    expect(res.body.schedules[0].rrule).toBe(RRULE);
  });

  it("toggling enabled does not move nextFireAt", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "daily-report" })]);
    const app = buildApp(prisma, mkUser("owner"));
    const created = await request(app)
      .post("/api/tools/daily-report/schedules")
      .send({ rrule: RRULE });
    const before = created.body.nextFireAt;

    const res = await request(app)
      .patch(`/api/tools/daily-report/schedules/${created.body.id}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    // Re-enabling must resume the rhythm it was paused on, not skip ahead.
    expect(res.body.nextFireAt).toBe(before);
  });

  it("changing the cadence recomputes nextFireAt", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "daily-report" })]);
    const app = buildApp(prisma, mkUser("owner"));
    const created = await request(app)
      .post("/api/tools/daily-report/schedules")
      .send({ rrule: RRULE });

    const res = await request(app)
      .patch(`/api/tools/daily-report/schedules/${created.body.id}`)
      .send({ rrule: "FREQ=DAILY;BYHOUR=17;BYMINUTE=30" });
    expect(res.status).toBe(200);
    expect(new Date(res.body.nextFireAt).getUTCHours()).toBe(17);
  });

  it("rejects a cadence change the ticker could not fire, leaving the row untouched", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "daily-report" })]);
    const app = buildApp(prisma, mkUser("owner"));
    const created = await request(app)
      .post("/api/tools/daily-report/schedules")
      .send({ rrule: RRULE });

    const res = await request(app)
      .patch(`/api/tools/daily-report/schedules/${created.body.id}`)
      .send({ rrule: "FREQ=YEARLY" });
    expect(res.status).toBe(400);
    expect(prisma.schedules.get(created.body.id)!.rrule).toBe(RRULE);
  });

  it("deletes a schedule", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "daily-report" })]);
    const app = buildApp(prisma, mkUser("owner"));
    const created = await request(app)
      .post("/api/tools/daily-report/schedules")
      .send({ rrule: RRULE });

    const res = await request(app).delete(
      `/api/tools/daily-report/schedules/${created.body.id}`,
    );
    expect(res.status).toBe(204);
    expect(prisma.schedules.size).toBe(0);
  });

  it("will not touch a schedule belonging to another spec", async () => {
    const prisma = createPrismaMock([
      mkSpec({ id: "spec-a", slug: "spec-a" }),
      mkSpec({ id: "spec-b", slug: "spec-b" }),
    ]);
    const app = buildApp(prisma, mkUser("owner"));
    const created = await request(app)
      .post("/api/tools/spec-a/schedules")
      .send({ rrule: RRULE });

    // `:slug` must be load-bearing, not advisory.
    const patched = await request(app)
      .patch(`/api/tools/spec-b/schedules/${created.body.id}`)
      .send({ enabled: false });
    expect(patched.status).toBe(404);

    const deleted = await request(app).delete(
      `/api/tools/spec-b/schedules/${created.body.id}`,
    );
    expect(deleted.status).toBe(404);
    expect(prisma.schedules.size).toBe(1);
  });

  it("scheduling is owner/admin only — the same floor as publishing", async () => {
    const prisma = createPrismaMock([mkSpec({ slug: "daily-report" })]);
    const res = await request(buildApp(prisma, mkUser("family")))
      .post("/api/tools/daily-report/schedules")
      .send({ rrule: RRULE });
    expect(res.status).toBe(403);
  });
});
