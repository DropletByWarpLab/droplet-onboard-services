/**
 * WARP-824 — post-auth forced-password-change gate.
 *
 * `requirePasswordChangeGate(prisma)` mounts AFTER `authMiddleware` and
 * BEFORE every protected router. For an authenticated human session it reads
 * the EXPLICIT `User.mustChangePassword` flag FRESH from the row (keyed by the
 * `req.user.id` UUID) and, when set, fails every protected route with 403
 * `PASSWORD_CHANGE_REQUIRED` — EXCEPT a small allowlist (change-password
 * itself, /auth/me, /auth/logout) so the user can see who they are, change
 * their password, or sign out.
 *
 * This is the SERVER enforcement of AC #3: it does not depend on the client
 * honouring a redirect. The flag is read from the DB, not the JWT, so a stale
 * or forged token can't bypass it.
 *
 * Service principals and the AUTH_ENABLED=false dev bypass are never gated
 * (they have no directory row / are not human first-login flows).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { requirePasswordChangeGate } from "../middleware/auth.js";

interface UserRow {
  id: string;
  mustChangePassword: boolean;
}

function createPrismaMock(users: UserRow[]) {
  const rows = [...users];
  const self: any = {};
  self.user = {
    findUnique: vi.fn(async ({ where, select }: any) => {
      const row = rows.find((u) => u.id === where.id) ?? null;
      if (!row) return null;
      // honour `select` so the gate can fetch only what it needs
      if (select) {
        const out: any = {};
        for (const k of Object.keys(select)) out[k] = (row as any)[k];
        return out;
      }
      return row;
    }),
  };
  self._findUnique = self.user.findUnique;
  return self;
}

/**
 * Mount the gate behind a synthetic `req.user` (simulating the upstream
 * authMiddleware having populated the session), then a catch-all that 200s so
 * a passing request is observable.
 */
function buildApp(
  prismaMock: any,
  sessionUser: any,
  opts: { mountPath?: string } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (sessionUser) (req as any).user = sessionUser;
    next();
  });
  app.use(requirePasswordChangeGate(prismaMock));
  // Stand-in protected surfaces.
  app.get("/api/llm/models", (_req, res) => res.json({ ok: "models" }));
  app.post("/api/files/upload", (_req, res) => res.json({ ok: "upload" }));
  app.post("/api/auth/change-password", (_req, res) => res.json({ ok: "changed" }));
  app.get("/api/auth/me", (_req, res) => res.json({ ok: "me" }));
  app.post("/api/auth/logout", (_req, res) => res.json({ ok: "logout" }));
  // A passkey-REGISTRATION route is itself a protected surface (it mounts
  // after authMiddleware, behind this gate). A gated user must NOT be able to
  // enrol a passkey to escape the forced change.
  app.post("/api/webauthn/register/options", (_req, res) => res.json({ ok: "passkey-options" }));
  // The refresh route keeps the (still-gated) session alive without bypassing.
  app.post("/api/auth/refresh", (_req, res) => res.json({ ok: "refresh" }));
  return app;
}

const gatedUser = { id: "u-gated", username: "kid", displayName: "Kid", role: "family" };
const cleanUser = { id: "u-clean", username: "owner", displayName: "Owner", role: "owner" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("requirePasswordChangeGate — flag SET", () => {
  it("blocks a normal protected route with 403 PASSWORD_CHANGE_REQUIRED", async () => {
    const prisma = createPrismaMock([{ id: "u-gated", mustChangePassword: true }]);
    const res = await request(buildApp(prisma, gatedUser)).get("/api/llm/models");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("blocks a write route too (not just reads)", async () => {
    const prisma = createPrismaMock([{ id: "u-gated", mustChangePassword: true }]);
    const res = await request(buildApp(prisma, gatedUser)).post("/api/files/upload");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("ALLOWS the change-password endpoint through so the user can self-remediate", async () => {
    const prisma = createPrismaMock([{ id: "u-gated", mustChangePassword: true }]);
    const res = await request(buildApp(prisma, gatedUser)).post("/api/auth/change-password");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe("changed");
  });

  it("ALLOWS /auth/me through so the dashboard can read the must-change signal", async () => {
    const prisma = createPrismaMock([{ id: "u-gated", mustChangePassword: true }]);
    const res = await request(buildApp(prisma, gatedUser)).get("/api/auth/me");

    expect(res.status).toBe(200);
  });

  it("ALLOWS /auth/logout through so the user can sign out", async () => {
    const prisma = createPrismaMock([{ id: "u-gated", mustChangePassword: true }]);
    const res = await request(buildApp(prisma, gatedUser)).post("/api/auth/logout");

    expect(res.status).toBe(200);
  });

  it("ALLOWS /auth/refresh through so the gated session survives the access-token TTL", async () => {
    const prisma = createPrismaMock([{ id: "u-gated", mustChangePassword: true }]);
    const res = await request(buildApp(prisma, gatedUser)).post("/api/auth/refresh");

    expect(res.status).toBe(200);
  });

  // AC #3 — a WebAuthn/TOTP-first user must not bypass the gate. Passkey
  // ENROLMENT is a protected route behind this gate, so a temp-password user
  // can't enrol a credential to escape the forced change.
  it("BLOCKS passkey enrolment so a gated user can't sidestep the change", async () => {
    const prisma = createPrismaMock([{ id: "u-gated", mustChangePassword: true }]);
    const res = await request(buildApp(prisma, gatedUser)).post("/api/webauthn/register/options");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });
});

describe("requirePasswordChangeGate — flag CLEAR / not applicable", () => {
  it("lets a user WITHOUT the flag reach a protected route", async () => {
    const prisma = createPrismaMock([{ id: "u-clean", mustChangePassword: false }]);
    const res = await request(buildApp(prisma, cleanUser)).get("/api/llm/models");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe("models");
  });

  it("never queries the DB for a service principal (and lets it through)", async () => {
    const prisma = createPrismaMock([]);
    const svc = { id: "_service:voice", username: "_service:voice", displayName: "Voice", role: "service" };
    const res = await request(buildApp(prisma, svc)).get("/api/llm/models");

    expect(res.status).toBe(200);
    expect(prisma._findUnique).not.toHaveBeenCalled();
  });

  it("passes through when there is no req.user (auth disabled / public path already handled upstream)", async () => {
    const prisma = createPrismaMock([]);
    const res = await request(buildApp(prisma, null)).get("/api/llm/models");

    expect(res.status).toBe(200);
    expect(prisma._findUnique).not.toHaveBeenCalled();
  });

  it("fails OPEN (does not 500) but lets the request continue when the row is missing", async () => {
    // A session whose row was deleted mid-flight: the gate can't read a flag
    // it can't find. It must not hard-500 the whole app; the downstream
    // self-action / RBAC guards still apply. (No flag → not gated.)
    const prisma = createPrismaMock([]);
    const res = await request(buildApp(prisma, gatedUser)).get("/api/llm/models");

    expect(res.status).toBe(200);
  });
});
