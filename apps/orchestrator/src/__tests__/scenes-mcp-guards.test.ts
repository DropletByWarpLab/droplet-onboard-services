/**
 * WARP-1447 — MCP-principal admission on the scene routes the run_scene /
 * create_scene LLM tools dispatch through.
 *
 * The tools present the `_service:mcp` principal (role "service"), which
 * plain requireRole 403s — the exact dead-tool class WARP-1439/WARP-1440
 * fixed for the camera tools. Before this fix, run_scene's name resolution
 * (GET /api/scenes) and its run dispatch (POST /api/scenes/:id/run, both
 * hops of the WARP-640 confirm handshake) silently 403ed on the MCP path.
 * These tests pin the three guards as requireRoleOrMcpService with human
 * roles unchanged. Scaffolding per cameras-mcp-guards.test.ts: real auth
 * guards, prisma + Matter dispatcher mocked.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true, agentMaxIter: { defaultIter: 5, capIter: 10 } },
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

const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
};
const owner: AuthUser = {
  id: "u-owner", username: "romain", displayName: "romain", role: "owner",
};
const family: AuthUser = {
  id: "u-family", username: "fam", displayName: "fam", role: "family",
};

const EXISTING_SCENE = {
  id: "scene-1",
  name: "Movie night",
  icon: null,
  createdBy: "romain",
  createdAt: new Date("2026-07-01T08:00:00Z"),
  updatedAt: new Date("2026-07-01T08:00:00Z"),
  actions: [
    { id: "a1", sceneId: "scene-1", idx: 0, deviceNodeId: "101", command: "turn_off", args: null },
  ],
};

function createPrismaMock() {
  return {
    scene: {
      findMany: vi.fn(async ({ include }: { include?: { _count?: unknown } } = {}) =>
        include?._count
          ? [{ ...EXISTING_SCENE, _count: { actions: EXISTING_SCENE.actions.length } }]
          : [EXISTING_SCENE],
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === EXISTING_SCENE.id ? EXISTING_SCENE : null,
      ),
      create: vi.fn(async ({ data }: { data: { name: string; icon: string | null; createdBy: string | null; actions: { create: Array<{ idx: number; deviceNodeId: string; command: string; args: unknown }> } } }) => {
        const now = new Date();
        return {
          id: "scene-new",
          name: data.name,
          icon: data.icon,
          createdBy: data.createdBy,
          createdAt: now,
          updatedAt: now,
          actions: data.actions.create.map((a, i) => ({
            id: `scene-new-a${i}`,
            sceneId: "scene-new",
            ...a,
          })),
        };
      }),
    },
  };
}

function buildApp(user: AuthUser, matter: MatterDispatcher, prisma = createPrismaMock()) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  app.use("/api", createScenesRouter(prisma as any, matter));
  return { app, prisma };
}

function mkMatter(): MatterDispatcher {
  return { sendCommand: vi.fn().mockResolvedValue({ status: "ok" }) };
}

const CREATE_BODY = {
  name: "Goodnight",
  actions: [{ deviceNodeId: "101", command: "turn_off" }],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scene route guards admit the MCP service principal (WARP-1447)", () => {
  it("GET /scenes — MCP principal lists scenes (run_scene name resolution)", async () => {
    const { app } = buildApp(mcpPrincipal, mkMatter());
    const res = await request(app).get("/api/scenes");

    expect(res.status).toBe(200);
    expect(res.body.scenes).toHaveLength(1);
    expect(res.body.scenes[0]).toMatchObject({ id: "scene-1", name: "Movie night", actionCount: 1 });
  });

  it("POST /scenes — MCP principal creates a scene (create_scene tool)", async () => {
    const { app, prisma } = buildApp(mcpPrincipal, mkMatter());
    const res = await request(app).post("/api/scenes").send(CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.name).toBe("Goodnight");
    expect(prisma.scene.create).toHaveBeenCalledTimes(1);
    expect(recordActivityMock.mock.calls[0][0].what).toBe("Scene created");
  });

  it("POST /scenes/:id/run — MCP principal gets the WARP-640 202 mint, nothing executes", async () => {
    const matter = mkMatter();
    const { app } = buildApp(mcpPrincipal, matter);
    const res = await request(app).post("/api/scenes/scene-1/run").send({});

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("confirmation_required");
    expect(typeof res.body.confirmationToken).toBe("string");
    expect(matter.sendCommand).not.toHaveBeenCalled();
  });

  it("POST /scenes/:id/run — MCP principal completes the confirm hop with the minted token", async () => {
    const matter = mkMatter();
    const { app } = buildApp(mcpPrincipal, matter);
    const minted = await request(app).post("/api/scenes/scene-1/run").send({});
    const run = await request(app)
      .post("/api/scenes/scene-1/run")
      .send({ confirmationToken: minted.body.confirmationToken });

    expect(run.status).toBe(200);
    expect(run.body.successCount).toBe(1);
    expect(matter.sendCommand).toHaveBeenCalledTimes(1);
  });

  it("human roles unchanged: owner creates 201, family create 403, family still lists 200", async () => {
    const ok = await request(buildApp(owner, mkMatter()).app)
      .post("/api/scenes")
      .send(CREATE_BODY);
    expect(ok.status).toBe(201);

    const { app: familyApp, prisma } = buildApp(family, mkMatter());
    const denied = await request(familyApp).post("/api/scenes").send(CREATE_BODY);
    expect(denied.status).toBe(403);
    expect(prisma.scene.create).not.toHaveBeenCalled();

    const list = await request(familyApp).get("/api/scenes");
    expect(list.status).toBe(200);
  });
});
