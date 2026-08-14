/**
 * WARP-1732 — `GET /api/network/fabric/members` (ADR-035 §5).
 *
 * Read-only inventory surface over the `FabricMember` rows the reconciler
 * persists. Two things are load-bearing here:
 *
 *  1. **Auth.** The route carries no per-route role gate — same posture as
 *     every other network READ (`/network/status`, `/network/topology`,
 *     `/api/aps`), which are open to any authenticated principal so the
 *     agent's `service` role can read them too. That posture is only safe
 *     because the route sits behind the global `authMiddleware` that
 *     `app.ts` mounts before `createNetworkRouter`. So this file mounts the
 *     PRODUCTION middleware with `AUTH_ENABLED: true` and asserts a
 *     credential-less request never reaches the handler — the regression
 *     that "open to every role" must not be allowed to become.
 *  2. **Shape.** camelCase rows, most-recently-seen first, `poePorts` /
 *     `poeBudget` present as numbers or null.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    // A service principal is the cheapest authenticated caller to mint in a
    // test, and it is a REAL consumer of this route (the LLM's network
    // tools), so it doubles as the "reads are open to service" assertion.
    SERVICE_TOKEN_MCP: "test-mcp-token-32chars-padding-1234a",
    NODE_ENV: "test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// The OCS fallback must never be reached on these paths; blow up loudly if
// the service-token short-circuit ever regresses into a network call.
vi.stubGlobal(
  "fetch",
  vi.fn(async () => new Response("nope", { status: 500 })),
);

import { authMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { registerFabricRoutes } from "./network-fabric.routes.js";

const MCP_BEARER = "Bearer test-mcp-token-32chars-padding-1234a";

const ROWS = [
  {
    anchorMac: "70:49:A2:77:64:1A",
    role: "switch",
    model: "Zyxel GS1900-10HP",
    version: "24.10.0",
    lastIp: "192.168.9.2",
    hostname: "droplet-switch",
    poePorts: 8,
    poeBudget: 77,
    firstSeen: new Date("2026-08-01T09:00:00.000Z"),
    lastSeen: new Date("2026-08-05T10:00:00.000Z"),
  },
  {
    anchorMac: "02:FC:58:E2:4E:02",
    role: "router",
    model: "Raspberry Pi 5 Model B",
    version: "OpenWrt 25.12",
    lastIp: "192.168.9.1",
    hostname: "droplet-edge",
    poePorts: null,
    poeBudget: null,
    firstSeen: new Date("2026-08-01T09:00:00.000Z"),
    lastSeen: new Date("2026-08-05T09:59:00.000Z"),
  },
];

/** `findMany` is deliberately loosely typed so a case can hand in an empty
 *  list or a thrower without fighting the inferred row-union. */
type FindManyStub = ReturnType<typeof vi.fn<[], Promise<unknown[]>>>;

function buildApp(
  findMany: FindManyStub = vi.fn<[], Promise<unknown[]>>(async () => ROWS),
) {
  const app = express();
  app.use(express.json());
  // The PRODUCTION gate, exactly as app.ts mounts it.
  app.use(authMiddleware);
  const router = express.Router();
  registerFabricRoutes(router, {
    prisma: { fabricMember: { findMany } } as never,
  });
  app.use("/api", router);
  app.use(errorHandler);
  return { app, findMany };
}

describe("GET /api/network/fabric/members (WARP-1732)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("401s a request with no credentials — the route is behind the global auth gate", async () => {
    const { app, findMany } = buildApp();
    const res = await request(app).get("/api/network/fabric/members");
    expect(res.status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("401s a bad bearer", async () => {
    const { app, findMany } = buildApp();
    const res = await request(app)
      .get("/api/network/fabric/members")
      .set("Authorization", "Bearer wrong-token-wrong-token-wrong-1234");
    expect(res.status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns the persisted members, most-recently-seen first", async () => {
    const { app, findMany } = buildApp();
    const res = await request(app)
      .get("/api/network/fabric/members")
      .set("Authorization", MCP_BEARER);

    expect(res.status).toBe(200);
    expect(findMany).toHaveBeenCalledWith({ orderBy: { lastSeen: "desc" } });
    expect(res.body.members).toHaveLength(2);
    expect(res.body.members[0]).toMatchObject({
      anchorMac: "70:49:A2:77:64:1A",
      role: "switch",
      model: "Zyxel GS1900-10HP",
      version: "24.10.0",
      lastIp: "192.168.9.2",
      hostname: "droplet-switch",
      poePorts: 8,
      poeBudget: 77,
    });
    expect(res.body.members[0].firstSeen).toBe("2026-08-01T09:00:00.000Z");
    expect(res.body.members[0].lastSeen).toBe("2026-08-05T10:00:00.000Z");
    // Absent PoE is null, not omitted and not 0.
    expect(res.body.members[1].poePorts).toBeNull();
    expect(res.body.members[1].poeBudget).toBeNull();
  });

  it("an empty fabric returns an empty list, not a 404", async () => {
    const { app } = buildApp(vi.fn<[], Promise<unknown[]>>(async () => []));
    const res = await request(app)
      .get("/api/network/fabric/members")
      .set("Authorization", MCP_BEARER);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ members: [] });
  });

  it("a database failure surfaces through the shared error handler, not as a hang", async () => {
    const { app } = buildApp(
      vi.fn<[], Promise<unknown[]>>(async () => {
        throw new Error("connection terminated");
      }),
    );
    const res = await request(app)
      .get("/api/network/fabric/members")
      .set("Authorization", MCP_BEARER);

    expect(res.status).toBe(500);
  });
});
