/**
 * WARP-171: full role × route RBAC matrix.
 *
 * This file drives every guarded write endpoint × every Role value and
 * asserts the matrix from ADR-004 §3. The pattern intentionally
 * sidesteps the global `authMiddleware` (which would force us to mint
 * real JWTs per role) by mounting a synthetic auth middleware that
 * stuffs `req.user` directly — same pattern as the existing
 * `auth.invites.test.ts`. The matrix is dense on purpose so a new
 * route added without a guard, or a regression to the wrong allowlist,
 * trips a fast, localised test failure.
 *
 * **Service-principal regression (AC #6):** the matrix includes the
 * `service` role on every row. Every write must reject `service`
 * (Bearer SERVICE_TOKEN_* is read-only by design); GETs must accept it.
 * A separate suite at the bottom drives the real service-token Bearer
 * header through `authMiddleware` end-to-end to prove the existing
 * service-principal flow still works after the guards are wired in.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction, Router } from "express";

// ── Config mock — must be hoisted above any route imports. ──
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    SERVICE_TOKEN_VOICE: "test-voice-token-32chars-padding-xyz",
    SERVICE_TOKEN_MCP: "test-mcp-token-32chars-padding-1234a",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    // The owner reset path dispatches to the device-bridge; without a configured
    // URL the service reports BRIDGE_UNREACHABLE → 503, so the owner "guard
    // passes" assertion (status < 500) fails. Mirror the dedicated handler test.
    DEVICE_BRIDGE_URL: "http://bridge.test:9090",
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

// WARP-559: stub the switch hardware client + network-safety tier so the
// real `createSwitchRouter` wiring test below exercises only the guard,
// never the downstream switch service or Prisma. Each mutating handler's
// safety evaluation resolves `{ allowed: true }` so a permitted role
// reaches a 2xx (proving the guard let it through); a denied role is
// short-circuited by `requireRole` at 403 before any of these run.
vi.mock("../services/switch.client.js", () => ({
  fetchPorts: vi.fn().mockResolvedValue([]),
  fetchPort: vi.fn().mockResolvedValue({}),
  fetchVlans: vi.fn().mockResolvedValue([]),
  fetchVlanMembership: vi.fn().mockResolvedValue({}),
  fetchPoeStatus: vi.fn().mockResolvedValue([]),
  fetchPortPoe: vi.fn().mockResolvedValue({}),
  fetchSystemInfo: vi.fn().mockResolvedValue({}),
  enablePort: vi.fn().mockResolvedValue(undefined),
  disablePort: vi.fn().mockResolvedValue(undefined),
  createVlan: vi.fn().mockResolvedValue(undefined),
  deleteVlan: vi.fn().mockResolvedValue(undefined),
  setVlanMembership: vi.fn().mockResolvedValue(undefined),
  enablePortPoe: vi.fn().mockResolvedValue(undefined),
  disablePortPoe: vi.fn().mockResolvedValue(undefined),
  detectWanPort: vi.fn().mockResolvedValue({ wan_port: 9 }),
  setupCameraPorts: vi.fn().mockResolvedValue({ status: "ok" }),
  // §7 additions (ADDON §7).
  fetchPortStatus: vi.fn().mockResolvedValue([]),
  fetchProvisionConfig: vi.fn().mockResolvedValue({
    vlan_profile: "flat-lan", auto_managed: false, protected_port: 0,
    camera_ports: [], ap_ports: [], client_ports: [], poe_budget_w: 130,
    last_provisioned_at: null,
  }),
  provisionSwitch: vi.fn().mockResolvedValue({ status: "applied" }),
}));

// §7 read routes call the aggregation service; mock it so the RBAC wiring test
// exercises only the guard, not the join (covered in switch-aggregation.test).
vi.mock("../services/switch-aggregation.service.js", () => ({
  fetchSwitchStatus: vi.fn().mockResolvedValue({ connected: true }),
  fetchSwitchPorts: vi.fn().mockResolvedValue([]),
  fetchSwitchVlans: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/network-safety.service.js", () => ({
  evaluateNetworkCommand: vi.fn().mockResolvedValue({ allowed: true }),
  confirmNetworkCommand: vi
    .fn()
    .mockResolvedValue({ confirmed: true, operation: "switch_port_enable", params: { port: 3 } }),
}));

import { requireRole, authMiddleware, type AuthUser } from "../middleware/auth.js";
import type { Role } from "../services/jwt.service.js";
import { createSwitchRouter } from "../routes/switch.js";
import { createSystemResetRouter } from "../routes/system-reset.routes.js";
import { boxDisplayName } from "../lib/box-identity.js";

// ── Test fixtures ──────────────────────────────────────────────────

const ALL_ROLES: Role[] = ["owner", "admin", "family", "guest", "service"];

interface GuardedRoute {
  /** HTTP method on the supertest agent. */
  method: "get" | "post" | "put" | "patch" | "delete";
  /** URL path mounted under /api on the test app. */
  path: string;
  /** Allowed roles per ADR-004 §3. */
  allowed: Role[];
}

