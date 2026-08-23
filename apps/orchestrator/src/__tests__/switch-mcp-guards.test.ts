/**
 * WARP-1462 — MCP-principal admission on the switch routes the seven switch
 * LLM tools dispatch through (the WARP-1439 phantom-target class):
 *
 *   get_switch_ports   → GET  /api/switch/ports        (open read)
 *   get_switch_poe     → GET  /api/switch/poe          (open read)
 *   get_switch_vlans   → GET  /api/switch/vlans        (open read)
 *   detect_wan_port    → POST /api/switch/wan/detect   (Tier-1 read since
 *                        WARP-2125 — RBAC-guarded like the writes, but it
 *                        executes directly instead of minting a confirmation)
 *   set_port_poe       → POST /api/switch/poe/:port/enable|disable (Tier-2 write)
 *   set_port_vlan      → POST /api/switch/vlans/:id/membership     (Tier-2 write)
 *   setup_camera_ports → POST /api/switch/setup/cameras            (Tier-2 write)
 *
 * The tools present the `_service:mcp` principal (role "service"). Before this
 * fix they hit the switch service (:8081) directly with no bearer and 403'd;
 * now they hit these orchestrator proxies. The reads are open to every auth
 * role; the four write routes were plain requireRole("owner","admin") — which
 * 403s `_service:mcp` — so they were flipped to requireRoleOrMcpService. These
 * tests pin that the MCP principal reaches each route (non-401/403) while human
 * RBAC on the writes stays byte-identical (owner passes, guest/family 403).
 *
 * Scaffolding per cameras-mcp-guards.test.ts / network-mcp-guards.test.ts: real
 * auth guards, heavy services (switch client + aggregation + safety tier) mocked,
 * a req.user-injecting shim.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

// ── Config mock — hoisted above the route import so middleware/auth can build
//    its SERVICE_PRINCIPALS registry (SERVICE_TOKEN_MCP → _service:mcp). ──
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_MCP: "test-mcp-token-32chars-padding-1234a",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

// Stub the switch hardware client so the guard test never touches :8081. The
// write funcs resolve so an allowed path would 200; the 202-mint tests below
// assert they are NOT reached (the safety tier short-circuits before execution).
vi.mock("../services/switch.client.js", () => ({
  fetchPoeStatus: vi.fn().mockResolvedValue([]),
  detectWanPort: vi.fn().mockResolvedValue({ wan_port: 9 }),
  enablePortPoe: vi.fn().mockResolvedValue(undefined),
  disablePortPoe: vi.fn().mockResolvedValue(undefined),
  setVlanMembership: vi.fn().mockResolvedValue(undefined),
  setupCameraPorts: vi.fn().mockResolvedValue({ status: "ok" }),
  // Referenced by the confirm dispatcher (unused here, kept for import safety).
  enablePort: vi.fn(), disablePort: vi.fn(), createVlan: vi.fn(),
  deleteVlan: vi.fn(), enablePortPoeLegacy: vi.fn(), provisionSwitch: vi.fn(),
  fetchPort: vi.fn(), fetchVlanMembership: vi.fn(), fetchPortPoe: vi.fn(),
  fetchSystemInfo: vi.fn(),
}));

// §7 reads call the aggregation service; mock it so the test exercises the
// guard/route, not the join (covered in switch-aggregation.test).
vi.mock("../services/switch-aggregation.service.js", () => ({
  fetchSwitchStatus: vi.fn().mockResolvedValue({ connected: true }),
  fetchSwitchPorts: vi.fn().mockResolvedValue([]),
  fetchSwitchVlans: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn(),
  confirmNetworkCommand: vi.fn(),
}));

import { createSwitchRouter } from "../routes/switch.js";
import {
  detectWanPort,
  enablePortPoe,
  disablePortPoe,
  setVlanMembership,
  setupCameraPorts,
} from "../services/switch.client.js";
import { evaluateNetworkCommand } from "../services/network-safety.service.js";
import type { AuthUser } from "../middleware/auth.js";
import type { PrismaClient } from "@prisma/client";

const mockEvaluate = vi.mocked(evaluateNetworkCommand);
const mockDetectWan = vi.mocked(detectWanPort);
const mockEnablePoe = vi.mocked(enablePortPoe);
const mockDisablePoe = vi.mocked(disablePortPoe);
const mockSetVlan = vi.mocked(setVlanMembership);
const mockSetupCameras = vi.mocked(setupCameraPorts);

const mcpPrincipal: AuthUser = {
  id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service",
};
const voicePrincipal: AuthUser = {
  id: "_service:voice", username: "_service:voice", displayName: "Voice", role: "service",
};
const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };
const family: AuthUser = { id: "u-family", username: "alice", displayName: "alice", role: "family" };
const guest: AuthUser = { id: "u-guest", username: "guest", displayName: "guest", role: "guest" };

/** req.user-injecting shim; mounts the REAL switch router. */
function buildApp(user: AuthUser | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });
  // Cast: the router only touches prisma via the mocked network-safety service.
  app.use("/api", createSwitchRouter({} as unknown as PrismaClient));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Reads: open to every auth role, so the service principal reaches them ──

