/**
 * WARP-474 (G2) — scenes CRUD + batch-run.
 *
 * Same supertest harness pattern as the other route tests in this
 * suite. The Matter dispatcher is injected via createScenesRouter so
 * the batch-run path is exercisable without the real Matter
 * controller.
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

import {
  createScenesRouter,
  type MatterDispatcher,
} from "../routes/scenes.js";
import type { AuthUser } from "../middleware/auth.js";

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
}

function createPrismaMock(initial: Array<SceneRow & { actions: SceneActionRow[] }> = []) {
  const scenes = new Map<string, SceneRow & { actions: SceneActionRow[] }>(
    initial.map((s) => [s.id, s]),
  );
  let nextId = 1;
  const mkId = () => `scene-${nextId++}`;

  return {
    scenes,
    scene: {
      findMany: vi.fn(async ({ include }: { orderBy?: unknown; include?: { _count?: unknown } } = {}) => {
        const rows = [...scenes.values()].sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
        );
        if (include?._count) {
          return rows.map((s) => ({ ...s, _count: { actions: s.actions.length } }));
        }
        return rows;
      }),
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { id: string };
          include?: { actions?: unknown };
        }) => scenes.get(where.id) ?? null,
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            name: string;
            icon: string | null;
            createdBy: string | null;
            actions: {
              create: Array<{
                idx: number;
                deviceNodeId: string;
                command: string;
                args: unknown;
              }>;
            };
          };
        }) => {
          const id = mkId();
          const now = new Date();
          const actionRows: SceneActionRow[] = data.actions.create.map((a, i) => ({
            id: `${id}-a${i}`,
            sceneId: id,
            ...a,
          }));
          const row: SceneRow & { actions: SceneActionRow[] } = {
            id,
            name: data.name,
            icon: data.icon,
            createdBy: data.createdBy,
            createdAt: now,
            updatedAt: now,
            actions: actionRows,
          };
          scenes.set(id, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: {
            name?: string;
            icon?: string | null;
            actions?: {
              create: Array<{
                idx: number;
                deviceNodeId: string;
                command: string;
                args: unknown;
              }>;
            };
          };
        }) => {
          const existing = scenes.get(where.id);
          if (!existing) throw new Error("not found");
          if (data.name) existing.name = data.name;
          if (data.icon !== undefined) existing.icon = data.icon;
          if (data.actions) {
            existing.actions = data.actions.create.map((a, i) => ({
              id: `${where.id}-a${i}`,
              sceneId: where.id,
              ...a,
            }));
          }
          existing.updatedAt = new Date();
          return existing;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = scenes.get(where.id);
        scenes.delete(where.id);
        return row;
      }),
    },
    sceneAction: {
      deleteMany: vi.fn(async ({ where }: { where: { sceneId: string } }) => {
        const s = scenes.get(where.sceneId);
        if (s) {
          const count = s.actions.length;
          s.actions = [];
          return { count };
        }
        return { count: 0 };
      }),
    },
  };
}

function mkUser(role: AuthUser["role"], username = "stefan"): AuthUser {
  return { id: `user-${role}`, username, displayName: username, role };
}

function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  matter: MatterDispatcher,
  user: AuthUser,
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createScenesRouter(prismaMock as any, matter));
  return app;
}

const noopMatter: MatterDispatcher = {
  sendCommand: vi.fn().mockResolvedValue({ status: "ok" }),
};

beforeEach(() => {
  recordActivityMock.mockClear();
  vi.clearAllMocks();
});

describe("WARP-474 — Scenes CRUD", () => {
  it("creates a scene with ordered actions; emits ActivityRow", async () => {
    const prisma = createPrismaMock();
    // ADR-005: scene authoring is owner/admin (family reads only), so the
    // create route requires an authorized role — use admin here.
    const app = buildApp(prisma, noopMatter, mkUser("admin"));
    const res = await request(app)
      .post("/api/scenes")
      .send({
        name: "Movie night",
        icon: "film",
        actions: [
          { deviceNodeId: "1", command: "turn_off" },
          { deviceNodeId: "2", command: "set_brightness", args: { level: 20 } },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Movie night");
    expect(res.body.actions).toHaveLength(2);
    expect(res.body.actions[0].idx).toBe(0);
    expect(res.body.actions[1].args).toEqual({ level: 20 });
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0][0].what).toBe("Scene created");
  });

  it("lists scenes with actionCount", async () => {
    const prisma = createPrismaMock([
      {
        id: "scene-existing",
        name: "Goodnight",
        icon: null,
        createdBy: "stefan",
        createdAt: new Date("2026-05-27T08:00:00Z"),
        updatedAt: new Date("2026-05-27T08:00:00Z"),
        actions: [
          { id: "a1", sceneId: "scene-existing", idx: 0, deviceNodeId: "1", command: "turn_off", args: null },
          { id: "a2", sceneId: "scene-existing", idx: 1, deviceNodeId: "2", command: "turn_off", args: null },
        ],
      },
    ]);
    const app = buildApp(prisma, noopMatter, mkUser("family"));
    const res = await request(app).get("/api/scenes");
    expect(res.status).toBe(200);
    expect(res.body.scenes).toHaveLength(1);
    expect(res.body.scenes[0].actionCount).toBe(2);
  });

  it("returns 404 for an unknown scene", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, noopMatter, mkUser("family"));
    const res = await request(app).get("/api/scenes/nope");
    expect(res.status).toBe(404);
  });

  it("PATCH replaces actions wholesale and re-numbers idx", async () => {
    const prisma = createPrismaMock([
      {
        id: "s1",
        name: "Old",
        icon: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        actions: [
          { id: "old", sceneId: "s1", idx: 0, deviceNodeId: "1", command: "turn_on", args: null },
        ],
      },
    ]);
    const app = buildApp(prisma, noopMatter, mkUser("admin"));
    const res = await request(app)
      .patch("/api/scenes/s1")
      .send({
        name: "Renamed",
        actions: [
          { deviceNodeId: "2", command: "turn_off" },
          { deviceNodeId: "3", command: "turn_off" },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Renamed");
    expect(res.body.actions).toHaveLength(2);
    expect(res.body.actions.map((a: { deviceNodeId: string }) => a.deviceNodeId)).toEqual(["2", "3"]);
  });

  it("rejects family-role DELETE with 403 (admin-only)", async () => {
    const prisma = createPrismaMock([
      {
        id: "s1",
        name: "x",
        icon: null,
        createdBy: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        actions: [],
      },
    ]);
    const app = buildApp(prisma, noopMatter, mkUser("family"));
    const res = await request(app).delete("/api/scenes/s1");
    expect(res.status).toBe(403);
  });

  it("rejects scene creation with empty actions[] (zod schema requires min 1)", async () => {
    const prisma = createPrismaMock();
    // Authorized role so the request reaches zod validation (owner/admin author).
    const app = buildApp(prisma, noopMatter, mkUser("admin"));
    const res = await request(app)
      .post("/api/scenes")
      .send({ name: "Empty", actions: [] });
    expect(res.status).toBe(400);
  });
});

describe("WARP-474 — POST /api/scenes/:id/run", () => {
  function sceneWithActions(actions: SceneActionRow[]) {
    return {
      id: "scene-run",
      name: "Test",
      icon: null,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      actions,
    };
  }

  it("dispatches every action through the Matter dispatcher in idx order", async () => {
    const calls: Array<{ nodeId: string; command: string }> = [];
    const matter: MatterDispatcher = {
      sendCommand: vi.fn(async (nodeId, command) => {
        calls.push({ nodeId, command });
        return { status: "ok" };
      }),
    };
    const prisma = createPrismaMock([
      sceneWithActions([
        { id: "a1", sceneId: "scene-run", idx: 0, deviceNodeId: "1", command: "turn_on", args: null },
        { id: "a2", sceneId: "scene-run", idx: 1, deviceNodeId: "2", command: "set_brightness", args: { level: 50 } },
      ]),
    ]);
    const app = buildApp(prisma, matter, mkUser("family"));
    // ?confirm=true is the dashboard scenes-page path (kept working).
    const res = await request(app)
      .post("/api/scenes/scene-run/run?confirm=true")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(2);
    expect(res.body.actionCount).toBe(2);
    expect(calls).toEqual([
      { nodeId: "1", command: "turn_on" },
      { nodeId: "2", command: "set_brightness" },
    ]);
    // WARP-1010: the authed runner threads into the per-command rows.
    expect(matter.sendCommand).toHaveBeenLastCalledWith(
      "2",
      "set_brightness",
      { type: "user", id: "user-family" },
      { level: 50 },
    );
  });

  it("partial-failure tolerant: action 2 fails, action 3 still runs", async () => {
    const matter: MatterDispatcher = {
      sendCommand: vi.fn(async (nodeId) => {
        if (nodeId === "2") throw new Error("Device 2 unreachable");
        return { status: "ok" };
      }),
    };
    const prisma = createPrismaMock([
      sceneWithActions([
        { id: "a1", sceneId: "scene-run", idx: 0, deviceNodeId: "1", command: "turn_on", args: null },
        { id: "a2", sceneId: "scene-run", idx: 1, deviceNodeId: "2", command: "turn_on", args: null },
        { id: "a3", sceneId: "scene-run", idx: 2, deviceNodeId: "3", command: "turn_on", args: null },
      ]),
    ]);
    const app = buildApp(prisma, matter, mkUser("family"));
    const res = await request(app)
      .post("/api/scenes/scene-run/run?confirm=true")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.successCount).toBe(2);
    expect(res.body.actionCount).toBe(3);
    expect(res.body.results[0].ok).toBe(true);
    expect(res.body.results[1].ok).toBe(false);
    expect(res.body.results[1].error).toContain("unreachable");
    expect(res.body.results[2].ok).toBe(true);
    // Activity emitted with severity=warn because successCount < actionCount.
    expect(recordActivityMock.mock.calls[0][0].severity).toBe("warn");
  });

  it("unconfirmed run mints a 202 confirmation_required token and does NOT execute (TOOLS-01/WARP-640)", async () => {
    const matter: MatterDispatcher = {
      sendCommand: vi.fn(async () => ({ status: "ok" })),
    };
    const prisma = createPrismaMock([
      sceneWithActions([
        { id: "a1", sceneId: "scene-run", idx: 0, deviceNodeId: "1", command: "turn_on", args: null },
      ]),
    ]);
    const app = buildApp(prisma, matter, mkUser("family"));
    const res = await request(app).post("/api/scenes/scene-run/run").send({});
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("confirmation_required");
    expect(typeof res.body.confirmationToken).toBe("string");
    expect(res.body.confirmationToken.length).toBeGreaterThan(20);
    expect(res.body.sceneId).toBe("scene-run");
    expect(matter.sendCommand).not.toHaveBeenCalled(); // nothing fired
  });

  it("a valid confirmationToken runs the scene, and is single-use (chat Approve & run)", async () => {
    const matter: MatterDispatcher = {
      sendCommand: vi.fn(async () => ({ status: "ok" })),
    };
    const prisma = createPrismaMock([
      sceneWithActions([
        { id: "a1", sceneId: "scene-run", idx: 0, deviceNodeId: "1", command: "turn_on", args: null },
      ]),
    ]);
    const app = buildApp(prisma, matter, mkUser("family"));
    const minted = await request(app).post("/api/scenes/scene-run/run").send({});
    const token = minted.body.confirmationToken as string;
    const run = await request(app)
      .post("/api/scenes/scene-run/run")
      .send({ confirmationToken: token });
    expect(run.status).toBe(200);
    expect(run.body.successCount).toBe(1);
    expect(matter.sendCommand).toHaveBeenCalledTimes(1);
    // Replaying the same token is rejected (single-use, replay-proof).
    const replay = await request(app)
      .post("/api/scenes/scene-run/run")
      .send({ confirmationToken: token });
    expect(replay.status).toBe(403);
    expect(matter.sendCommand).toHaveBeenCalledTimes(1); // no second run
  });

  it("an invalid confirmationToken is rejected with 403 and does NOT execute", async () => {
    const matter: MatterDispatcher = {
      sendCommand: vi.fn(async () => ({ status: "ok" })),
    };
    const prisma = createPrismaMock([
      sceneWithActions([
        { id: "a1", sceneId: "scene-run", idx: 0, deviceNodeId: "1", command: "turn_on", args: null },
      ]),
    ]);
    const app = buildApp(prisma, matter, mkUser("family"));
    const res = await request(app)
      .post("/api/scenes/scene-run/run")
      .send({ confirmationToken: "not-a-real-token" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("confirmation_invalid");
    expect(matter.sendCommand).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown scene", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, noopMatter, mkUser("family"));
    const res = await request(app).post("/api/scenes/nope/run").send({});
    expect(res.status).toBe(404);
  });

  it("emits ActivityRow with severity=ok when all actions succeed", async () => {
    const prisma = createPrismaMock([
      sceneWithActions([
        { id: "a1", sceneId: "scene-run", idx: 0, deviceNodeId: "1", command: "turn_on", args: null },
      ]),
    ]);
    const app = buildApp(prisma, noopMatter, mkUser("family"));
    const res = await request(app)
      .post("/api/scenes/scene-run/run?confirm=true")
      .send({});
    expect(res.status).toBe(200);
    expect(recordActivityMock.mock.calls[0][0].severity).toBe("ok");
    expect(recordActivityMock.mock.calls[0][0].refs.sceneName).toBe("Test");
  });
});