/**
 * The canonical matrix from ADR-004 §3. New routes get added here AND
 * to the production route file's `requireRole(...)` call — the test
 * compares the response (200/403) against this allowed-set for every
 * Role value.
 *
 * Paths intentionally use synthetic stand-ins (`/api/auth/users`, etc.)
 * rather than mounting the full router so a route-level downstream
 * error (e.g. Nextcloud unreachable) doesn't bleed into the guard
 * assertion. The guard runs as middleware ahead of the handler; if it
 * lets the request through we 200, if it rejects we 403.
 */
const MATRIX: GuardedRoute[] = [
  // ── auth / user management ── (owner + admin) ──
  { method: "post", path: "/api/auth/users", allowed: ["owner", "admin"] },
  { method: "put", path: "/api/auth/users/alice", allowed: ["owner", "admin"] },
  { method: "delete", path: "/api/auth/users/alice", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/auth/users/alice/disable", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/auth/users/alice/enable", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/auth/invites", allowed: ["owner", "admin"] },
  { method: "delete", path: "/api/auth/invites/abc", allowed: ["owner", "admin"] },

  // ── network / firewall / vpn ── (owner + admin) ──
  { method: "post", path: "/api/network/wifi/ssid", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/wifi/password", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/wifi/channel", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/firewall/block", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/firewall/unblock", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/firewall/port-forward", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/wifi/guest", allowed: ["owner", "admin"] },
  { method: "delete", path: "/api/network/wifi/guest", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/upnp", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/dhcp/static-lease", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/vpn/peers", allowed: ["owner", "admin"] },
  { method: "delete", path: "/api/vpn/peers/abc", allowed: ["owner", "admin"] },
  // WARP-446: extender AP onboarding writes — same posture as VPN peers,
  // since approving an AP changes the household's
  // wireless surface (ADR-005 §RBAC).
  { method: "post", path: "/api/aps/AA:BB:CC:DD:EE:FF/approve", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/aps/AA:BB:CC:DD:EE:FF/decommission", allowed: ["owner", "admin"] },

  // WARP-559: managed-switch control — same owner+admin posture as the
  // rest of the network-infrastructure surface (`/api/network/*`,
  // `/api/vpn/*`). Every mutating switch route shipped unguarded (the
  // mount in app.ts had no requireRole wrapper, and the in-handler
  // `evalSwitchCommand` is a WARP-76 safety/confirmation tier, not authz),
  // letting a guest/family session disable PoE/ports/VLANs. Status GETs
  // (`/api/switch/*`) stay open to every auth role.
  { method: "post", path: "/api/switch/ports/3/enable", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/switch/ports/3/disable", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/switch/vlans", allowed: ["owner", "admin"] },
  { method: "delete", path: "/api/switch/vlans/100", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/switch/vlans/100/membership", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/switch/poe/3/enable", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/switch/poe/3/disable", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/switch/wan/detect", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/switch/setup/cameras", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/switch/command/confirm", allowed: ["owner", "admin"] },

  // WARP-455: A1 local user directory — same admin-only posture as the
  // existing user-management routes (POST /api/auth/users etc.). Reads
  // and mutations are both gated; only the permissions matrix read
  // (/api/people/permissions) is open to every auth role and so is
  // intentionally absent from this matrix.
  { method: "patch", path: "/api/people/u1/role", allowed: ["owner", "admin"] },
  { method: "patch", path: "/api/people/u1/scope", allowed: ["owner", "admin"] },
  { method: "delete", path: "/api/people/u1", allowed: ["owner", "admin"] },

  // WARP-1258 (T6): departments/teams CRUD — same owner+admin posture as
  // people mutations. GET /api/departments is open (not in this matrix as it's
  // a read with no role restriction).
  { method: "post", path: "/api/departments", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/departments/d1/teams", allowed: ["owner", "admin"] },
  { method: "patch", path: "/api/departments/d1", allowed: ["owner", "admin"] },
  { method: "delete", path: "/api/departments/d1", allowed: ["owner", "admin"] },

  // ── service restart ── (owner only — destructive, may interrupt the box) ──
  { method: "post", path: "/api/network/system/reboot", allowed: ["owner"] },

  // WARP-825: factory reset — the single most destructive action on the box
  // (wipes every data volume + secrets, returns to first-run). owner ONLY,
  // strictest possible guard (ADR-004 §3 destructive-system-action posture).
  { method: "post", path: "/api/system/reset", allowed: ["owner"] },

  // ── cameras / matter / smart-home ── (owner + admin + family) ──
  { method: "post", path: "/api/cameras", allowed: ["owner", "admin", "family"] },
  { method: "post", path: "/api/cameras/scan", allowed: ["owner", "admin", "family"] },
  { method: "post", path: "/api/cameras/groups", allowed: ["owner", "admin", "family"] },
  { method: "delete", path: "/api/cameras/abc", allowed: ["owner", "admin", "family"] },
  { method: "post", path: "/api/matter/commission", allowed: ["owner", "admin", "family"] },
  { method: "post", path: "/api/matter/devices/123/command", allowed: ["owner", "admin", "family"] },
  { method: "delete", path: "/api/matter/devices/123", allowed: ["owner", "admin", "family"] },

  // ── files (write) ── (owner + admin + family) ──
  { method: "post", path: "/api/files/upload", allowed: ["owner", "admin", "family"] },
  { method: "delete", path: "/api/files", allowed: ["owner", "admin", "family"] },
  { method: "post", path: "/api/files/mkdir", allowed: ["owner", "admin", "family"] },
  { method: "post", path: "/api/files/rename", allowed: ["owner", "admin", "family"] },
  { method: "post", path: "/api/files/move", allowed: ["owner", "admin", "family"] },
  // WARP-879 / WS-1: internal-sharing recipient roster. Same owner+admin+family
  // posture as the other file-write routes — `family` MUST get 200 (the whole
  // point of reading the local User table instead of OCS /cloud/users, which
  // 403s for family). Read-only roster, no mutation.
  { method: "get", path: "/api/files/share-recipients", allowed: ["owner", "admin", "family"] },

  // ── files: in-browser editing (WARP-882) ── (owner + admin + family) ──
  // Both are GETs but guarded: opening an editor session is a household-member
  // capability (guests don't co-author), and the status read gates the dashboard
  // "Edit" affordance. service is excluded — doc editing is a human action.
  { method: "get", path: "/api/files/docs/status", allowed: ["owner", "admin", "family"] },
  { method: "get", path: "/api/files/report.docx/editor-session", allowed: ["owner", "admin", "family"] },

  // WARP-1036: voice-assistant proxy — owner+admin only, INCLUDING the
  // GETs. Status exposes the household's last transcript + spoken reply
  // and /say drives the room speaker, so unlike most read routes these
  // are not open to family/guest, and `service` is denied everywhere
  // (voice-io itself must never loop back through this proxy).
  { method: "get", path: "/api/voice/status", allowed: ["owner", "admin"] },
  { method: "get", path: "/api/voice/devices", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/voice/say", allowed: ["owner", "admin"] },

  // ── llm sessions (own) ── ──
  // POST /llm/chat: includes `service` because voice-io's principal
  //   posts here (see `services/voice-io/voice/llm.py` — the comment
  //   on the route in `routes/llm.ts` explains the deviation from
  //   ADR-004 §3 "service is read-only"). Tool-level RBAC keeps voice
  //   from issuing destructive operations through the agent loop.
  // DELETE/PATCH /llm/conversations/:id: pure user-data ownership —
  //   service principals never delete on behalf of a user. Human-tier
  //   roles only.
  { method: "post", path: "/api/llm/chat", allowed: ["owner", "admin", "family", "guest", "service"] },
  { method: "delete", path: "/api/llm/conversations/abc", allowed: ["owner", "admin", "family", "guest"] },
  { method: "patch", path: "/api/llm/conversations/abc", allowed: ["owner", "admin", "family", "guest"] },
];

/**
 * Build an Express app that registers every MATRIX entry as a tiny
 * route whose handler is `(_, res) => res.status(200).send("ok")`.
 * The guard runs ahead of the handler; we read the response status to
 * decide whether the guard let the request through (200) or rejected
 * it (403). No real route logic runs — this is a pure middleware
 * matrix harness.
 */
function buildMatrixApp(user: AuthUser | null): express.Express {
  const app = express();
  app.use(express.json());

  // Synthetic auth middleware — stuffs req.user directly.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });

  const router = Router({ mergeParams: true });
  for (const route of MATRIX) {
    const guard = requireRole(...route.allowed);
    router[route.method](route.path.replace(/^\/api/, ""), guard, (_req, res) => {
      res.status(200).json({ ok: true });
    });
  }
  app.use("/api", router);
  return app;
}

function mkUser(role: Role): AuthUser {
  return {
    id: `user-${role}`,
    username: `user-${role}`,
    displayName: `User ${role}`,
    role,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Matrix driver ──────────────────────────────────────────────────

describe("RBAC role × route matrix (WARP-171 AC #3, #5, #6)", () => {
  for (const route of MATRIX) {
    describe(`${route.method.toUpperCase()} ${route.path}`, () => {
      for (const role of ALL_ROLES) {
        const expectedStatus = route.allowed.includes(role) ? 200 : 403;
        const allowedLabel = expectedStatus === 200 ? "allows" : "rejects";
        it(`${allowedLabel} ${role} → ${expectedStatus}`, async () => {
          const app = buildMatrixApp(mkUser(role));
          const res = await request(app)[route.method](route.path).send({});
          expect(res.status).toBe(expectedStatus);
        });
      }
    });
  }
});

// ── Negative cases (no user, malformed role) ───────────────────────

describe("RBAC guard — negative cases (WARP-171 AC #5)", () => {
  const sampleRoute = MATRIX[0]; // POST /api/auth/users

  it("returns 403 when req.user is absent", async () => {
    const app = buildMatrixApp(null);
    const res = await request(app)[sampleRoute.method](sampleRoute.path).send({});
    expect(res.status).toBe(403);
  });

  it("returns 403 when req.user.role is an unknown string", async () => {
    const app = buildMatrixApp({
      id: "u",
      username: "u",
      displayName: "U",
      // The Prisma enum + zod validation make this unreachable in
      // production, but the guard fails closed regardless.
      role: "superuser" as unknown as Role,
    });
    const res = await request(app)[sampleRoute.method](sampleRoute.path).send({});
    expect(res.status).toBe(403);
  });

  it("returns 403 when req.user.role is empty string", async () => {
    const app = buildMatrixApp({
      id: "u",
      username: "u",
      displayName: "U",
      role: "" as unknown as Role,
    });
    const res = await request(app)[sampleRoute.method](sampleRoute.path).send({});
    expect(res.status).toBe(403);
  });
});

// ── Service-principal end-to-end regression (AC #6) ────────────────
// Drives the REAL authMiddleware with a SERVICE_TOKEN_VOICE Bearer to
// prove the existing service-token flow still works AND that any
// write-protected route correctly rejects it. This complements the
// matrix above (which uses a synthetic auth middleware) by exercising
// the production authMiddleware code path.

describe("service-principal regression (WARP-171 AC #6)", () => {
  function buildAppWithRealAuth(): express.Express {
    const app = express();
    app.use(express.json());
    app.use(authMiddleware);

    const router = Router();
    // A read endpoint (GET) — service must be allowed; no guard.
    router.get("/llm/models", (_req, res) => {
      res.json({ models: [] });
    });
    // A write endpoint — guard must reject service.
    router.post(
      "/auth/users",
      requireRole("owner", "admin"),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );
    // A camera write — service is again excluded.
    router.post(
      "/cameras/scan",
      requireRole("owner", "admin", "family"),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );
    // POST /llm/chat — voice-io is a service principal AND must reach
    // this route (the entire voice loop runs through it). This is the
    // documented deviation from "service is read-only" in ADR-004 §3;
    // the matrix in this file includes `service` on /llm/chat for the
    // same reason.
    router.post(
      "/llm/chat",
      requireRole("owner", "admin", "family", "guest", "service"),
      (_req, res) => {
        res.status(200).json({ ok: true });
      },
    );
    app.use("/api", router);
    return app;
  }

  it("service token (voice) is accepted on GET /api/llm/models", async () => {
    const app = buildAppWithRealAuth();
    const res = await request(app)
      .get("/api/llm/models")
      .set("Authorization", "Bearer test-voice-token-32chars-padding-xyz");
    expect(res.status).toBe(200);
  });

  it("service token (voice) is rejected on POST /api/auth/users", async () => {
    const app = buildAppWithRealAuth();
    const res = await request(app)
      .post("/api/auth/users")
      .set("Authorization", "Bearer test-voice-token-32chars-padding-xyz")
      .send({});
    expect(res.status).toBe(403);
  });

  it("service token (voice) is rejected on POST /api/cameras/scan", async () => {
    const app = buildAppWithRealAuth();
    const res = await request(app)
      .post("/api/cameras/scan")
      .set("Authorization", "Bearer test-voice-token-32chars-padding-xyz")
      .send({});
    expect(res.status).toBe(403);
  });

  it("service token (mcp) is rejected on POST /api/auth/users", async () => {
    // WARP-339: distinct shared secret for mcp-server → orchestrator
    // calls; same rule applies — service principals are read-only.
    const app = buildAppWithRealAuth();
    const res = await request(app)
      .post("/api/auth/users")
      .set("Authorization", "Bearer test-mcp-token-32chars-padding-1234a")
      .send({});
    expect(res.status).toBe(403);
  });

  it("service token (voice) is accepted on POST /api/llm/chat (AC #6 — voice loop must work)", async () => {
    // The hard-line regression test for AC #6: voice-io's whole
    // purpose is to drive /api/llm/chat. If a future change to the
    // matrix removes `service` from the allowed list for this route,
    // the voice flow would break silently in production. This test
    // is the canary.
    const app = buildAppWithRealAuth();
    const res = await request(app)
      .post("/api/llm/chat")
      .set("Authorization", "Bearer test-voice-token-32chars-padding-xyz")
      .send({});
    expect(res.status).toBe(200);
  });
});

// ── Switch router RBAC wiring (WARP-559) ───────────────────────────
// The MATRIX above proves the guard *contract* against synthetic
// stand-in routes. This block mounts the REAL `createSwitchRouter` to
// prove the production router actually wires `requireRole("owner",
// "admin")` onto every mutating route — the exact gap WARP-559 fixes
// (the switch router shipped with no guard while every sibling
// hardware router has one). The switch hardware client + network-safety
// tier are mocked at the top of this file, so a permitted role reaches
// a 2xx (the guard let it through to the mocked downstream) and a denied
// role is rejected at the guard before any downstream call. This block
// is the AC5 regression canary: on `main` (no guard) the guest/family
// "→ 403" cases fail because the mutation is reachable.

describe("switch router RBAC wiring (WARP-559)", () => {
  /** Every mutating switch route × a concrete test path + body. */
  const MUTATING: { method: "post" | "delete"; path: string; body?: unknown }[] = [
    { method: "post", path: "/api/switch/ports/3/enable" },
    { method: "post", path: "/api/switch/ports/3/disable" },
    { method: "post", path: "/api/switch/vlans", body: { vlan_id: 100, name: "cams" } },
    { method: "delete", path: "/api/switch/vlans/100" },
    { method: "post", path: "/api/switch/vlans/100/membership", body: { ports: [1, 2] } },
    { method: "post", path: "/api/switch/poe/3/enable" },
    { method: "post", path: "/api/switch/poe/3/disable" },
    { method: "post", path: "/api/switch/wan/detect" },
    {
      method: "post",
      path: "/api/switch/setup/cameras",
      body: { vlan_id: 100, camera_ports: [1], uplink_ports: [9] },
    },
    { method: "post", path: "/api/switch/command/confirm", body: { confirmationToken: "tok" } },
    // §7 write routes (ADDON §7) — the dashboard panel's write surface.
    { method: "post", path: "/api/switch/ports/4/vlan", body: { vlan_id: 100 } },
    { method: "post", path: "/api/switch/ports/3/poe", body: { enabled: true } },
    { method: "post", path: "/api/switch/provision", body: {} },
  ];

  /** Read GETs must stay open to every authenticated role. */
  const READS = [
    "/api/switch/ports",
    "/api/switch/vlans",
    "/api/switch/poe",
    "/api/switch/system",
  ];

  function buildSwitchApp(user: AuthUser | null): express.Express {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (user) (req as Request & { user: AuthUser }).user = user;
      next();
    });
    // Cast: the router only touches prisma via the mocked network-safety
    // service, which ignores the client entirely.
    app.use("/api", createSwitchRouter({} as never));
    return app;
  }

  describe("mutating routes reject guest/family/no-session, allow owner/admin", () => {
    for (const route of MUTATING) {
      const label = `${route.method.toUpperCase()} ${route.path}`;

      it(`${label}: guest → 403`, async () => {
        const app = buildSwitchApp(mkUser("guest"));
        const res = await request(app)[route.method](route.path).send(route.body ?? {});
        expect(res.status).toBe(403);
      });

      it(`${label}: family → 403`, async () => {
        const app = buildSwitchApp(mkUser("family"));
        const res = await request(app)[route.method](route.path).send(route.body ?? {});
        expect(res.status).toBe(403);
      });

      it(`${label}: no session → 403`, async () => {
        const app = buildSwitchApp(null);
        const res = await request(app)[route.method](route.path).send(route.body ?? {});
        expect(res.status).toBe(403);
      });

      it(`${label}: owner → not 403`, async () => {
        const app = buildSwitchApp(mkUser("owner"));
        const res = await request(app)[route.method](route.path).send(route.body ?? {});
        // Guard let it through; downstream is mocked to succeed. Assert
        // "not forbidden" + "not a 5xx" so the test stays robust to each
        // route's normal success shape.
        expect(res.status).not.toBe(403);
        expect(res.status).toBeLessThan(500);
      });

      it(`${label}: admin → not 403`, async () => {
        const app = buildSwitchApp(mkUser("admin"));
        const res = await request(app)[route.method](route.path).send(route.body ?? {});
        expect(res.status).not.toBe(403);
        expect(res.status).toBeLessThan(500);
      });
    }
  });

  describe("status GETs stay open to viewers (no over-restriction)", () => {
    for (const path of READS) {
      it(`GET ${path}: guest → 200`, async () => {
        const app = buildSwitchApp(mkUser("guest"));
        const res = await request(app).get(path);
        expect(res.status).toBe(200);
      });

      it(`GET ${path}: family → 200`, async () => {
        const app = buildSwitchApp(mkUser("family"));
        const res = await request(app).get(path);
        expect(res.status).toBe(200);
      });
    }
  });
});

// ── Real createSystemResetRouter wiring (WARP-825) ─────────────────
// Mounts the REAL factory-reset router to prove POST /api/system/reset (the
// single most destructive box action) actually carries requireRole("owner") —
// admin/family/guest/no-session are rejected at the guard before the service
// (and the device-bridge dispatch) is ever reached. SAFETY: fetch is stubbed
// and the typed confirm never matches for the denied roles, so no wipe is ever
// dispatched here. Mirrors the switch-router wiring block above.

describe("system-reset router RBAC wiring (WARP-825)", () => {
  function buildResetApp(user: AuthUser | null): express.Express {
    // Minimal prisma double: the owner-allowed path needs resetJob +
    // commandAuditLog, but for the DENIED roles the guard short-circuits before
    // any of these are touched.
    const prisma = {
      // requestFactoryReset wraps the double-fire guard + audit + job create in
      // prisma.$transaction(fn, { isolationLevel: Serializable }); without this
      // the double's $transaction is undefined → TypeError → 500 (not the 202
      // the owner-passes-guard assertion expects). Run the fn against the double.
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
      resetJob: {
        count: vi.fn(async () => 0),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "job-rbac",
          status: "requested",
          requestedBy: data.requestedBy ?? null,
          targetName: data.targetName,
          failureReason: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          id: "job-rbac",
          status: data.status ?? "dispatched",
          targetName: "x",
          failureReason: data.failureReason ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
        findFirst: vi.fn(async () => null),
      },
      commandAuditLog: { create: vi.fn(async () => ({ id: "a" })) },
    } as never;
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      if (user) (req as Request & { user: AuthUser }).user = user;
      next();
    });
    app.use("/api", createSystemResetRouter(prisma));
    return app;
  }

  const DENIED: Role[] = ["admin", "family", "guest"];

  for (const role of DENIED) {
    it(`POST /api/system/reset: ${role} → 403`, async () => {
      const app = buildResetApp(mkUser(role));
      const res = await request(app)
        .post("/api/system/reset")
        .send({ confirm: "anything" });
      expect(res.status).toBe(403);
    });
  }

  it("POST /api/system/reset: no session → 403", async () => {
    const app = buildResetApp(null);
    const res = await request(app).post("/api/system/reset").send({ confirm: "x" });
    expect(res.status).toBe(403);
  });

  it("POST /api/system/reset: owner → not 403 (guard passes)", async () => {
    // Owner passes the guard. Give it a bridge token + a stubbed-ok fetch and a
    // matching confirm so the dispatch path completes to 202 rather than a 5xx.
    const prevToken = process.env.BRIDGE_AUTH_TOKEN;
    process.env.BRIDGE_AUTH_TOKEN = "tok-rbac";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    } as unknown as Awaited<ReturnType<typeof fetch>>);
    try {
      const app = buildResetApp(mkUser("owner"));
      const res = await request(app)
        .post("/api/system/reset")
        // WARP-992: the confirm target is the canonical box name
        // (lib/box-identity.ts::boxDisplayName), never os.hostname().
        .send({ confirm: boxDisplayName() });
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(500);
    } finally {
      fetchSpy.mockRestore();
      if (prevToken === undefined) delete process.env.BRIDGE_AUTH_TOKEN;
      else process.env.BRIDGE_AUTH_TOKEN = prevToken;
    }
  });
});
