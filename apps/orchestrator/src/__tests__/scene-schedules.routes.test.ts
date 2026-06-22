/**
 * feat/scene-schedules — schedule CRUD on a Scene.
 *
 * Same supertest harness as scenes.routes.test.ts. Covers:
 *   GET    /api/scenes/:id/schedules   (owner/admin/family read)
 *   POST   /api/scenes/:id/schedules   (owner/admin; bad RRULE → 400; family → 403)
 *   PATCH  /api/scenes/:id/schedules/:sid  (toggle enabled, recompute on enable)
 *   DELETE /api/scenes/:id/schedules/:sid
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  createScenesRouter,
  type MatterDispatcher,
} from "../routes/scenes.js";
import type { AuthUser } from "../middleware/auth.js";

interface ScheduleRow {
  id: string;
  sceneId: string;
  rrule: string;
  nextFireAt: Date;
  enabled: boolean;
  createdBy: string | null;
  lastFiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock(opts: {
  scenes?: Array<{ id: string; name: string }>;
  schedules?: ScheduleRow[];
} = {}) {
  const scenes = new Map(
    (opts.scenes ?? []).map((s) => [s.id, s]),
  );
  const schedules = [...(opts.schedules ?? [])];
  let nextId = 1;

  return {
    scenes,
    schedules,
    scene: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        scenes.get(where.id) ?? null,
      ),
    },
    sceneSchedule: {
      findMany: vi.fn(async ({ where }: { where: { sceneId: string } }) =>
        schedules
          .filter((s) => s.sceneId === where.sceneId)
          .sort((a, b) => a.nextFireAt.getTime() - b.nextFireAt.getTime()),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        schedules.find((s) => s.id === where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Omit<ScheduleRow, "id" | "createdAt" | "updatedAt"> }) => {
        const now = new Date();
        const row: ScheduleRow = {
          id: `sched-${nextId++}`,
          createdAt: now,
          updatedAt: now,
          ...data,
        };
        schedules.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<ScheduleRow> }) => {
        const row = schedules.find((s) => s.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const idx = schedules.findIndex((s) => s.id === where.id);
        const [row] = schedules.splice(idx, 1);
        return row;
      }),
    },
  };
}

function mkUser(role: AuthUser["role"], username = "stefan"): AuthUser {
  return { id: `user-${role}`, username, displayName: username, role };
}

const noopMatter: MatterDispatcher = {
  sendCommand: vi.fn().mockResolvedValue({ status: "ok" }),
};

function buildApp(prismaMock: ReturnType<typeof createPrismaMock>, user: AuthUser) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createScenesRouter(prismaMock as any, noopMatter));
  return app;
}

beforeEach(() => {
  recordActivityMock.mockClear();
  vi.clearAllMocks();
});

describe("feat/scene-schedules — GET /api/scenes/:id/schedules", () => {
  it("lists schedules for a scene (family may read)", async () => {
    const prisma = createPrismaMock({
      scenes: [{ id: "s1", name: "Good night" }],
      schedules: [
        {
          id: "sched-x", sceneId: "s1", rrule: "FREQ=DAILY;BYHOUR=7",
          nextFireAt: new Date("2026-06-20T07:00:00Z"), enabled: true,
          createdBy: "stefan", lastFiredAt: null,
          createdAt: new Date(), updatedAt: new Date(),
        },
      ],
    });
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get("/api/scenes/s1/schedules");
    expect(res.status).toBe(200);
    expect(res.body.schedules).toHaveLength(1);
    expect(res.body.schedules[0].rrule).toBe("FREQ=DAILY;BYHOUR=7");
    expect(res.body.schedules[0].enabled).toBe(true);
  });

  it("404s for an unknown scene", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).get("/api/scenes/nope/schedules");
    expect(res.status).toBe(404);
  });
});

describe("feat/scene-schedules — POST /api/scenes/:id/schedules", () => {
  it("creates a schedule (owner/admin); computes nextFireAt from the RRULE; audits", async () => {
    const prisma = createPrismaMock({ scenes: [{ id: "s1", name: "Good night" }] });
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .post("/api/scenes/s1/schedules")
      .send({ rrule: "FREQ=DAILY;BYHOUR=7" });
    expect(res.status).toBe(201);
    expect(res.body.rrule).toBe("FREQ=DAILY;BYHOUR=7");
    expect(res.body.enabled).toBe(true);
    expect(res.body.createdBy).toBe("stefan");
    // nextFireAt is a real future 07:00 UTC instant.
    const next = new Date(res.body.nextFireAt);
    expect(next.getUTCHours()).toBe(7);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect(prisma.schedules).toHaveLength(1);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed RRULE with 400 before persisting (never a row the ticker would disable)", async () => {
    const prisma = createPrismaMock({ scenes: [{ id: "s1", name: "x" }] });
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .post("/api/scenes/s1/schedules")
      .send({ rrule: "FREQ=YEARLY" });
    expect(res.status).toBe(400);
    expect(prisma.schedules).toHaveLength(0);
  });

  it("rejects a non-string / empty rrule with 400", async () => {
    const prisma = createPrismaMock({ scenes: [{ id: "s1", name: "x" }] });
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app).post("/api/scenes/s1/schedules").send({});
    expect(res.status).toBe(400);
  });

  it("403s for a family-role caller (owner/admin author only)", async () => {
    const prisma = createPrismaMock({ scenes: [{ id: "s1", name: "x" }] });
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app)
      .post("/api/scenes/s1/schedules")
      .send({ rrule: "FREQ=DAILY;BYHOUR=7" });
    expect(res.status).toBe(403);
    expect(prisma.schedules).toHaveLength(0);
  });

  it("404s when scheduling an unknown scene", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .post("/api/scenes/nope/schedules")
      .send({ rrule: "FREQ=DAILY;BYHOUR=7" });
    expect(res.status).toBe(404);
  });
});

describe("feat/scene-schedules — PATCH /api/scenes/:id/schedules/:sid", () => {
  function seedDisabled() {
    return createPrismaMock({
      scenes: [{ id: "s1", name: "x" }],
      schedules: [
        {
          id: "sched-1", sceneId: "s1", rrule: "FREQ=DAILY;BYHOUR=7",
          nextFireAt: new Date("2020-01-01T07:00:00Z"), enabled: false,
          createdBy: "stefan", lastFiredAt: null,
          createdAt: new Date(), updatedAt: new Date(),
        },
      ],
    });
  }

  it("toggles enabled true and recomputes a fresh future nextFireAt", async () => {
    const prisma = seedDisabled();
    const app = buildApp(prisma, mkUser("owner"));
    const res = await request(app)
      .patch("/api/scenes/s1/schedules/sched-1")
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    // Re-enabling a long-stale schedule must move nextFireAt into the
    // future so it fires on cadence rather than instantly on the next tick.
    expect(new Date(res.body.nextFireAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("toggles enabled false", async () => {
    const prisma = createPrismaMock({
      scenes: [{ id: "s1", name: "x" }],
      schedules: [
        {
          id: "sched-1", sceneId: "s1", rrule: "FREQ=DAILY;BYHOUR=7",
          nextFireAt: new Date("2030-01-01T07:00:00Z"), enabled: true,
          createdBy: "stefan", lastFiredAt: null,
          createdAt: new Date(), updatedAt: new Date(),
        },
      ],
    });
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .patch("/api/scenes/s1/schedules/sched-1")
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
  });

  it("403s for family role", async () => {
    const prisma = seedDisabled();
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app)
      .patch("/api/scenes/s1/schedules/sched-1")
      .send({ enabled: true });
    expect(res.status).toBe(403);
  });

  it("404s for an unknown schedule id", async () => {
    const prisma = seedDisabled();
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app)
      .patch("/api/scenes/s1/schedules/nope")
      .send({ enabled: true });
    expect(res.status).toBe(404);
  });
});

describe("feat/scene-schedules — DELETE /api/scenes/:id/schedules/:sid", () => {
  it("deletes a schedule (owner/admin)", async () => {
    const prisma = createPrismaMock({
      scenes: [{ id: "s1", name: "x" }],
      schedules: [
        {
          id: "sched-1", sceneId: "s1", rrule: "FREQ=DAILY;BYHOUR=7",
          nextFireAt: new Date("2030-01-01T07:00:00Z"), enabled: true,
          createdBy: "stefan", lastFiredAt: null,
          createdAt: new Date(), updatedAt: new Date(),
        },
      ],
    });
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app).delete("/api/scenes/s1/schedules/sched-1");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(prisma.schedules).toHaveLength(0);
  });

  it("403s for family role", async () => {
    const prisma = createPrismaMock({
      scenes: [{ id: "s1", name: "x" }],
      schedules: [
        {
          id: "sched-1", sceneId: "s1", rrule: "FREQ=DAILY;BYHOUR=7",
          nextFireAt: new Date("2030-01-01T07:00:00Z"), enabled: true,
          createdBy: "stefan", lastFiredAt: null,
          createdAt: new Date(), updatedAt: new Date(),
        },
      ],
    });
    const app = buildApp(prisma, mkUser("family"));
    const res = await request(app).delete("/api/scenes/s1/schedules/sched-1");
    expect(res.status).toBe(403);
    expect(prisma.schedules).toHaveLength(1);
  });

  it("404s for an unknown schedule id", async () => {
    const prisma = createPrismaMock({ scenes: [{ id: "s1", name: "x" }] });
    const app = buildApp(prisma, mkUser("admin"));
    const res = await request(app).delete("/api/scenes/s1/schedules/nope");
    expect(res.status).toBe(404);
  });
});
