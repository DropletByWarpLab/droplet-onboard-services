/**
 * WARP-3630 — every mutating owner/admin route in the people, access and auth
 * routers carries the policy-gated step-up (or is an explicitly listed
 * self-service route), the other high-impact routers carry it, and the step-up
 * denies on every non-success path while the policy is on.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import express, { type Router } from "express";
import request from "supertest";
import { config } from "../config.js";
import { createRequireAdminStepUp } from "./require-credential-step-up.js";
import { createProtectedAuthRouter } from "../routes/auth.js";
import { createPeopleRouter } from "../routes/people.js";
import { createAccessRouter } from "../routes/access.js";
import { createSystemResetRouter } from "../routes/system-reset.routes.js";
import { createUpdatesRouter } from "../routes/updates.js";
import { createExtensionsRouter } from "../routes/extensions.js";

const stub = {} as any;
const MUTATING = new Set(["post", "put", "patch", "delete"]);
const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

/** Every mutating route in `router`, and whether it carries the named step-up. */
function mutatingRoutes(router: Router): Array<{ id: string; gated: boolean }> {
  const out: Array<{ id: string; gated: boolean }> = [];
  for (const layer of (router as any).stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods).filter((m) => MUTATING.has(m))) {
      out.push({
        id: key(method, String(layer.route.path)),
        gated: layer.route.stack.some((s: any) => s.handle.name === "requireAdminStepUp"),
      });
    }
  }
  return out;
}

// Mutating routes that are deliberately NOT step-up gated, with the reason.
// A new route in these routers fails the walk below until it is gated or
// listed here by a human.
const EXEMPT: Record<string, string> = {
  // Self-service: the caller acts on their own account and re-proves it already.
  "POST /auth/change-password": "self-service; verifies the current password",
  "POST /auth/totp/enroll": "self-service; own credential step-up",
  "POST /auth/totp/verify": "self-service; own credential step-up",
  "POST /auth/recovery": "self-service recovery codes",
  "POST /auth/logout": "self-service",
  // Not a role, credential, deactivation or token change.
  "PUT /people/:id/usage": "usage quota, not access",
};

describe("sibling parity: no mutating admin route in the people, access or auth routers is ungated (WARP-3630)", () => {
  const routers: Array<[string, Router]> = [
    ["auth", createProtectedAuthRouter(stub)],
    ["people", createPeopleRouter(stub, stub)],
    ["access", createAccessRouter(stub)],
  ];
  for (const [name, router] of routers) {
    it(`${name}: every mutating route is gated or listed as exempt`, () => {
      const ungated = mutatingRoutes(router)
        .filter((r) => !r.gated && !(r.id in EXEMPT))
        .map((r) => r.id);
      expect(ungated).toEqual([]);
    });
  }

  it("the named high-impact routes are gated (and exist)", () => {
    const gated = new Set(routers.flatMap(([, r]) => mutatingRoutes(r)).filter((r) => r.gated).map((r) => r.id));
    for (const id of [
      "POST /auth/users",
      "PUT /auth/users/:username",
      "DELETE /auth/users/:username",
      "POST /auth/users/:username/disable",
      "POST /auth/users/:username/enable",
      "POST /auth/users/:username/revoke-sessions",
      "POST /auth/users/:username/cancel-deletion",
      "POST /auth/invites",
      "DELETE /auth/invites/:token",
      "POST /people/invite",
      "PATCH /people/:id/role",
      "PATCH /people/:id/scope",
      "PATCH /people/:id/access",
      "PUT /people/:id/access-exceptions",
      "DELETE /people/:id",
      "POST /access/roles",
      "PATCH /access/roles/:id",
      "DELETE /access/roles/:id",
      "POST /access/roles/:id/assign",
    ]) {
      expect(gated.has(id), id).toBe(true);
    }
  });

  it("system reset, update settings and extension promote are gated", () => {
    const check = (router: Router, id: string) =>
      expect(mutatingRoutes(router).find((r) => r.id === id)?.gated, id).toBe(true);
    check(createSystemResetRouter(stub), "POST /system/reset");
    check(createUpdatesRouter(stub, stub), "PUT /updates/settings");
    check(
      createExtensionsRouter(stub, { sandbox: stub, identity: stub, lifecycle: stub }),
      "POST /extensions/:workspaceId/promote",
    );
  });
});

