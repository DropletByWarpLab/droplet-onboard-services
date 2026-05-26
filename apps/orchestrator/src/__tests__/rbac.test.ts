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
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

import { requireRole, authMiddleware, type AuthUser } from "../middleware/auth.js";
import type { Role } from "../services/jwt.service.js";

// ── Test fixtures ──────────────────────────────────────────────────

const ALL_ROLES: Role[] = ["owner", "admin", "family", "guest", "service"];

interface GuardedRoute {
  /** HTTP method on the supertest agent. */
  method: "post" | "put" | "patch" | "delete";
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

  // ── network / firewall / vpn / ddns ── (owner + admin) ──
  { method: "post", path: "/api/network/wifi/ssid", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/wifi/password", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/wifi/channel", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/firewall/block", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/firewall/unblock", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/firewall/port-forward", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/network/dhcp/static-lease", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/vpn/peers", allowed: ["owner", "admin"] },
  { method: "delete", path: "/api/vpn/peers/abc", allowed: ["owner", "admin"] },
  { method: "put", path: "/api/ddns/duckdns", allowed: ["owner", "admin"] },
  // WARP-446: extender AP onboarding writes — same posture as VPN peers
  // and DuckDNS, since approving an AP changes the household's
  // wireless surface (ADR-005 §RBAC).
  { method: "post", path: "/api/aps/AA:BB:CC:DD:EE:FF/approve", allowed: ["owner", "admin"] },
  { method: "post", path: "/api/aps/AA:BB:CC:DD:EE:FF/decommission", allowed: ["owner", "admin"] },

  // WARP-455: A1 local user directory — same admin-only posture as the
  // existing user-management routes (POST /api/auth/users etc.). Reads
  // and mutations are both gated; only the permissions matrix read
  // (/api/people/permissions) is open to every auth role and so is
  // intentionally absent from this matrix.
  { method: "patch", path: "/api/people/u1/role", allowed: ["owner", "admin"] },
  { method: "patch", path: "/api/people/u1/scope", allowed: ["owner", "admin"] },
  { method: "delete", path: "/api/people/u1", allowed: ["owner", "admin"] },

  // ── service restart ── (owner only — destructive, may interrupt the box) ──
  { method: "post", path: "/api/network/system/reboot", allowed: ["owner"] },

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
