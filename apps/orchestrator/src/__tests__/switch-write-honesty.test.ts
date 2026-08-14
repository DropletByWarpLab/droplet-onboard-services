/**
 * Switch writes must report what actually happened — on the paths users take.
 *
 * Two coupled defects from the 2026-08-06 audit, both of which survived the
 * first pass because the fix landed on the direct-write routes only:
 *
 * 1. HONESTY. Per this router's own header, Tier-2 switch ops execute via
 *    `POST /switch/command/confirm` — that is the primary execution path, and
 *    its switch-statement threw the client's result away and answered a
 *    hard-coded `{status:"ok", confirmed:true}`. With SWITCH_LIVE_WRITES=0 the
 *    switch service stages the change and returns `{status:"planned",
 *    dry_run:true}`, so a dry run confirmed through the normal dashboard flow
 *    reported a success that never touched hardware. The three §7 routes had
 *    the same gap in their own direct-execution branches.
 *
 * 2. MERGE SEMANTICS. `setVlanMembership` is the REPLACE primitive: called with
 *    one port it wipes the VLAN's other members (on VLAN 1 the uplink, the AP
 *    and the appliance). Every caller must now DECLARE `merge` or `replace`;
 *    the dashboard's "move this port's VLAN" route is definitionally a merge.
 *
 * The two are coupled: making dry-run honest is what finally arms real writes,
 * so the merge default has to land with it.
 *
 * The switch client is mocked at the module boundary (mirrors
 * switch-routes.test.ts) — nothing here talks to a switch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

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

vi.mock("../services/switch-aggregation.service.js", () => ({
  fetchSwitchStatus: vi.fn(),
  fetchSwitchPorts: vi.fn(),
  fetchSwitchVlans: vi.fn(),
}));

/**
 * A plan-only (SWITCH_LIVE_WRITES=0) response from the switch service. This is
 * what every write client returns when the driver staged but did not apply.
 */
const PLANNED = { status: "planned", dry_run: true, plan: { op: "x" } };
const APPLIED = { status: "ok", dry_run: false };

vi.mock("../services/switch.client.js", () => ({
  setVlanMembership: vi.fn(),
  enablePortPoe: vi.fn(),
  disablePortPoe: vi.fn(),
  enablePort: vi.fn(),
  disablePort: vi.fn(),
  createVlan: vi.fn(),
  deleteVlan: vi.fn(),
  setupCameraPorts: vi.fn(),
  provisionSwitch: vi.fn(),
  fetchPorts: vi.fn(),
  fetchPort: vi.fn(),
  fetchVlans: vi.fn(),
  fetchVlanMembership: vi.fn(),
  fetchPoeStatus: vi.fn(),
  fetchPortPoe: vi.fn(),
  fetchSystemInfo: vi.fn(),
  detectWanPort: vi.fn(),
}));

import { createSwitchRouter } from "../routes/switch.js";
import * as switchClient from "../services/switch.client.js";
import type { AuthUser } from "../middleware/auth.js";

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

/** Every write client resolves plan-only unless a test says otherwise. */
function allWritesPlanOnly(): void {
  for (const fn of [
    switchClient.setVlanMembership,
    switchClient.enablePortPoe,
    switchClient.disablePortPoe,
    switchClient.enablePort,
    switchClient.disablePort,
    switchClient.createVlan,
    switchClient.deleteVlan,
    switchClient.setupCameraPorts,
    switchClient.provisionSwitch,
  ]) {
    vi.mocked(fn as (...a: never[]) => unknown).mockResolvedValue(PLANNED);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  allWritesPlanOnly();
  // Tier-2 default: the route mints a token and the confirm endpoint executes.
  evalMock.mockResolvedValue({
    allowed: false,
    requiresConfirmation: true,
    confirmationToken: "tok-123",
    reason: "requires confirmation",
    tier: 2,
  });
});

/** Confirm a token for `operation` with `params` and return the response. */
async function confirm(operation: string, params: Record<string, unknown> = {}) {
  confirmMock.mockResolvedValue({ confirmed: true, operation, params });
  return request(buildApp(owner))
    .post("/api/switch/command/confirm")
    .send({ confirmationToken: "tok-123" });
}