describe("switch read routes admit the MCP service principal (WARP-1462)", () => {
  const READS = ["/api/switch/ports", "/api/switch/poe", "/api/switch/vlans"];
  for (const path of READS) {
    it(`GET ${path} — _service:mcp reaches it (200)`, async () => {
      const res = await request(buildApp(mcpPrincipal)).get(path);
      expect(res.status).toBe(200);
    });
  }
});

// ── Writes: the four write tools' routes, flipped to requireRoleOrMcpService ──

/** Each write route × its tool + the switch-client fn that must NOT run on a 202 mint. */
const WRITES: {
  label: string;
  method: "post";
  path: string;
  body?: unknown;
  downstream: unknown;
}[] = [
  { label: "set_port_poe → POST /api/switch/poe/3/enable", method: "post", path: "/api/switch/poe/3/enable", downstream: mockEnablePoe },
  { label: "set_port_poe → POST /api/switch/poe/3/disable", method: "post", path: "/api/switch/poe/3/disable", downstream: mockDisablePoe },
  {
    label: "set_port_vlan → POST /api/switch/vlans/100/membership",
    method: "post", path: "/api/switch/vlans/100/membership",
    body: { ports: [{ port: 1, tagged: false, member: true }] }, downstream: mockSetVlan,
  },
  {
    label: "setup_camera_ports → POST /api/switch/setup/cameras",
    method: "post", path: "/api/switch/setup/cameras",
    body: { vlan_id: 100, camera_ports: [1], uplink_ports: [9] }, downstream: mockSetupCameras,
  },
];

describe("switch write routes admit the MCP principal, reaching the Tier-2 safety layer (WARP-1462)", () => {
  for (const w of WRITES) {
    it(`${w.label}: _service:mcp gets the 202 mint, never executes`, async () => {
      mockEvaluate.mockResolvedValue({
        requiresConfirmation: true, confirmationToken: "tok-mcp", reason: "tier2", tier: 2,
      } as never);
      const res = await request(buildApp(mcpPrincipal))[w.method](w.path).send(w.body ?? {});

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ status: "confirmation_required", confirmationToken: "tok-mcp" });
      // Guard admitted the principal → the safety tier ran, but the hardware
      // write is gated behind the confirmation and must not have executed.
      expect(w.downstream).not.toHaveBeenCalled();
      expect(mockEvaluate).toHaveBeenCalledOnce();
    });
  }
});

// WARP-2125: detection is a Tier-1 read (pure — returns {wan_port, confidence,
// reason}, writes nothing), so unlike the WRITES above the allowed path
// executes directly: no 202, no token. The safety tier still runs (RBAC +
// audit), which is what admission means for this route now.
describe("detect_wan_port is Tier 1: the MCP principal reaches the safety layer and detection executes (WARP-1462/WARP-2125)", () => {
  it("detect_wan_port → POST /api/switch/wan/detect: _service:mcp gets the detection body, no mint", async () => {
    mockEvaluate.mockResolvedValue({ allowed: true, tier: 1 } as never);
    const res = await request(buildApp(mcpPrincipal)).post("/api/switch/wan/detect").send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ wan_port: 9 });
    expect(res.body.confirmationToken).toBeUndefined();
    expect(mockDetectWan).toHaveBeenCalledOnce();
    expect(mockEvaluate).toHaveBeenCalledOnce();
  });
});

/**
 * The detect route rides the same human-RBAC loop as the writes: Tier 1
 * changed WHAT an allowed call does (execute vs mint), not WHO may call it.
 */
const MCP_GUARDED = [
  ...WRITES,
  { label: "detect_wan_port → POST /api/switch/wan/detect", method: "post" as const, path: "/api/switch/wan/detect", downstream: mockDetectWan },
];

describe("switch write routes keep human RBAC unchanged (WARP-1462)", () => {
  for (const w of MCP_GUARDED) {
    it(`${w.label}: owner reaches the safety tier (not 403)`, async () => {
      mockEvaluate.mockResolvedValue({
        requiresConfirmation: true, confirmationToken: "tok-owner", reason: "tier2", tier: 2,
      } as never);
      const res = await request(buildApp(owner))[w.method](w.path).send(w.body ?? {});
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
    });

    it(`${w.label}: guest → 403 (guard rejects before the safety tier)`, async () => {
      const res = await request(buildApp(guest))[w.method](w.path).send(w.body ?? {});
      expect(res.status).toBe(403);
      expect(mockEvaluate).not.toHaveBeenCalled();
    });

    it(`${w.label}: family → 403`, async () => {
      const res = await request(buildApp(family))[w.method](w.path).send(w.body ?? {});
      expect(res.status).toBe(403);
    });

    it(`${w.label}: other service principals (voice) stay 403`, async () => {
      const res = await request(buildApp(voicePrincipal))[w.method](w.path).send(w.body ?? {});
      expect(res.status).toBe(403);
    });
  }
});
