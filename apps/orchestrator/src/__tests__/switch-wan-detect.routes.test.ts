/**
 * WARP-2125 — POST /switch/wan/detect must COMPLETE, not mint a dead token.
 *
 * `switch_wan_detect` sat in TIER_2_OPERATIONS, so the route answered 202 with
 * a confirmation token — but /switch/command/confirm has no case for it, so
 * confirming answered "Unknown operation" and WAN detection could never finish
 * on any path (dashboard or the detect_wan_port LLM tool). The second live
 * instance of the WARP-1984 mint-without-redeemer class, found by
 * confirm-dispatcher-coverage.guard.test.ts while WARP-2122 was being fixed.
 *
 * The fix drops the operation to Tier 1 rather than adding a dispatcher case:
 * detectWanPort() is a pure read (the driver walks get_ports() and returns a
 * {wan_port, confidence, reason} heuristic — services/switch/drivers/
 * openwrt.py), it mutates nothing, and it returns a detection result, not the
 * SwitchWriteResult the confirm dispatcher is typed around. A read has no
 * blast radius to confirm.
 *
 * Deliberately uses the REAL network-safety service and the REAL tier
 * classifier — mocking the safety verdict here would make this file circular
 * (every other switch route test mocks it, which is exactly why none of them
 * could see this bug). Only the hardware client, the audit sinks, and config
 * are mocked. Tier 1 still audits and rate-limits; the audit assertion below
 * pins that dropping the confirmation did not drop the trail.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// Config mock — hoisted above the route import so middleware/auth can build
// its SERVICE_PRINCIPALS registry (same shape as switch-mcp-guards.test.ts).
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_MCP: "test-mcp-token-32chars-padding-1234a",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

/** What the switch service's read-only heuristic actually returns. */
const DETECTION = {
  wan_port: 9,
  confidence: "high",
  reason: "SFP port with active link (uplink bank)",
};

vi.mock("../services/switch.client.js", () => ({
  detectWanPort: vi.fn().mockResolvedValue({
    wan_port: 9,
    confidence: "high",
    reason: "SFP port with active link (uplink bank)",
  }),
  // Imported by the router module; unused on this path.
  fetchPoeStatus: vi.fn(), enablePortPoe: vi.fn(), disablePortPoe: vi.fn(),
  setVlanMembership: vi.fn(), setupCameraPorts: vi.fn(), enablePort: vi.fn(),
  disablePort: vi.fn(), createVlan: vi.fn(), deleteVlan: vi.fn(),
  provisionSwitch: vi.fn(), fetchPort: vi.fn(), fetchVlanMembership: vi.fn(),
  fetchPortPoe: vi.fn(), fetchSystemInfo: vi.fn(),
}));

vi.mock("../services/switch-aggregation.service.js", () => ({
  fetchSwitchStatus: vi.fn(), fetchSwitchPorts: vi.fn(), fetchSwitchVlans: vi.fn(),
}));

// The real network-safety service dual-writes its audit; the activity recorder
// singleton is uninitialized under vitest, so spy it out (network-safety.test.ts
// pattern).
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(null),
}));

import { createSwitchRouter } from "../routes/switch.js";
import { detectWanPort } from "../services/switch.client.js";
import { classifyNetworkCommand } from "../config/network-safety-rules.js";
import type { AuthUser } from "../middleware/auth.js";
import type { PrismaClient } from "@prisma/client";

const auditCreate = vi.fn().mockResolvedValue({ id: "audit-1" });
/** Just enough Prisma for logNetworkCommand's audit write. */
const prisma = { commandAuditLog: { create: auditCreate } } as unknown as PrismaClient;

const owner: AuthUser = { id: "u-owner", role: "owner" } as AuthUser;
const guest: AuthUser = { id: "u-guest", role: "guest" } as AuthUser;
const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
} as AuthUser;

function buildApp(user: AuthUser | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createSwitchRouter(prisma));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /switch/wan/detect executes without a confirmation token (WARP-2125)", () => {
  it("owner: 200 with the detection result — no token, no confirm round-trip, audited as Tier 1", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/wan/detect").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual(DETECTION);
    // The mint-without-redeemer shape must be gone, not just the status code.
    expect(res.body.confirmationToken).toBeUndefined();
    expect(res.body.requiresConfirmation).toBeUndefined();
    expect(detectWanPort).toHaveBeenCalledOnce();

    // Tier 1 still writes the audit trail — the confirmation was dropped, the
    // accountability was not.
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      service: "switch_wan_detect",
      tier: 1,
      confirmed: true,
      blocked: false,
    });
  });

  it("MCP service principal: the detect_wan_port tool path completes end-to-end", async () => {
    // Before this fix the tool's 202 envelope led to a token nothing could
    // redeem — the agent could propose WAN detection but no one could finish it.
    const res = await request(buildApp(mcpPrincipal)).post("/api/switch/wan/detect").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DETECTION);
  });

  it("guest: still 403 — dropping the tier relaxed confirmation, not RBAC", async () => {
    const res = await request(buildApp(guest)).post("/api/switch/wan/detect").send({});
    expect(res.status).toBe(403);
    expect(detectWanPort).not.toHaveBeenCalled();
  });

  it("switch_wan_detect classifies Tier 1 — a read-only detection has nothing to confirm", () => {
    const c = classifyNetworkCommand("switch_wan_detect");
    expect(c.tier).toBe(1);
    expect(c.requiresConfirmation).toBe(false);
  });
});