// ---------------------------------------------------------------------------
// FINDING 2 — the confirm endpoint is the PRIMARY execution path.
// ---------------------------------------------------------------------------

describe("POST /switch/command/confirm reports the write's real outcome", () => {
  const CASES: { operation: string; params: Record<string, unknown> }[] = [
    { operation: "switch_port_enable", params: { port: 3 } },
    { operation: "switch_port_disable", params: { port: 3 } },
    { operation: "switch_disable_protected_port", params: { port: 9 } },
    { operation: "switch_create_vlan", params: { vlan_id: 100, name: "cameras" } },
    { operation: "switch_delete_vlan", params: { vlan_id: 100 } },
    {
      operation: "switch_set_vlan_membership",
      params: { vlan_id: 100, ports: [{ port: 4, tagged: false, member: true }] },
    },
    { operation: "switch_poe_enable", params: { port: 3 } },
    { operation: "switch_poe_disable", params: { port: 3 } },
    {
      operation: "switch_setup_cameras",
      params: { vlan_id: 100, camera_ports: [1], uplink_ports: [9] },
    },
    { operation: "switch_provision", params: {} },
  ];

  for (const c of CASES) {
    it(`${c.operation}: a plan-only write confirms as planned, not ok`, async () => {
      const res = await confirm(c.operation, c.params);
      expect(res.status).toBe(200);
      // The bug: a hard-coded {status:"ok", confirmed:true} regardless of what
      // the service said. A staged-but-unapplied write must never read "ok".
      expect(res.body.status).toBe("planned");
      expect(res.body.dry_run).toBe(true);
      // …while still identifying the confirmed operation.
      expect(res.body.operation).toBe(c.operation);
      expect(res.body.confirmed).toBe(true);
    });
  }

  it("a live write still confirms as ok/applied", async () => {
    vi.mocked(switchClient.disablePortPoe).mockResolvedValue(APPLIED);
    const res = await confirm("switch_poe_disable", { port: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      dry_run: false,
      operation: "switch_poe_disable",
      confirmed: true,
    });
  });

  it("a client that returns no body still confirms as ok (older service build)", async () => {
    vi.mocked(switchClient.enablePort).mockResolvedValue(
      undefined as unknown as Awaited<ReturnType<typeof switchClient.enablePort>>,
    );
    const res = await confirm("switch_port_enable", { port: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", operation: "switch_port_enable", confirmed: true });
  });
});

// ---------------------------------------------------------------------------
// FINDING 2 — the three §7 write routes' own direct-execution branches.
// ---------------------------------------------------------------------------

describe("§7 write routes report the write's real outcome", () => {
  beforeEach(() => {
    // Tier-1/allowed: the route executes inline instead of minting a token.
    evalMock.mockResolvedValue({ allowed: true, tier: 1 });
  });

  it("POST /ports/:port/vlan surfaces planned/dry_run", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/ports/4/vlan").send({ vlan_id: 100 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "planned", dry_run: true, port: 4, vlan_id: 100 });
  });

  it("POST /ports/:port/poe surfaces planned/dry_run", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/ports/3/poe").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "planned", dry_run: true, port: 3, poe_enabled: false });
    expect(switchClient.disablePortPoe).toHaveBeenCalledWith(3);
  });

  it("POST /ports/:port/enable surfaces planned/dry_run", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/ports/3/enable").send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "planned", dry_run: true, port: 3, enabled: true });
  });

  it("POST /ports/:protected/enable {enabled:false} surfaces planned/dry_run", async () => {
    const res = await request(buildApp(owner)).post("/api/switch/ports/9/enable").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "planned", dry_run: true, port: 9, enabled: false });
    expect(switchClient.disablePort).toHaveBeenCalledWith(9);
  });

  it("a live §7 write still reports ok", async () => {
    vi.mocked(switchClient.enablePortPoe).mockResolvedValue(APPLIED);
    const res = await request(buildApp(owner)).post("/api/switch/ports/3/poe").send({ enabled: true });
    expect(res.body).toMatchObject({ status: "ok", dry_run: false, poe_enabled: true });
  });

  it("POST /ports/:port/poe relays the guard's refusal instead of a 500", async () => {
    // The §7 PoE guard refuses a cut that would darken a device with no remote
    // recovery. Its reason is the whole point — a generic 500 loses it.
    const refusal = new Error(
      "Refusing to cut PoE on port 2: it powers the access point",
    ) as Error & { status?: number };
    refusal.status = 409;
    vi.mocked(switchClient.disablePortPoe).mockRejectedValue(refusal);
    const res = await request(buildApp(owner)).post("/api/switch/ports/2/poe").send({ enabled: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("access point");
  });
});

