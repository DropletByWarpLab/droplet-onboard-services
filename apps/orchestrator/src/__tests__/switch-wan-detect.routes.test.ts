/**
 * WAN detection completes in one request (WARP-2125 regression).
 *
 * The shipped build classified `switch_wan_detect` as Tier 2, so
 * `POST /switch/wan/detect` always answered 202 + confirmationToken — and the
 * confirm dispatcher (`POST /switch/command/confirm`) had no case for it, so
 * redeeming the token answered `400 Unknown operation: switch_wan_detect`.
 * WAN detection could never complete. Same class as WARP-2122
 * (`set_ssh_access`), found by confirm-dispatcher-coverage.guard.test.ts.
 *
 * The fix is NOT a dispatcher case: detection is a pure read (the switch
 * service's `detect_wan_port()` calls `get_ports()`, picks the linked SFP —
 * else first linked copper — and returns `{wan_port, confidence, reason}`;
 * no uci writes, no persisted state), and the dispatcher assigns into
 * `switchClient.SwitchWriteResult` — a read does not belong in it. So the
 * operation drops below Tier 2 and auto-executes, keeping RBAC + audit via
 * `evalSwitchCommand`.
 *
 * Per-route tests could not see the original defect: mint and dispatcher were
 * each individually consistent. Only the pipeline — REAL safety service, the
 * real router, one prisma — shows the terminal answer. Same `buildFullApp`
 * shape as network-ssh-confirm.routes.test.ts / network-guest-upnp.routes.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

const { configMock } = vi.hoisted(() => ({
  configMock: {
    AUTH_ENABLED: true,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("../config.js", () => ({ config: configMock }));

/** The detection body the switch service actually returns — a read result. */
const DETECTION = {
  wan_port: 9,
  confidence: "high",
  reason: "SFP port 9 has an active link",
};

// The hardware boundary. Only detectWanPort matters here; the rest of the
// client surface is stubbed for import safety (the router imports * and the
// confirm dispatcher references the write funcs).
vi.mock("../services/switch.client.js", () => ({
  detectWanPort: vi.fn().mockResolvedValue({
    wan_port: 9,
    confidence: "high",
    reason: "SFP port 9 has an active link",
  }),
  fetchPort: vi.fn(), fetchVlanMembership: vi.fn(), fetchPoeStatus: vi.fn(),
  fetchPortPoe: vi.fn(), fetchSystemInfo: vi.fn(),
  enablePort: vi.fn(), disablePort: vi.fn(), createVlan: vi.fn(),
  deleteVlan: vi.fn(), setVlanMembership: vi.fn(),
  enablePortPoe: vi.fn(), disablePortPoe: vi.fn(),
  setupCameraPorts: vi.fn(), provisionSwitch: vi.fn(),
}));

// §7 reads join through the aggregation service — not under test.
vi.mock("../services/switch-aggregation.service.js", () => ({
  fetchSwitchStatus: vi.fn().mockResolvedValue({ connected: true }),
  fetchSwitchPorts: vi.fn().mockResolvedValue([]),
  fetchSwitchVlans: vi.fn().mockResolvedValue([]),
}));

import { createSwitchRouter } from "../routes/switch.js";
import { classifyNetworkCommand } from "../config/network-safety-rules.js";
import { detectWanPort } from "../services/switch.client.js";
import type { AuthUser } from "../middleware/auth.js";

const mockDetectWan = vi.mocked(detectWanPort);

function createPrismaMock() {
  return {
    commandAuditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient;
}

const owner: AuthUser = {
  id: "u-owner",
  username: "stefan",
  displayName: "stefan",
  role: "owner",
};

/** The REAL router + REAL safety service on one prisma — the full pipeline. */
function buildFullApp(prisma: PrismaClient = createPrismaMock()): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = owner;
    next();
  });
  app.use("/api", createSwitchRouter(prisma));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDetectWan.mockResolvedValue(DETECTION);
});

describe("switch_wan_detect tier contract (WARP-2125)", () => {
  it("is Tier 1 — a pure read auto-executes, no confirmation to mint", () => {
    const c = classifyNetworkCommand("switch_wan_detect");
    expect(c.tier).toBe(1);
    expect(c.requiresConfirmation).toBe(false);
  });
});

describe("POST /api/switch/wan/detect", () => {
  it("answers the detection body directly — 200, no confirmationToken, one driver call", async () => {
    const res = await request(buildFullApp()).post("/api/switch/wan/detect").send({});

    // Pre-fix this was 202 {status:"confirmation_required", confirmationToken}
    // — a token POST /switch/command/confirm then refused as
    // "Unknown operation: switch_wan_detect", so detection NEVER completed.
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DETECTION);
    expect(res.body.confirmationToken).toBeUndefined();
    expect(mockDetectWan).toHaveBeenCalledTimes(1);
  });

  it("the read is still audited as Tier 1 through the real safety service", async () => {
    const prisma = createPrismaMock();
    await request(buildFullApp(prisma)).post("/api/switch/wan/detect").send({});

    expect(prisma.commandAuditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.commandAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: "switch.switch_wan_detect",
        service: "switch_wan_detect",
        tier: 1,
        confirmed: true,
        blocked: false,
      }),
    });
  });
});
