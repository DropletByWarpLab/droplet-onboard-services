/**
 * WARP-1450 — MCP-principal admission on the two /api/updates routes the
 * get_update_status / apply_update LLM tools dispatch through.
 *
 * The tools present the `_service:mcp` principal (role "service"), which
 * plain requireRole 403s — the exact dead-tool class WARP-1439 fixed for
 * the camera event/clip tools. These tests pin that EXACTLY two guards
 * are requireRoleOrMcpService — GET /updates/status and
 * POST /updates/apply-now — while the rest of the WARP-540 surface
 * (history, check-now, skip, settings) stays human-only, and that human
 * RBAC is byte-identical everywhere (owner admitted, family denied).
 * Scaffolding per cameras-mcp-guards.test.ts: real auth guards, a
 * req.user shim, and INJECTED update-agent deps so no GitHub endpoint,
 * cosign binary, or compose socket is ever touched.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    DROPLET_OTA_RELEASES_URL: "https://releases.test/latest",
    DROPLET_OTA_GITHUB_TOKEN: "",
    DROPLET_OTA_APPLY_SCRIPT: "",
    DROPLET_OTA_COMPOSE_FILE: "/opt/droplet/docker/docker-compose.yml",
    DROPLET_OTA_UPDATES_DIR: "/data/updates",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createUpdatesRouter, type UpdatesRouterDeps } from "../routes/updates.js";
import { DEFAULT_UPDATE_AGENT_SETTINGS } from "../services/update-agent/settings.js";
import type { AuthUser } from "../middleware/auth.js";

const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
};
const owner: AuthUser = {
  id: "u-owner", username: "romain", displayName: "romain", role: "owner",
};
const family: AuthUser = {
  id: "u-fam", username: "fam", displayName: "fam", role: "family",
};

/**
 * Empty-store Prisma shim — every status/apply/skip read finds no rows,
 * which is enough to prove the guard verdicts: an admitted principal
 * reaches route logic (200 status payload / typed 409/503), a denied one
 * never touches prisma at all.
 */
function createPrismaShim() {
  return {
    deviceUpdate: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function createDepsMock(): UpdatesRouterDeps {
  return {
    checkForUpdate: vi.fn().mockResolvedValue({ outcome: "up_to_date" }) as never,
    applyPendingUpdate: vi.fn() as never,
    getUpdateAgentSettings: vi.fn().mockResolvedValue({ ...DEFAULT_UPDATE_AGENT_SETTINGS }),
    saveUpdateAgentSettings: vi
      .fn()
      .mockResolvedValue({ ...DEFAULT_UPDATE_AGENT_SETTINGS }),
    // Null runner = apply not provisioned (dev/CI shape): apply-now's
    // honest 503 is the cheapest proof the request cleared the guard and
    // ran real route logic instead of dying 401/403 in front of it.
    getApplyRunner: () => null,
  };
}

function buildApp(
  user: AuthUser,
  prisma: ReturnType<typeof createPrismaShim> = createPrismaShim(),
  deps: UpdatesRouterDeps = createDepsMock(),
): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createUpdatesRouter(prisma as unknown as PrismaClient, deps));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordActivityMock.mockResolvedValue(null);
});

describe("updates guards admit the MCP service principal on the two tool routes (WARP-1450)", () => {
  it("GET /updates/status — MCP principal gets the full status payload", async () => {
    const prisma = createPrismaShim();
    const res = await request(buildApp(mcpPrincipal, prisma)).get("/api/updates/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      current: null,
      pending: null,
      lastVerdict: null,
      degraded: false,
      settings: { ...DEFAULT_UPDATE_AGENT_SETTINGS },
      applyAvailable: false,
      // WARP-2133 — the mocked config leaves DROPLET_OTA_GITHUB_TOKEN empty,
      // so the release source reads as unprovisioned. Asserted here because
      // this is an exact-payload check: a new /status field must be declared
      // in the MCP contract too, not just the human one.
      updateSourceAuthenticated: false,
    });
    // The handler actually ran its three DeviceUpdate reads.
    expect(prisma.deviceUpdate.findFirst).toHaveBeenCalledTimes(3);
  });

  it("POST /updates/apply-now — MCP principal reaches route logic (503 apply_unavailable, not 401/403)", async () => {
    const res = await request(buildApp(mcpPrincipal)).post("/api/updates/apply-now");

    // Null runner ⇒ the route's own honest answer. Any 401/403 here would
    // mean the guard bounced the service principal before the handler.
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "apply_unavailable" });
  });

  it.each([
    ["get", "/api/updates/settings"],
    ["post", "/api/updates/skip"],
  ] as const)("%s %s — MCP principal stays denied (403) on the human-only surface", async (method, path) => {
    const prisma = createPrismaShim();
    const res = await (request(buildApp(mcpPrincipal, prisma)) as any)[method](path).send({});

    expect(res.status).toBe(403);
    // Denied in front of the handler: no store access, and the only
    // activity is the guard's own "Access denied" row — never an OTA
    // mutation audit.
    expect(prisma.deviceUpdate.findFirst).not.toHaveBeenCalled();
    const otaAudits = recordActivityMock.mock.calls.filter(
      ([row]) => typeof row?.what === "string" && row.what.startsWith("OTA"),
    );
    expect(otaAudits).toEqual([]);
  });

  it.each([
    ["get", "/api/updates/status"],
    ["get", "/api/updates/history"],
    ["get", "/api/updates/settings"],
    ["post", "/api/updates/check-now"],
    ["post", "/api/updates/apply-now"],
    ["post", "/api/updates/skip"],
    ["put", "/api/updates/settings"],
  ] as const)("human RBAC unchanged: owner clears the guard on %s %s", async (method, path) => {
    const res = await (request(buildApp(owner)) as any)[method](path).send({});

    // Route logic may answer 200/409/503 on the empty store — the pin is
    // that the guard never rejects an owner.
    expect([401, 403]).not.toContain(res.status);
  });

  it("human RBAC unchanged: family still 403 on GET /updates/status", async () => {
    // Pre-WARP-1450 behavior, pinned: family was already denied across
    // the whole WARP-540 surface (routes/updates.test.ts), and admitting
    // `_service:mcp` on status must not loosen the human gate.
    const prisma = createPrismaShim();
    const res = await request(buildApp(family, prisma)).get("/api/updates/status");

    expect(res.status).toBe(403);
    expect(prisma.deviceUpdate.findFirst).not.toHaveBeenCalled();
  });
});