// ---------------------------------------------------------------------------
// FINDING 1 — the live VLAN path must MERGE, and intent is declared, not
// inferred from the list's length.
// ---------------------------------------------------------------------------

describe("VLAN membership writes declare merge vs replace", () => {
  it("POST /ports/:port/vlan asks for a MERGE (it is an access move)", async () => {
    evalMock.mockResolvedValue({ allowed: true, tier: 1 });
    await request(buildApp(owner)).post("/api/switch/ports/4/vlan").send({ vlan_id: 100 });
    // Without the mode the switch service would REPLACE VLAN 100's member list
    // with just port 4 — wiping the uplink/AP/appliance on a flat LAN.
    expect(switchClient.setVlanMembership).toHaveBeenCalledWith(
      100,
      [{ port: 4, tagged: false, member: true }],
      "merge",
    );
  });

  it("POST /vlans/:id/membership defaults to merge and records it for the audit", async () => {
    const res = await request(buildApp(owner))
      .post("/api/switch/vlans/100/membership")
      .send({ ports: [{ port: 4, tagged: false, member: true }] });
    expect(res.status).toBe(202);
    // The recorded params drive the confirm-time execution, so the mode has to
    // be part of them — not re-guessed later.
    expect(evalMock.mock.calls[0][3]).toMatchObject({ vlan_id: 100, mode: "merge" });
  });

  it("POST /vlans/:id/membership honours an explicit replace", async () => {
    evalMock.mockResolvedValue({ allowed: true, tier: 1 });
    const ports = [
      { port: 4, tagged: false, member: true },
      { port: 9, tagged: true, member: true },
    ];
    await request(buildApp(owner))
      .post("/api/switch/vlans/100/membership")
      .send({ ports, mode: "replace" });
    expect(switchClient.setVlanMembership).toHaveBeenCalledWith(100, ports, "replace");
  });

  it("POST /vlans/:id/membership rejects an unknown mode", async () => {
    const res = await request(buildApp(owner))
      .post("/api/switch/vlans/100/membership")
      .send({ ports: [], mode: "clobber" });
    expect(res.status).toBe(400);
    expect(evalMock).not.toHaveBeenCalled();
    expect(switchClient.setVlanMembership).not.toHaveBeenCalled();
  });

  it("confirm replays the mode the token recorded", async () => {
    const ports = [{ port: 9, tagged: true, member: true }];
    await confirm("switch_set_vlan_membership", { vlan_id: 100, ports, mode: "replace" });
    expect(switchClient.setVlanMembership).toHaveBeenCalledWith(100, ports, "replace");
  });

  it("confirm falls back to merge for a token minted before mode existed", async () => {
    const ports = [{ port: 4, tagged: false, member: true }];
    await confirm("switch_set_vlan_membership", { vlan_id: 100, ports });
    expect(switchClient.setVlanMembership).toHaveBeenCalledWith(100, ports, "merge");
  });

  it("relays the service's refusal of a merge it cannot express", async () => {
    // merge only expresses access moves; the switch service 400s a tagged or
    // removal entry and names mode:"replace". That message has to reach the
    // caller (operator or agent) — a 500 tells them nothing.
    evalMock.mockResolvedValue({ allowed: true, tier: 1 });
    const refusal = new Error(
      "mode='merge' only accepts untagged member entries — send mode='replace' …",
    ) as Error & { status?: number };
    refusal.status = 400;
    vi.mocked(switchClient.setVlanMembership).mockRejectedValue(refusal);
    const res = await request(buildApp(owner))
      .post("/api/switch/vlans/100/membership")
      .send({ ports: [{ port: 9, tagged: true, member: true }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("mode='replace'");
  });
});
