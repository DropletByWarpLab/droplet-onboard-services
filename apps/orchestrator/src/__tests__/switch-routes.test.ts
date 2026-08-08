/**
 * §7 switch route wiring (ADDON-network-switch-management.md §7).
 *
 * Proves the orchestrator §7 surface:
 *  - reads (/status, /ports, /vlans) return the aggregated §7 shapes;
 *  - writes (/ports/:p/vlan, /poe, /enable, /provision) route to the right
 *    Tier-2 op and return a confirmation token (202);
 *  - the protected port → Tier-3 block (403) on enable;
 *  - the confirm endpoint executes the right downstream client call;
 *  - RBAC: non-admin → 403.
 *
 * The switch hardware client + the aggregation are mocked at the module
 * boundary so this test exercises only the route → safety-tier → client
 * wiring, never a live switch. Mirrors the rbac.test.ts mocking pattern.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// The switch router reads PROTECTED_PORT from process.env at module load
// (not from the mocked config). Pin it to 9 BEFORE the hoisted route import so
// the protected-port → Tier-3 branch is exercised. vi.hoisted runs before the
// ES-module imports below.
vi.hoisted(() => {
  process.env.SWITCH_PROTECTED_PORT = "9";
});

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    SWITCH_SERVICE_URL: "http://switch.test:8081",
    SWITCH_PROTECTED_PORT: "9",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// The aggregation service (read routes call this).
vi.mock("../services/switch-aggregation.service.js", () => ({
  fetchSwitchStatus: vi.fn().mockResolvedValue({ connected: true, model: "SM8TAT2SA", poe_used_w: 16.6 }),
  fetchSwitchPorts: vi.fn().mockResolvedValue([{ port: 1, label: "1/1", role: "client" }]),
  fetchSwitchVlans: vi.fn().mockResolvedValue([{ vlan_id: 1, name: "LAN", isolated: false, ports: [1] }]),
}));

// The switch hardware client (write routes call these on confirm/execute).
vi.mock("../services/switch.client.js", () => ({
  setVlanMembership: vi.fn().mockResolvedValue(undefined),
  enablePortPoe: vi.fn().mockResolvedValue(undefined),
  disablePortPoe: vi.fn().mockResolvedValue(undefined),
  enablePort: vi.fn().mockResolvedValue(undefined),
  disablePort: vi.fn().mockResolvedValue(undefined),
  provisionSwitch: vi.fn().mockResolvedValue({ status: "applied" }),
  // unused by §7 routes but imported by the router module:
  fetchPorts: vi.fn(),
  fetchPort: vi.fn(),
  fetchVlans: vi.fn(),
  fetchVlanMembership: vi.fn(),
  fetchPoeStatus: vi.fn(),
  fetchPortPoe: vi.fn(),
  fetchSystemInfo: vi.fn(),
  createVlan: vi.fn(),
  deleteVlan: vi.fn(),
  detectWanPort: vi.fn(),
  setupCameraPorts: vi.fn(),
}));

import { createSwitchRouter } from "../routes/switch.js";
import * as switchClient from "../services/switch.client.js";
import * as agg from "../services/switch-aggregation.service.js";
import type { AuthUser } from "../middleware/auth.js";

// A minimal in-memory network-safety double so the route's safety-tier calls
// resolve deterministically without Prisma. We mount it via the prisma arg
// the router threads into evaluateNetworkCommand — but the real
// network-safety.service is used, so we mock IT instead for token control.
const evalMock = vi.fn();
const confirmMock = vi.fn();
vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: (...args: unknown[]) => evalMock(...args),
  confirmNetworkCommand: (...args: unknown[]) => confirmMock(...args),
}));

function buildApp(user: AuthUser | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createSwitchRouter({} as never));
  return app;
}

const owner: AuthUser = { id: "u-owner", role: "owner" } as AuthUser;
const guest: AuthUser = { id: "u-guest", role: "guest" } as AuthUser;

beforeEach(() => {
  vi.clearAllMocks();
  // Default: Tier-2 — require confirmation (returns a token).
  evalMock.mockResolvedValue({
    allowed: false,
    requiresConfirmation: true,
    confirmationToken: "tok-123",
    reason: "requires confirmation",
    tier: 2,
  });
});

// --- Reads ------------------------------------------------------------------

describe("§7 read routes", () => {
  it("GET /api/switch/status returns the aggregated status", async () => {
    const res = await request(buildApp(owner)).get("/api/switch/status");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connected: true, model: "SM8TAT2SA" });
    expect(agg.fetchSwitchStatus).toHaveBeenCalled();
  });

  it("GET /api/switch/ports returns the aggregated §7 port array (bare array)", async () => {
    const res = await request(buildApp(owner)).get("/api/switch/ports");
    expect(res.status).toBe(200);
    // §7 contract is a bare array, not { ports: [...] }.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ port: 1, label: "1/1" });
    expect(agg.fetchSwitchPorts).toHaveBeenCalled();
  });

  it("GET /api/switch/vlans returns the aggregated §7 vlan array (bare array)", async () => {
    const res = await request(buildApp(owner)).get("/api/switch/vlans");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0]).toMatchObject({ vlan_id: 1, isolated: false });
    expect(agg.fetchSwitchVlans).toHaveBeenCalled();
  });
});

// --- Writes: routing to the right op ---------------------------------------

describe("§7 write routes route to the right Tier-2 op", () => {
  // evaluateNetworkCommand(prisma, entityId, operation, params, userId, source)
  // → operation is arg index 2, params index 3.
  it("POST /ports/:port/vlan → switch_set_vlan_membership, 202 with token", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/ports/4/vlan").send({ vlan_id: 100 });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: "confirmation_required", confirmationToken: "tok-123" });
    expect(evalMock.mock.calls[0][2]).toBe("switch_set_vlan_membership");
    // The translated params carry the port as an untagged member of vlan 100.
    expect(evalMock.mock.calls[0][3]).toMatchObject({ vlan_id: 100, ports: [{ port: 4, tagged: false, member: true }] });
  });

  it("POST /ports/:port/poe {enabled:false} → switch_poe_disable", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/ports/3/poe").send({ enabled: false });
    expect(res.status).toBe(202);
    expect(evalMock.mock.calls[0][2]).toBe("switch_poe_disable");
    expect(evalMock.mock.calls[0][3]).toMatchObject({ port: 3 });
  });

  it("POST /ports/:port/poe {enabled:true} → switch_poe_enable", async () => {
    await request(buildApp(owner)).post("/api/switch/ports/3/poe").send({ enabled: true });
    expect(evalMock.mock.calls[0][2]).toBe("switch_poe_enable");
  });

  it("POST /ports/:port/enable {enabled:false} → switch_port_disable", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/ports/3/enable").send({ enabled: false });
    expect(res.status).toBe(202);
    expect(evalMock.mock.calls[0][2]).toBe("switch_port_disable");
  });

  it("POST /ports/:port/enable {enabled:true} → switch_port_enable", async () => {
    await request(buildApp(owner)).post("/api/switch/ports/3/enable").send({ enabled: true });
    expect(evalMock.mock.calls[0][2]).toBe("switch_port_enable");
  });

  it("POST /provision → switch_provision", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/provision").send({});
    expect(res.status).toBe(202);
    expect(evalMock.mock.calls[0][2]).toBe("switch_provision");
  });
});

// --- Protected-port → Tier-3 ------------------------------------------------

describe("protected port is Tier-3 on enable/disable + vlan", () => {
  it("POST /ports/9/enable {enabled:false} → switch_disable_protected_port, 403 block", async () => {
    // Protected port (9) disable: the safety tier classifies this Tier-3 and
    // blocks. The route must route to switch_disable_protected_port.
    evalMock.mockResolvedValue({ allowed: false, blocked: true, reason: "protected", tier: 3 });
    const res = await request(buildApp(owner)).post("/api/switch/ports/9/enable").send({ enabled: false });
    expect(res.status).toBe(403);
    expect(evalMock.mock.calls[0][2]).toBe("switch_disable_protected_port");
  });

  it("POST /ports/9/vlan → switch_disable_protected_port (never moves uplink off its VLAN)", async () => {
    evalMock.mockResolvedValue({ allowed: false, blocked: true, reason: "protected", tier: 3 });
    const res = await request(buildApp(owner)).post("/api/switch/ports/9/vlan").send({ vlan_id: 100 });
    expect(res.status).toBe(403);
    expect(evalMock.mock.calls[0][2]).toBe("switch_disable_protected_port");
  });
});

// --- Confirm executes the right downstream call -----------------------------

describe("confirm executes the §7 write", () => {
  it("confirming switch_set_vlan_membership calls setVlanMembership", async () => {
    confirmMock.mockResolvedValue({
      confirmed: true,
      operation: "switch_set_vlan_membership",
      params: { vlan_id: 100, ports: [{ port: 4, tagged: false, member: true }] },
    });
    const res = await request(buildApp(owner))
      .post("/api/switch/command/confirm")
      .send({ confirmationToken: "tok-123" });
    expect(res.status).toBe(200);
    // The third arg is the declared membership semantics: a token with no
    // recorded mode replays as "merge", which cannot wipe the VLAN's other
    // members (audit 2026-08-06).
    expect(switchClient.setVlanMembership).toHaveBeenCalledWith(
      100,
      [{ port: 4, tagged: false, member: true }],
      "merge",
    );
  });

  it("confirming switch_provision calls provisionSwitch", async () => {
    confirmMock.mockResolvedValue({ confirmed: true, operation: "switch_provision", params: {} });
    const res = await request(buildApp(owner))
      .post("/api/switch/command/confirm")
      .send({ confirmationToken: "tok-123" });
    expect(res.status).toBe(200);
    expect(switchClient.provisionSwitch).toHaveBeenCalled();
  });

  it("confirming switch_poe_enable calls enablePortPoe", async () => {
    confirmMock.mockResolvedValue({ confirmed: true, operation: "switch_poe_enable", params: { port: 3 } });
    await request(buildApp(owner)).post("/api/switch/command/confirm").send({ confirmationToken: "tok-123" });
    expect(switchClient.enablePortPoe).toHaveBeenCalledWith(3);
  });
});

// --- RBAC -------------------------------------------------------------------

describe("§7 write routes require owner/admin", () => {
  const WRITES: { path: string; body: Record<string, unknown> }[] = [
    { path: "/api/switch/ports/4/vlan", body: { vlan_id: 100 } },
    { path: "/api/switch/ports/3/poe", body: { enabled: true } },
    { path: "/api/switch/ports/3/enable", body: { enabled: true } },
    { path: "/api/switch/provision", body: {} },
  ];

  for (const w of WRITES) {
    it(`POST ${w.path}: guest → 403`, async () => {
      const res = await request(buildApp(guest)).post(w.path).send(w.body);
      expect(res.status).toBe(403);
      // Guard rejects before the safety tier runs.
      expect(evalMock).not.toHaveBeenCalled();
    });
  }
});

// --- Validation -------------------------------------------------------------

describe("§7 write validation", () => {
  it("POST /ports/:port/poe rejects a non-boolean enabled", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/ports/3/poe").send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });

  it("POST /ports/:port/vlan rejects a missing vlan_id", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/ports/4/vlan").send({});
    expect(res.status).toBe(400);
  });

  it("POST /ports/:port/poe rejects an SFP port (PoE is copper 1-8 only)", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/ports/9/poe").send({ enabled: true });
    expect(res.status).toBe(400);
  });
});
