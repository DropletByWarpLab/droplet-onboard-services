/**
 * WARP-3630 — every high-impact admin route carries the policy-gated step-up,
 * and that step-up answers 401 mfa_required when the MFA stamp is missing or
 * stale (and is a pass-through while the policy is off).
 */
import { describe, it, expect, afterEach } from "vitest";
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
const routers: Array<[string, Router, Array<[string, string]>]> = [
  [
    "auth",
    createProtectedAuthRouter(stub),
    [["post", "/auth/users"], ["put", "/auth/users/:username"], ["delete", "/auth/users/:username"], ["post", "/auth/invites"]],
  ],
  [
    "people",
    createPeopleRouter(stub, stub),
    [
      ["post", "/people/invite"],
      ["patch", "/people/:id/role"],
      ["patch", "/people/:id/access"],
      ["put", "/people/:id/access-exceptions"],
      ["delete", "/people/:id"],
    ],
  ],
  [
    "access",
    createAccessRouter(stub),
    [["post", "/access/roles"], ["patch", "/access/roles/:id"], ["delete", "/access/roles/:id"], ["post", "/access/roles/:id/assign"]],
  ],
  ["system-reset", createSystemResetRouter(stub), [["post", "/system/reset"]]],
  ["updates", createUpdatesRouter(stub, stub), [["put", "/updates/settings"]]],
  [
    "extensions",
    createExtensionsRouter(stub, { sandbox: stub, identity: stub, lifecycle: stub }),
    [["post", "/extensions/:workspaceId/promote"]],
  ],
];

describe("admin step-up is mounted on each high-impact route (WARP-3630)", () => {
  for (const [name, router, routes] of routers) {
    for (const [method, path] of routes) {
      it(`${name}: ${method.toUpperCase()} ${path}`, () => {
        const layer = (router as any).stack.find((l: any) => l.route?.path === path && l.route.methods[method]);
        expect(layer, "route exists").toBeTruthy();
        expect(layer.route.stack.map((s: any) => s.handle.name)).toContain("requireAdminStepUp");
      });
    }
  }
});

describe("createRequireAdminStepUp (WARP-3630)", () => {
  const prisma = { totpCredential: { findUnique: async () => ({ confirmedAt: new Date() }) } } as any;
  const cfg = config as { REQUIRE_ADMIN_TWO_STEP: boolean };
  const original = cfg.REQUIRE_ADMIN_TWO_STEP;
  afterEach(() => {
    cfg.REQUIRE_ADMIN_TWO_STEP = original;
  });

  function app(lastMfaAt?: string) {
    const a = express();
    a.use((req, _res, next) => {
      (req as any).user = { id: "u1", ...(lastMfaAt ? { lastMfaAt } : {}) };
      next();
    });
    a.post("/x", createRequireAdminStepUp(prisma), (_req, res) => void res.json({ ok: true }));
    return a;
  }

  it("is a pass-through while the policy is off", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = false;
    expect((await request(app()).post("/x")).status).toBe(200);
  });

  it("answers 401 mfa_required with no MFA stamp when the policy is on", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = true;
    const res = await request(app()).post("/x");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("mfa_required");
  });

  it("answers 401 mfa_stale for an old stamp, and passes a fresh one", async () => {
    cfg.REQUIRE_ADMIN_TWO_STEP = true;
    const old = new Date(Date.now() - 3600_000).toISOString();
    expect((await request(app(old)).post("/x")).body.error).toBe("mfa_stale");
    expect((await request(app(new Date().toISOString())).post("/x")).status).toBe(200);
  });
});
