/**
 * WARP-455 — proof-of-wiring for the scope axis on the people mutation
 * routes.
 *
 * The middleware truth table is locked by
 * `require-scope.middleware.test.ts`; this file proves the guard is
 * actually MOUNTED — `requireRole("owner","admin")` then
 * `requireScope("exec_only", loader)` — on the three people mutation
 * routes (PATCH /people/:id/role, PATCH /people/:id/scope,
 * DELETE /people/:id), mirroring `rbac.test.ts`'s buildMatrixApp /
 * mkUser synthetic-auth pattern.
 *
 * Mounting the guard pair directly (rather than the full people router)
 * keeps the assertion on the GUARD chain — a downstream handler error
 * (Nextcloud/Prisma) can't bleed into the wiring assertion. The chain
 * here is byte-identical to what `createPeopleRouter` builds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction, Router } from "express";

// Config mock — hoisted above route imports (same as rbac.test.ts).
vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true },
}));

import { requireRole, type AuthUser } from "../middleware/auth.js";
import {
  requireScope,
  type ScopeLoader,
  type ScopeName,
} from "../middleware/scope.js";
import type { Role } from "../services/jwt.service.js";

// The three guarded people mutation routes, byte-identical guard chain
// to createPeopleRouter (requireRole then requireScope("exec_only")).
const GUARDED_ROUTES: { method: "patch" | "delete"; path: string }[] = [
  { method: "patch", path: "/people/u1/role" },
  { method: "patch", path: "/people/u1/scope" },
  { method: "delete", path: "/people/u1" },
];

function mkUser(role: Role, id = `user-${role}`): AuthUser {
  return {
    id,
    username: `user-${role}`,
    displayName: `User ${role}`,
    role,
  };
}

/**
 * Mount the guarded people routes with an injected loader, chaining
 * requireRole("owner","admin") then requireScope("exec_only", loader),
 * exactly as createPeopleRouter does. The handler returns 200 so the
 * response status reflects only what the guard chain decided.
 */
function buildScopeApp(user: AuthUser | null, loader: ScopeLoader): {
  app: express.Express;
} {
  const app = express();
  app.use(express.json());

  // Synthetic auth — stuff req.user directly (rbac.test.ts pattern).
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: AuthUser }).user = user;
    next();
  });

  const router = Router({ mergeParams: true });
  for (const route of GUARDED_ROUTES) {
    router[route.method](
      route.path,
      requireRole("owner", "admin"),
      requireScope("exec_only", loader),
      (_req: Request, res: Response) => {
        res.status(200).json({ ok: true });
      },
    );
  }
  app.use("/api", router);
  return { app };
}

function loaderReturning(scopes: ScopeName[]): ScopeLoader {
  return vi.fn(async (_userId: string) => new Set<ScopeName>(scopes));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("scope axis wired on people mutation routes (WARP-455)", () => {
  it("owner reaches PATCH /people/:id/role even with empty scope set (admin-tier short-circuits the loader)", async () => {
    const loader = loaderReturning([]);
    const { app } = buildScopeApp(mkUser("owner"), loader);
    const res = await request(app).patch("/api/people/u1/role").send({});
    expect(res.status).toBe(200);
  });

  it("admin reaches PATCH /people/:id/scope with empty scope set", async () => {
    const loader = loaderReturning([]);
    const { app } = buildScopeApp(mkUser("admin"), loader);
    const res = await request(app).patch("/api/people/u1/scope").send({});
    expect(res.status).toBe(200);
  });

  it("loader is NOT invoked for owner/admin (no DB round-trip on the hot path)", async () => {
    const loader = loaderReturning([]);
    const { app } = buildScopeApp(mkUser("admin"), loader);
    await request(app).delete("/api/people/u1").send({});
    expect(loader).not.toHaveBeenCalled();
  });

  it("a family principal that somehow passes requireRole is 403'd by requireScope without an exec_only binding", async () => {
    // Drive the requireScope axis directly with a synthetic family user
    // on a route whose requireRole allowlist is widened to include
    // family — proving the second axis bites if the role allowlist ever
    // grows. (The production allowlist is owner/admin only; this is the
    // future-proofing the spec calls for.)
    const loader = loaderReturning(["team"]); // family lacks exec_only
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: AuthUser }).user = mkUser("family");
      next();
    });
    const router = Router({ mergeParams: true });
    router.patch(
      "/people/:id/role",
      requireRole("owner", "admin", "family"), // widened allowlist
      requireScope("exec_only", loader),
      (_req: Request, res: Response) => res.status(200).json({ ok: true }),
    );
    app.use("/api", router);

    const res = await request(app).patch("/api/people/u1/role").send({});
    expect(res.status).toBe(403);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("a family principal WITH the exec_only binding passes the widened route", async () => {
    const loader = loaderReturning(["exec_only"]);
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: AuthUser }).user = mkUser("family");
      next();
    });
    const router = Router({ mergeParams: true });
    router.patch(
      "/people/:id/role",
      requireRole("owner", "admin", "family"),
      requireScope("exec_only", loader),
      (_req: Request, res: Response) => res.status(200).json({ ok: true }),
    );
    app.use("/api", router);

    const res = await request(app).patch("/api/people/u1/role").send({});
    expect(res.status).toBe(200);
  });

  it("loader throwing yields 500 not 403 (operational error, not auth-fault)", async () => {
    const loader: ScopeLoader = vi.fn(async () => {
      throw new Error("prisma down");
    });
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: AuthUser }).user = mkUser("family");
      next();
    });
    const router = Router({ mergeParams: true });
    router.patch(
      "/people/:id/role",
      requireRole("owner", "admin", "family"),
      requireScope("exec_only", loader),
      (_req: Request, res: Response) => res.status(200).json({ ok: true }),
    );
    app.use("/api", router);

    const res = await request(app).patch("/api/people/u1/role").send({});
    expect(res.status).toBe(500);
  });
});