describe("createRequireAdminStepUp denies on every non-success path while the policy is on (WARP-3630)", () => {
  const cfg = config as { REQUIRE_ADMIN_TWO_STEP: boolean; AUTH_ENABLED: boolean };
  const original = { ...cfg };
  afterEach(() => Object.assign(cfg, original));

  const factors = (o: { totp?: boolean; passkeys?: number; fail?: boolean } = {}) =>
    ({
      totpCredential: {
        findUnique: vi.fn(async () => {
          if (o.fail) throw new Error("db down");
          return o.totp ? { confirmedAt: new Date() } : null;
        }),
      },
      webAuthnCredential: { count: vi.fn(async () => o.passkeys ?? 0) },
      user: { findUnique: vi.fn(async () => ({ passwordHash: "$argon2id$x", provisionSource: "LOCAL" })) },
    }) as any;

  function app(prisma: any, user: Record<string, unknown> | null) {
    const reached = vi.fn();
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      if (user) (req as any).user = user;
      next();
    });
    a.post("/x", createRequireAdminStepUp(prisma), (_req, res) => {
      reached();
      res.json({ ok: true });
    });
    a.use((_err: unknown, _req: any, res: any, _next: any) => void res.status(500).json({ error: "internal" }));
    return { a, reached };
  }
  const fresh = () => new Date().toISOString();

  it("is a pass-through while the policy is off", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = false;
    const { a, reached } = app(factors(), { id: "u1" });
    expect((await request(a).post("/x")).status).toBe(200);
    expect(reached).toHaveBeenCalled();
  });

  it("denies a request with no session user (401)", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = true;
    cfg.AUTH_ENABLED = true;
    const { a, reached } = app(factors(), null);
    expect((await request(a).post("/x")).status).toBe(401);
    expect(reached).not.toHaveBeenCalled();
  });

  it("denies when the database is not wired (500)", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = true;
    cfg.AUTH_ENABLED = true;
    const { a, reached } = app(undefined, { id: "u1", lastMfaAt: fresh() });
    expect((await request(a).post("/x")).status).toBe(500);
    expect(reached).not.toHaveBeenCalled();
  });

  it("denies a person with no second factor, even with a fresh stamp (403 MFA_ENROLLMENT_REQUIRED)", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = true;
    cfg.AUTH_ENABLED = true;
    const { a, reached } = app(factors(), { id: "u1", lastMfaAt: fresh() });
    const res = await request(a).post("/x");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MFA_ENROLLMENT_REQUIRED");
    expect(reached).not.toHaveBeenCalled();
  });

  it("denies when the enrolment lookup errors (500, never next)", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = true;
    cfg.AUTH_ENABLED = true;
    const { a, reached } = app(factors({ fail: true }), { id: "u1", lastMfaAt: fresh() });
    expect((await request(a).post("/x")).status).toBe(500);
    expect(reached).not.toHaveBeenCalled();
  });

  it("denies an enrolled person with no MFA stamp (401 mfa_required) or a stale one (401 mfa_stale)", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = true;
    cfg.AUTH_ENABLED = true;
    const none = app(factors({ totp: true }), { id: "u1" });
    const r1 = await request(none.a).post("/x");
    expect([r1.status, r1.body.error]).toEqual([401, "mfa_required"]);
    const stale = app(factors({ totp: true }), { id: "u1", lastMfaAt: new Date(Date.now() - 3600_000).toISOString() });
    const r2 = await request(stale.a).post("/x");
    expect([r2.status, r2.body.error]).toEqual([401, "mfa_stale"]);
    expect(none.reached).not.toHaveBeenCalled();
    expect(stale.reached).not.toHaveBeenCalled();
  });

  it("denies when the step-up itself hits a database error (500)", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = true;
    cfg.AUTH_ENABLED = true;
    const prisma = factors({ totp: true });
    // enrolment lookup succeeds once, then the step-up's own lookup fails
    prisma.totpCredential.findUnique = vi
      .fn()
      .mockResolvedValueOnce({ confirmedAt: new Date() })
      .mockRejectedValue(new Error("db down"));
    const { a, reached } = app(prisma, { id: "u1", lastMfaAt: fresh() });
    expect((await request(a).post("/x")).status).toBe(500);
    expect(reached).not.toHaveBeenCalled();
  });

  it("passes an enrolled person with a fresh MFA stamp", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = true;
    cfg.AUTH_ENABLED = true;
    const { a, reached } = app(factors({ totp: true }), { id: "u1", lastMfaAt: fresh() });
    expect((await request(a).post("/x")).status).toBe(200);
    expect(reached).toHaveBeenCalled();
  });
});

describe("REQUIRE_ADMIN_TWO_STEP parsing (WARP-3630)", () => {
  // Re-evaluates config.ts with the variable set. The schema is what runs at boot.
  async function load(value: string | undefined) {
    vi.resetModules();
    const prev = process.env.REQUIRE_ADMIN_TWO_STEP;
    if (value === undefined) delete process.env.REQUIRE_ADMIN_TWO_STEP;
    else process.env.REQUIRE_ADMIN_TWO_STEP = value;
    try {
      return (await import("../config.js")).config.REQUIRE_ADMIN_TWO_STEP;
    } finally {
      if (prev === undefined) delete process.env.REQUIRE_ADMIN_TWO_STEP;
      else process.env.REQUIRE_ADMIN_TWO_STEP = prev;
    }
  }

  it.each([[undefined, false], ["", false], ["0", false], ["false", false], ["1", true], ["TRUE", true]])(
    "%j reads as %s",
    async (value, expected) => {
      expect(await load(value as string | undefined)).toBe(expected);
    },
  );

  it.each(["ture", "yes", "on", "2"])("refuses to start on the unrecognised value %j", async (value) => {
    await expect(load(value)).rejects.toThrow();
  });
});
