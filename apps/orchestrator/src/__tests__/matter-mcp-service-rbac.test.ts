/**
 * MCP service principal ↔ Matter write routes (requireRoleOrMcpService).
 *
 * Matter write tools (control_device, commission_device) dispatch through
 * the mcp-server, which calls back into the orchestrator's /api/matter/*
 * write routes presenting the `_service:mcp` bearer (role "service").
 * `requireRoleOrMcpService` admits exactly that principal — not the coarse
 * "service" role — so tool calls reach the safety-tier evaluator instead
 * of 403ing in front of it (the WARP-339 gap).
 *
 * Uses the REAL safety-tier service so the assertions pin end-to-end
 * behavior: Tier-1 commands execute (200, tier echo), Tier-2 (lock-like)
 * commands mint a 202 and never execute. The confirm route keeps plain
 * requireRole — human-only, like /network/command/confirm — and other
 * service principals (voice) stay excluded.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
  },
}));

vi.mock("../services/matter.service.js", () => ({
  isMatterInitialized: vi.fn().mockReturnValue(true),
  getCommissionedDevices: vi.fn().mockResolvedValue({}),
  getDevice: vi.fn(),
  sendMatterCommand: vi.fn().mockResolvedValue({ status: "success" }),
  discoverDevices: vi.fn().mockResolvedValue([]),
  commissionDevice: vi.fn().mockResolvedValue({ nodeId: "42" }),
  // Current main's DELETE route maps a falsy return to 404 (the function
  // returns boolean since WARP-850); resolve `true` so the success path is
  // exercised.
  decommissionDevice: vi.fn().mockResolvedValue(true),
  // WARP-1469: same boolean contract as decommissionDevice (false → 404).
  reconnectDevice: vi.fn().mockResolvedValue(true),
  subscribeStateChanges: vi.fn().mockReturnValue(() => {}),
  subscribeConnectionChanges: vi.fn().mockReturnValue(() => {}),
}));

import { createMatterRouter } from "../routes/matter.js";
import * as matterService from "../services/matter.service.js";
import type { AuthUser } from "../middleware/auth.js";

function createPrismaMock() {
  return {
    commandAuditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    // WARP-1447: rooms + aliases, for the assign_device_room guard coverage
    // below. Real rooms.service functions run against these mocks.
    room: {
      aggregate: vi.fn().mockResolvedValue({ _max: { sortOrder: null } }),
      create: vi
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: "room-1", ...data }),
        ),
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: "room-1", name: "Den", icon: "home", sortOrder: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    deviceAlias: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ nodeId: "77", name: "Kitchen strip", roomId: null }),
      upsert: vi
        .fn()
        .mockImplementation(
          ({
            where,
            update,
          }: {
            where: { nodeId: string };
            update: { name: string | null; roomId: string | null };
          }) =>
            Promise.resolve({ nodeId: where.nodeId, name: update.name, roomId: update.roomId }),
        ),
      delete: vi.fn(),
    },
  };
}
type PrismaMock = ReturnType<typeof createPrismaMock>;

const mcpPrincipal: AuthUser = {
  id: "_service:mcp",
  username: "_service:mcp",
  displayName: "MCP Server",
  role: "service",
};

const voicePrincipal: AuthUser = {
  id: "_service:voice",
  username: "_service:voice",
  displayName: "Voice Assistant",
  role: "service",
};

const guest: AuthUser = {
  id: "u-guest",
  username: "guest",
  displayName: "guest",
  role: "guest",
};

const owner: AuthUser = {
  id: "u-owner",
  username: "stefan",
  displayName: "stefan",
  role: "owner",
};

function buildApp(user: AuthUser, prisma: PrismaMock = createPrismaMock()): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createMatterRouter(prisma as unknown as PrismaClient));
  return app;
}

function mockDevice(nodeId: string, category: string): void {
  vi.mocked(matterService.getDevice).mockResolvedValue({
    nodeId,
    category,
  } as unknown as Awaited<ReturnType<typeof matterService.getDevice>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(matterService.isMatterInitialized).mockReturnValue(true);
  vi.mocked(matterService.sendMatterCommand).mockResolvedValue({ status: "success" });
  vi.mocked(matterService.commissionDevice).mockResolvedValue({ nodeId: "42" });
  // Current main's DELETE route 404s on a falsy return (decommissionDevice
  // returns boolean since WARP-850), so resolve `true` for the happy path.
  vi.mocked(matterService.decommissionDevice).mockResolvedValue(true);
});

// Distinct nodeIds per test — the safety-tier rate limiter is in-memory
// module state keyed by entityId, so reusing one would cross-pollute.

describe("MCP principal on Tier-1 Matter commands", () => {
  it("POST /api/matter/devices/:nodeId/command (light.turn_on) as _service:mcp executes: 200, tier 1", async () => {
    mockDevice("101", "light");
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/matter/devices/101/command")
      .send({ command: "turn_on" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "success", nodeId: "101", command: "turn_on", tier: 1 });
    expect(matterService.sendMatterCommand).toHaveBeenCalledOnce();
  });
});

describe("MCP principal on Tier-2 (lock) commands — 202 only, never executes", () => {
  it("POST /api/matter/devices/:nodeId/command (lock.lock) as _service:mcp mints a confirmation", async () => {
    mockDevice("102", "lock");
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/matter/devices/102/command")
      .send({ command: "lock" });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: "confirmation_required",
      nodeId: "102",
      command: "lock",
      tier: 2,
    });
    expect(res.body.confirmationToken).toBeTruthy();
    expect(matterService.sendMatterCommand).not.toHaveBeenCalled();
  });
});

describe("MCP principal on commission/decommission", () => {
  it("POST /api/matter/commission as _service:mcp passes the guard: 200", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/matter/commission")
      .send({ pairing_code: "34970112332" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "commissioned", nodeId: "42" });
    expect(matterService.commissionDevice).toHaveBeenCalledOnce();
  });

  it("DELETE /api/matter/devices/:nodeId as _service:mcp passes the guard: 200", async () => {
    const res = await request(buildApp(mcpPrincipal)).delete("/api/matter/devices/103");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "decommissioned", nodeId: "103" });
    expect(matterService.decommissionDevice).toHaveBeenCalledOnce();
  });

  it("POST /api/matter/devices/:nodeId/reconnect as _service:mcp passes the guard: 200 (WARP-1469)", async () => {
    const res = await request(buildApp(mcpPrincipal)).post(
      "/api/matter/devices/113/reconnect",
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "reconnecting", nodeId: "113" });
    expect(matterService.reconnectDevice).toHaveBeenCalledOnce();
  });

  it("reconnect 404s when the node isn't commissioned (false → 404)", async () => {
    vi.mocked(matterService.reconnectDevice).mockResolvedValueOnce(false);
    const res = await request(buildApp(mcpPrincipal)).post(
      "/api/matter/devices/114/reconnect",
    );

    expect(res.status).toBe(404);
  });
});

describe("the guard admits exactly the MCP principal", () => {
  it("another service principal (voice) is still 403", async () => {
    mockDevice("104", "light");
    const res = await request(buildApp(voicePrincipal))
      .post("/api/matter/devices/104/command")
      .send({ command: "turn_on" });

    expect(res.status).toBe(403);
    expect(matterService.sendMatterCommand).not.toHaveBeenCalled();
  });

  it("human RBAC unchanged: guest is still 403", async () => {
    mockDevice("105", "light");
    const res = await request(buildApp(guest))
      .post("/api/matter/devices/105/command")
      .send({ command: "turn_on" });

    expect(res.status).toBe(403);
    expect(matterService.sendMatterCommand).not.toHaveBeenCalled();
  });

  it("voice stays 403 on commission too", async () => {
    const res = await request(buildApp(voicePrincipal))
      .post("/api/matter/commission")
      .send({ pairing_code: "34970112332" });

    expect(res.status).toBe(403);
    expect(matterService.commissionDevice).not.toHaveBeenCalled();
  });

  it("voice stays 403 on reconnect too (WARP-1469)", async () => {
    const res = await request(buildApp(voicePrincipal)).post(
      "/api/matter/devices/115/reconnect",
    );

    expect(res.status).toBe(403);
    expect(matterService.reconnectDevice).not.toHaveBeenCalled();
  });
});

// WARP-1010 — the route layer threads the real caller into
// matter.service's signed activity rows: a dashboard human is `user`
// with their UUID; the MCP/agent-loop service principal is the AI
// surface (`ai`, null on-behalf-of id) — never "system".
describe("WARP-1010 actor attribution threads from the route layer", () => {
  it("a dashboard owner's Tier-1 command is attributed {user, <uuid>}", async () => {
    mockDevice("110", "light");
    const res = await request(buildApp(owner))
      .post("/api/matter/devices/110/command")
      .send({ command: "turn_on" });

    expect(res.status).toBe(200);
    expect(matterService.sendMatterCommand).toHaveBeenCalledWith(
      "110",
      "turn_on",
      { type: "user", id: "u-owner" },
      undefined,
    );
  });

  it("an MCP/agent-loop command stays attributed {ai, null}", async () => {
    mockDevice("111", "light");
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/matter/devices/111/command")
      .send({ command: "turn_on" });

    expect(res.status).toBe(200);
    expect(matterService.sendMatterCommand).toHaveBeenCalledWith(
      "111",
      "turn_on",
      { type: "ai", id: null },
      undefined,
    );
  });

  it("commission carries the human caller; decommission carries the MCP principal as ai", async () => {
    await request(buildApp(owner))
      .post("/api/matter/commission")
      .send({ pairing_code: "34970112332" });
    expect(matterService.commissionDevice).toHaveBeenCalledWith(
      "34970112332",
      { type: "user", id: "u-owner" },
    );

    await request(buildApp(mcpPrincipal)).delete("/api/matter/devices/112");
    expect(matterService.decommissionDevice).toHaveBeenCalledWith("112", {
      type: "ai",
      id: null,
    });
  });
});

// WARP-1447 — the assign_device_room LLM tool dispatches through the MCP
// service principal: room auto-create (POST /matter/rooms) moved from
// requireRole to requireRoleOrMcpService, and the alias route gained a PATCH
// registration (the tools-core HttpClient exposes no put()). Same exact-
// principal posture as the command routes: voice/guest stay excluded.
describe("WARP-1447 rooms-create + alias PATCH admit exactly the MCP principal", () => {
  it("POST /api/matter/rooms as _service:mcp passes the guard: 201", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(mcpPrincipal, prisma))
      .post("/api/matter/rooms")
      .send({ name: "Den" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: "room-1", name: "Den" });
    expect(prisma.room.create).toHaveBeenCalledOnce();
  });

  it("POST /api/matter/rooms as voice stays 403 (create never reached)", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(voicePrincipal, prisma))
      .post("/api/matter/rooms")
      .send({ name: "Den" });

    expect(res.status).toBe(403);
    expect(prisma.room.create).not.toHaveBeenCalled();
  });

  it("human RBAC unchanged: guest stays 403 on rooms create", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(guest, prisma))
      .post("/api/matter/rooms")
      .send({ name: "Den" });

    expect(res.status).toBe(403);
    expect(prisma.room.create).not.toHaveBeenCalled();
  });

  it("PATCH /api/matter/devices/:nodeId/alias as _service:mcp assigns the room and PRESERVES the stored alias name when the body omits `name`", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(mcpPrincipal, prisma))
      .patch("/api/matter/devices/77/alias")
      .send({ roomId: "room-1" });

    expect(res.status).toBe(200);
    // upsertAlias keeps the existing alias name ("Kitchen strip") because the
    // `name` key is absent from the body — the tool's contract.
    expect(res.body).toEqual({ nodeId: "77", name: "Kitchen strip", roomId: "room-1" });
    expect(prisma.deviceAlias.upsert).toHaveBeenCalledOnce();
  });

  it("PATCH alias as voice stays 403 (no upsert)", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(voicePrincipal, prisma))
      .patch("/api/matter/devices/77/alias")
      .send({ roomId: "room-1" });

    expect(res.status).toBe(403);
    expect(prisma.deviceAlias.upsert).not.toHaveBeenCalled();
  });
});

describe("the confirm endpoint never accepts the MCP principal", () => {
  // The "202 only, never executes" invariant above holds only if the
  // principal that mints a token cannot also confirm it. Human-only,
  // like /network/command/confirm.
  it("POST /api/matter/devices/:nodeId/confirm as _service:mcp is 403", async () => {
    const res = await request(buildApp(mcpPrincipal))
      .post("/api/matter/devices/102/confirm")
      .send({ confirmationToken: "tok", service: "lock" });

    expect(res.status).toBe(403);
    expect(matterService.sendMatterCommand).not.toHaveBeenCalled();
  });

  it("an owner passes the guard (bad token reaches the handler: 400, not 403)", async () => {
    const res = await request(buildApp(owner))
      .post("/api/matter/devices/102/confirm")
      .send({ confirmationToken: "no-such-token", service: "lock" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_MISSING");
  });
});
