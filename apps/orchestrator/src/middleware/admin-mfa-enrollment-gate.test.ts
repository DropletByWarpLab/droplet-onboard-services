/**
 * WARP-3630 — with REQUIRE_ADMIN_TWO_STEP on, an owner or admin with no second
 * factor reaches only the enrolment surface; everyone else is unchanged.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const cfg = vi.hoisted(() => ({ REQUIRE_ADMIN_TWO_STEP: true, AUTH_ENABLED: true }));
vi.mock("../config.js", () => ({ config: cfg }));

import { requireAdminMfaEnrollmentGate } from "./admin-mfa-enrollment-gate.js";

function prismaWith(o: { totp?: boolean; passkeys?: number; fail?: boolean }) {
  return {
    totpCredential: {
      findUnique: vi.fn(async () => {
        if (o.fail) throw new Error("db down");
        return o.totp ? { confirmedAt: new Date() } : null;
      }),
    },
    webAuthnCredential: { count: vi.fn(async () => o.passkeys ?? 0) },
  } as any;
}

function app(prisma: any, role: string | null = "owner") {
  const a = express();
  a.use((req, _res, next) => {
    if (role) (req as any).user = { id: "u1", username: "u", role };
    next();
  });
  a.use(requireAdminMfaEnrollmentGate(prisma));
  a.all("*", (_req, res) => void res.json({ ok: true }));
  return a;
}

beforeEach(() => {
  cfg.REQUIRE_ADMIN_TWO_STEP = true;
  cfg.AUTH_ENABLED = true;
});

describe("admin MFA enrolment gate (WARP-3630)", () => {
  it.each(["owner", "admin"])("blocks an unenrolled %s with MFA_ENROLLMENT_REQUIRED", async (role) => {
    const res = await request(app(prismaWith({}), role)).get("/api/people");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MFA_ENROLLMENT_REQUIRED");
  });

  it.each([
    "/api/auth/me",
    "/api/auth/logout",
    "/api/auth/refresh",
    "/api/auth/totp/enroll",
    "/api/auth/totp/verify",
    "/api/auth/webauthn/register/options",
    "/api/auth/webauthn/register/verify",
  ])("leaves the enrolment surface %s reachable", async (path) => {
    expect((await request(app(prismaWith({}))).post(path)).status).toBe(200);
  });

  it("passes an owner with a confirmed TOTP credential", async () => {
    expect((await request(app(prismaWith({ totp: true }))).get("/api/people")).status).toBe(200);
  });

  it("passes an admin with a registered passkey", async () => {
    expect((await request(app(prismaWith({ passkeys: 1 }), "admin")).get("/api/people")).status).toBe(200);
  });

  it("does not gate members, guests or service principals", async () => {
    for (const role of ["family", "guest", "service"]) {
      expect((await request(app(prismaWith({}), role)).get("/api/people")).status).toBe(200);
    }
  });

  it("does not treat a pending (unconfirmed) TOTP credential as a factor", async () => {
    const prisma = prismaWith({});
    prisma.totpCredential.findUnique = vi.fn(async () => ({ confirmedAt: null }));
    expect((await request(app(prisma)).get("/api/people")).status).toBe(403);
  });

  it("is a pass-through when the policy is off", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = false;
    expect((await request(app(prismaWith({}))).get("/api/people")).status).toBe(200);
  });

  it("fails closed (503) when the lookup errors", async () => {
    expect((await request(app(prismaWith({ fail: true }))).get("/api/people")).status).toBe(503);
  });
});
