/**
 * Admin edit-user (PUT /auth/users/:username) — directory-aware edits.
 *
 * ADR-013: the built-in argon2id directory is the auth source of truth and
 * /auth/login verifies the LOCAL passwordHash by email. So an admin editing a
 * member's email or password MUST land on the local `User` row, not only on
 * Nextcloud — otherwise the edit has no effect on directory login. The edit
 * route also enforces the shared password policy (passwordZod) and still
 * mirrors changes to Nextcloud for the WebDAV account.
 *
 * Harness mirrors auth.directory-adduser.test.ts (protected router, synthetic
 * req.user, mocked password.service so the native argon2 binding is never
 * loaded under vitest).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readUserEmail } from "../services/user-directory.service.js";
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

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/nextcloud.client.js", () => {
  class NextcloudOcsError extends Error {
    public readonly ocsStatus: number;
    constructor(message: string, ocsStatus: number) {
      super(message);
      this.name = "NextcloudOcsError";
      this.ocsStatus = ocsStatus;
    }
  }
  class NextcloudUserExistsError extends NextcloudOcsError {
    constructor(message = "User already exists") {
      super(message, 102);
      this.name = "NextcloudUserExistsError";
    }
  }
  return {
    ncCheckSetupRequired: vi.fn(),
    ncInstallAndCreateAdmin: vi.fn().mockResolvedValue(undefined),
    ncLoginWithCredentials: vi.fn(),
    ncDeleteAppPassword: vi.fn().mockResolvedValue(undefined),
    ncGetCurrentUser: vi.fn(),
    ncCreateUser: vi.fn().mockResolvedValue(undefined),
    ncDeleteUser: vi.fn(),
    ncListUsers: vi.fn(),
    ncUpdateUser: vi.fn().mockResolvedValue(undefined),
    ncSetUserEnabled: vi.fn(),
    ncOAuth2AuthorizeUrl: vi.fn(),
    ncOAuth2ExchangeCode: vi.fn(),
    ncOAuth2RefreshToken: vi.fn(),
    NextcloudOcsError,
    NextcloudUserExistsError,
  };
});

vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: vi.fn().mockResolvedValue(undefined),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn().mockResolvedValue(undefined),
  touchNcToken: vi.fn().mockResolvedValue(undefined),
  resolveNcToken: vi.fn().mockResolvedValue("test-nc-token"),
}));

vi.mock("../services/jwt.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/jwt.service.js")>(
    "../services/jwt.service.js",
  );
  return {
    ...actual,
    denyRefreshToken: vi.fn().mockResolvedValue(undefined),
    claimRefreshRotation: vi.fn().mockResolvedValue(true),
  };
});

const hashPassword = vi.fn(async (_pw: string) => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g");
vi.mock("../services/password.service.js", () => ({
  hashPassword: (...args: unknown[]) => hashPassword(...(args as [string])),
  verifyPassword: vi.fn().mockResolvedValue(true),
  verifyDummyPassword: vi.fn().mockResolvedValue(false),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

import { createProtectedAuthRouter } from "./auth.js";
import * as nc from "../services/nextcloud.client.js";
import type { Role } from "../services/jwt.service.js";

/**
 * Prisma stub for the edit-user handler. `updateMany` mutates seeded rows
 * matched by `nextcloudUsername` (or `username`) and reports the row count —
 * mirroring Prisma's contract so the route's 404-on-zero-rows path is exercised.
 * WARP-1526: `findUnique` resolves the target row by nextcloudUsername — the
 * role-relevant branch now looks the target up to run the owner-untouchable
 * and self-action rails.
 */
function createPrismaMock(seed: any[] = []) {
  const users: any[] = [...seed];
  const self: any = {};
  self.user = {
    findUnique: vi.fn(async ({ where }: any) => {
      return (
        users.find(
          (u) =>
            where.nextcloudUsername !== undefined &&
            u.nextcloudUsername === where.nextcloudUsername,
        ) ?? null
      );
    }),
    // WARP-1564 (review L2): honors a `role` PIN in the where-clause. The
    // route pins the role rail 1b decided against, so a promotion racing
    // between the guard's read and this write matches 0 rows instead of
    // rotating an owner's credential. A mock that ignored `where.role` would
    // let the pin be deleted without a single test going red.
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      for (let i = 0; i < users.length; i += 1) {
        const u = users[i];
        const match =
          ((where.nextcloudUsername !== undefined && u.nextcloudUsername === where.nextcloudUsername) ||
            (where.username !== undefined && u.username === where.username)) &&
          (where.role === undefined || u.role === where.role);
        if (match) {
          users[i] = { ...u, ...data };
          count += 1;
        }
      }
      return { count };
    }),
  };
  self._users = users;
  return self;
}

/** Mount the protected auth router behind a synthetic req.user (owner by default). */
function buildApp(prismaMock: any, callerRole: Role = "owner") {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as any).user = {
      id: `${callerRole}-id`,
      username: `user-${callerRole}`,
      displayName: `User ${callerRole}`,
      role: callerRole,
    };
    next();
  });
  app.use("/api", createProtectedAuthRouter(prismaMock));
  return app;
}

function seededAlice() {
  return {
    id: "u-alice",
    username: "alice",
    nextcloudUsername: "alice",
    displayName: "Alice",
    email: "alice@warp.test",
    passwordHash: "$argon2id$OLD-HASH",
    role: "family",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (nc.ncUpdateUser as any).mockResolvedValue(undefined);
  hashPassword.mockImplementation(async (_pw: string) => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g");
});

describe("PUT /api/auth/users/:username — directory-aware edits", () => {
  it("rejects a weak password with WEAK_PASSWORD and writes nothing", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "weak" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WEAK_PASSWORD");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("writes the argon2id passwordHash to the local row (never the plaintext) and mirrors to Nextcloud", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "New-secret123" });

    expect(res.status).toBe(200);
    const row = prisma._users.find((u: any) => u.username === "alice");
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toBe("$argon2id$OLD-HASH"); // actually rotated
    expect(JSON.stringify(row)).not.toContain("New-secret123"); // plaintext never stored
    // Still provisions the WebDAV side with the plaintext.
    expect(nc.ncUpdateUser).toHaveBeenCalledWith("test-nc-token", "alice", "password", "New-secret123");
  });

  it("writes a normalized email to the local row and mirrors it to Nextcloud", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ email: "  NewAlice@Example.COM  " });

    expect(res.status).toBe(200);
    const row = prisma._users.find((u: any) => u.username === "alice");
    // WARP-233: stored as a dcv1 blob — decrypt for the assertion.
    expect(readUserEmail(row.email)).toBe("newalice@example.com");
    expect(nc.ncUpdateUser).toHaveBeenCalledWith("test-nc-token", "alice", "email", "newalice@example.com");
  });

  it("updates displayName on the local row and Nextcloud", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ displayName: "Alice Cooper" });

    expect(res.status).toBe(200);
    const row = prisma._users.find((u: any) => u.username === "alice");
    expect(row.displayName).toBe("Alice Cooper");
    expect(nc.ncUpdateUser).toHaveBeenCalledWith("test-nc-token", "alice", "displayname", "Alice Cooper");
  });

  it("404s when changing the email/password of a user with no local directory row", async () => {
    const prisma = createPrismaMock([]); // no alice row
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/ghost")
      .send({ password: "Ghost-secret123" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("USER_NOT_FOUND");
    // The WebDAV-side write must not happen for a non-existent directory user.
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("fails closed (500 USERS_NO_PRISMA) when the directory isn't wired and a credential change is requested", async () => {
    // Legacy createAuthRouter() shim wires the protected router WITHOUT prisma.
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as any).user = { id: "owner-id", username: "user-owner", displayName: "Owner", role: "owner" as Role };
      next();
    });
    app.use("/api", createProtectedAuthRouter(undefined));

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "New-secret123" });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("USERS_NO_PRISMA");
  });

  it("rejects a non-admin caller with 403", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "family");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ displayName: "Hacker" });

    expect(res.status).toBe(403);
  });
});

describe("PUT /api/auth/users/:username — WARP-1523 ROLE_RANK cap", () => {
  // updateUserSchema deliberately has no `role` field, so before this guard a
  // `role` key in the body was silently STRIPPED by zod — an admin probing
  // `{ role: "owner" }` got either a validation 400 or, mixed with a real
  // field, a 200 that looked like a successful promotion. The cap makes the
  // refusal explicit and fail-closed, mirroring the POST /auth/users +
  // POST /auth/invites create-site guards (WARP-1042 / WARP-623): any
  // recognized requested role that outranks the caller is rejected before a
  // single directory or Nextcloud write happens.
  it("admin sending role: owner → 403 ROLE_RANK_EXCEEDED, nothing written", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ role: "owner" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_RANK_EXCEEDED");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("admin mixing an outranking role into an otherwise-valid edit → 403, other fields NOT half-applied", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ displayName: "Sneaky", role: "owner" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_RANK_EXCEEDED");
    const row = prisma._users.find((u: any) => u.username === "alice");
    expect(row.displayName).toBe("Alice"); // untouched
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("a within-rank role key does not 403 — but this endpoint still does NOT apply roles (PATCH /api/people/:id/role owns that)", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ displayName: "Alice B", role: "admin" });

    expect(res.status).toBe(200);
    const row = prisma._users.find((u: any) => u.username === "alice");
    expect(row.displayName).toBe("Alice B");
    expect(row.role).toBe("family"); // role untouched — schema strips it
    expect(nc.ncUpdateUser).toHaveBeenCalledTimes(1); // displayname only
    expect(nc.ncUpdateUser).toHaveBeenCalledWith("test-nc-token", "alice", "displayname", "Alice B");
  });

  it("an unrecognized role string is not rank-checked — it falls through to schema validation (400)", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ role: "superuser" });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_REQUEST");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("PUT /api/auth/users/:username — WARP-1526 rails on the role-relevant branch", () => {
  // The legacy surface gets the SAME rails as PATCH /api/people/:id/role,
  // through the same guard service — the surfaces can't drift again.
  it("a role key targeting the OWNER row → 403 OWNER_IMMUTABLE, nothing written to directory or Nextcloud", async () => {
    const prisma = createPrismaMock([
      {
        id: "u-boss",
        username: "boss",
        nextcloudUsername: "boss",
        displayName: "Boss",
        email: "boss@warp.test",
        passwordHash: "$argon2id$OLD-HASH",
        role: "owner",
      },
    ]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ displayName: "Renamed", role: "family" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(res.body.error).toBe(
      "The owner has full control and can't be changed here.",
    );
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("a role key targeting YOURSELF → 409 SELF_ACTION_NOT_ALLOWED (same rail as the people surface)", async () => {
    const prisma = createPrismaMock([
      {
        id: "admin-id", // matches buildApp's synthetic req.user.id for callerRole=admin
        username: "user-admin",
        nextcloudUsername: "selfadmin",
        displayName: "Self Admin",
        email: "self@warp.test",
        passwordHash: "$argon2id$OLD-HASH",
        role: "admin",
      },
    ]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/selfadmin")
      .send({ role: "family" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("owner sending role: owner → 403 ROLE_NOT_ASSIGNABLE (narrowing runs after the rank cap; owner is never assignable)", async () => {
    // Sibling of the create/invite-site supersessions: before WARP-1526 a
    // within-rank owner key was silently STRIPPED (200). The refusal is
    // now explicit — people are {admin, family, guest} only (§6.2).
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ role: "owner" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_NOT_ASSIGNABLE");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("role: service → 403 ROLE_NOT_ASSIGNABLE (service principals are env-var-only; rank −1 cleared the old cap)", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ role: "service", displayName: "Sneaky" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("ROLE_NOT_ASSIGNABLE");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });
});

describe("PUT /api/auth/users/:username — WARP-1564 owner-credential carve-out", () => {
  // THE RESIDUAL VECTOR the RBAC v2 epic left open. Rail 1 (owner
  // untouchable) guarded only the ROLE-relevant branch of this route, so an
  // admin could not promote / demote / disable / remove the owner — but could
  // send `{ password: "…" }` at the owner's username and rotate BOTH the local
  // argon2id hash AND the Nextcloud mirror, then simply sign in as the owner.
  // Every other takeover door being shut is exactly what made this one
  // decisive.
  //
  // A blanket rail 1 on the route is wrong: it would also refuse the OWNER's
  // own identity self-edits, which are legitimate. The rail is therefore
  // self-vs-other — refuse when the target is an owner AND the actor is not
  // that same owner (assertDirectoryEditAllowed).
  function seededOwner(id = "owner-id") {
    return {
      id,
      username: "boss",
      nextcloudUsername: "boss",
      displayName: "Boss",
      email: "boss@warp.test",
      passwordHash: "$argon2id$OWNER-HASH",
      role: "owner",
    };
  }

  it("admin rotating the OWNER's password → 403 OWNER_IMMUTABLE; the hash is NOT rotated", async () => {
    const prisma = createPrismaMock([seededOwner()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ password: "Takeover-secret123" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(res.body.error).toBe(
      "The owner has full control and can't be changed here.",
    );
    // The credential is untouched — the whole point.
    const row = prisma._users.find((u: any) => u.username === "boss");
    expect(row.passwordHash).toBe("$argon2id$OWNER-HASH");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
  });

  it("the Nextcloud mirror is NOT called on a refusal (no half-applied takeover on the WebDAV side)", async () => {
    const prisma = createPrismaMock([seededOwner()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ password: "Takeover-secret123" });

    expect(res.status).toBe(403);
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  // NOTE (review L1) — "a refusal writes no Activity row" is NOT pinned here,
  // and the assertion that used to sit in this spot was vacuous: PUT
  // /auth/users/:username calls recordActivity on NO path, success or
  // refusal, so `expect(recordActivity).not.toHaveBeenCalled()` was green with
  // or without the rail and would never have caught a regression. The rails'
  // "refusals emit nothing" contract is pinned where it can actually fail —
  // role-mutation-guard.service.test.ts, and the people-surface route suites,
  // whose routes DO record activity on their success paths.
  //
  // Worth stating plainly rather than hiding behind a passing assertion: this
  // route rotates credentials and audits NOTHING, while its siblings all do
  // (POST /auth/users → "account created", change-password, disable, delete).
  // That audit gap is pre-existing and out of scope here — reported for
  // WARP-1614, not silently papered over with a test that proves nothing.

  it("the OWNER changing their OWN password is still allowed (this is why rail 1 can't be blanket)", async () => {
    // buildApp's synthetic req.user.id for callerRole="owner" is "owner-id" —
    // the same id as the seeded row, i.e. a genuine self-edit.
    const prisma = createPrismaMock([seededOwner("owner-id")]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ password: "Owner-newsecret123" });

    expect(res.status).toBe(200);
    const row = prisma._users.find((u: any) => u.username === "boss");
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toBe("$argon2id$OWNER-HASH"); // actually rotated
    expect(nc.ncUpdateUser).toHaveBeenCalledWith(
      "test-nc-token",
      "boss",
      "password",
      "Owner-newsecret123",
    );
  });

  it("admin rotating a NON-owner's password still works (no regression on the ordinary admin duty)", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "Reset-secret123" });

    expect(res.status).toBe(200);
    const row = prisma._users.find((u: any) => u.username === "alice");
    expect(row.passwordHash).not.toBe("$argon2id$OLD-HASH");
    expect(nc.ncUpdateUser).toHaveBeenCalledWith(
      "test-nc-token",
      "alice",
      "password",
      "Reset-secret123",
    );
  });

  it("admin rewriting the OWNER's email → 403 (email IS the login key /auth/login resolves by)", async () => {
    const prisma = createPrismaMock([seededOwner()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ email: "attacker@evil.test" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("admin renaming the OWNER (displayName) → 403 — rail 1 is 'any mutation targeting an owner row'", async () => {
    const prisma = createPrismaMock([seededOwner()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ displayName: "Definitely Not The Owner" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    const row = prisma._users.find((u: any) => u.username === "boss");
    expect(row.displayName).toBe("Boss");
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("admin capping the OWNER's quota → 403 — the class PUT /api/people/:id/usage already refuses", async () => {
    // Surface-parity: assertUsageWriteAllowed rail-1s the owner's usage policy
    // on the people surface. Leaving quota open here is precisely the
    // two-surface drift the guard service exists to prevent (WARP-1523).
    const prisma = createPrismaMock([seededOwner()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ quota: "1 MB" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("refuses BEFORE schema validation — a weak password at the owner's row answers 403, not 400 WEAK_PASSWORD", async () => {
    // No validation oracle: an admin probing the owner's row learns nothing
    // about the body's shape, and nothing can be half-applied.
    const prisma = createPrismaMock([seededOwner()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ password: "weak" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
  });

  it("owner A cannot rotate owner B's password in a drifted two-owner directory (self, not merely owner-role)", async () => {
    // The rail matches on IDENTITY, not on the actor's tier: holding the
    // owner role is not permission to edit a DIFFERENT owner's row.
    const prisma = createPrismaMock([seededOwner("u-other-owner")]);
    const app = buildApp(prisma, "owner"); // req.user.id = "owner-id" ≠ "u-other-owner"

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ password: "Sibling-secret123" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("the owner's own displayName self-edit is untouched by the rail", async () => {
    const prisma = createPrismaMock([seededOwner("owner-id")]);
    const app = buildApp(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ displayName: "The Boss" });

    expect(res.status).toBe(200);
    const row = prisma._users.find((u: any) => u.username === "boss");
    expect(row.displayName).toBe("The Boss");
  });
});

describe("PUT /api/auth/users/:username — WARP-1564 rail 1b, ROUTE-level fail-closed wiring", () => {
  // Review M2. The pure-function fail-closed behaviour is pinned in
  // role-mutation-guard.service.test.ts over [null, undefined, ""], but that
  // says nothing about THIS route's `actor: { id: req.user?.id }` plumbing:
  // the reviewer flipped `if (!actorId || …)` to `if (actorId && …)` in the
  // rail and the entire route suite stayed green, because every other case
  // supplies an id. These are the assertions that survive a refactor of the
  // actor plumbing — e.g. someone renaming the claim, or a middleware that
  // stops populating `id`.
  //
  // requireRole() gates on `req.user.role` ONLY (middleware/auth.ts), so a
  // session with a role but no id reaches the handler — this is reachable,
  // not a synthetic shape.
  function buildAppWithoutActorId(prismaMock: any, callerRole: Role) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      // Deliberately NO `id` — a session that lost (or never carried) the
      // subject claim.
      (req as any).user = {
        username: `user-${callerRole}`,
        displayName: `User ${callerRole}`,
        role: callerRole,
      };
      next();
    });
    app.use("/api", createProtectedAuthRouter(prismaMock));
    return app;
  }

  function ownerRow() {
    return {
      id: "owner-id",
      username: "boss",
      nextcloudUsername: "boss",
      displayName: "Boss",
      email: "boss@warp.test",
      passwordHash: "$argon2id$OWNER-HASH",
      role: "owner",
    };
  }

  it("an OWNER-role caller with no actor id cannot rotate the owner's password → 403, nothing written", async () => {
    // The demanding case: the caller's ROLE matches the target's, so tier
    // tells the rail nothing. Only the identity check can refuse — and with
    // no id, identity cannot be proven, so it MUST refuse. An actor id is
    // what PERMITS here (the inverse of rail 2, where it refuses).
    const prisma = createPrismaMock([ownerRow()]);
    const app = buildAppWithoutActorId(prisma, "owner");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ password: "Takeover-secret123" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
    const row = prisma._users.find((u: any) => u.username === "boss");
    expect(row.passwordHash).toBe("$argon2id$OWNER-HASH");
  });

  it("an ADMIN caller with no actor id is refused the same way → 403, nothing written", async () => {
    const prisma = createPrismaMock([ownerRow()]);
    const app = buildAppWithoutActorId(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/boss")
      .send({ password: "Takeover-secret123" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("OWNER_IMMUTABLE");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("a missing actor id does NOT break ordinary edits on a non-owner row (fail-closed, not fail-broken)", async () => {
    // The rail keys on the TARGET being an owner. Refusing every id-less
    // request outright would be a different, broader change than this ticket
    // makes — pinned so a future "just require an id everywhere" tightening
    // is a conscious decision with a red test, not a silent side effect.
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildAppWithoutActorId(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ displayName: "Alice B" });

    expect(res.status).toBe(200);
  });
});

describe("PUT /api/auth/users/:username — WARP-1564 review L2: the write pins the role rail 1b decided against", () => {
  // The rail necessarily decides on a NON-transactional findUnique. Without a
  // role pin on the write, a promotion landing between that read and the
  // updateMany rotates the credential of a row that is an OWNER by the time
  // it is written — a decision made against stale state, which is exactly
  // what the guard service header says every guarded mutation must prevent.
  //
  // The concurrent writer is real: scim-role-mapping.service.ts maps any SCIM
  // group whose normalized name CONTAINS "owner" to role "owner", so an Okta
  // push of a group named "Business Owners" mints owners asynchronously.
  //
  // The race is simulated the only way it can be deterministically: the
  // stored row is ALREADY the post-race value (owner) while findUnique
  // returns the STALE pre-race snapshot (family) the rail decided on.
  function racedPrisma() {
    const prisma = createPrismaMock([
      {
        id: "u-alice",
        username: "alice",
        nextcloudUsername: "alice",
        displayName: "Alice",
        email: "alice@warp.test",
        passwordHash: "$argon2id$OLD-HASH",
        role: "owner", // ← SCIM promoted her while this request was in flight
      },
    ]);
    // …but the rail read her while she was still `family`, so rail 1b passes.
    prisma.user.findUnique.mockResolvedValue({ id: "u-alice", role: "family" });
    return prisma;
  }

  it("a promotion racing the write does NOT rotate the now-owner's password — 0-row no-op, not a takeover", async () => {
    const prisma = racedPrisma();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "Raced-secret123" });

    // The credential is intact — the pin, not the rail, is what saved it.
    const row = prisma._users.find((u: any) => u.username === "alice");
    expect(row.passwordHash).toBe("$argon2id$OLD-HASH");
    // And the write really was attempted with the pin.
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { nextcloudUsername: "alice", role: "family" },
      }),
    );
  });

  it("the raced no-op answers 409 CONCURRENT_MUTATION — NOT 404 USER_NOT_FOUND (the row is very much there)", async () => {
    // The 404 path is gated on `updated.count === 0`, so before the pin's
    // 409 branch a raced no-op would have reported the account as missing:
    // wrong, and it would bury the one signal that a promotion was in flight.
    // 409 is the answer the disable / remove routes already give for this
    // class, from the same guard vocabulary.
    const prisma = racedPrisma();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "Raced-secret123" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MUTATION");
    expect(res.body.error).toBe(
      "Someone else changed this person at the same time. Try again.",
    );
  });

  it("the raced no-op returns BEFORE the Nextcloud mirror — nothing half-applied on the WebDAV side", async () => {
    const prisma = racedPrisma();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "Raced-secret123", displayName: "Raced" });

    expect(res.status).toBe(409);
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });

  it("a displayName-only edit that loses the race is also refused (not silently mirrored to NC)", async () => {
    // The 404 branch is gated on touchesDirectory, so a non-credential body
    // used to fall straight through to Nextcloud on a 0-row write. A raced
    // promotion must refuse the whole request: the rail's decision was made
    // against a role the row no longer has.
    const prisma = racedPrisma();
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ displayName: "Raced Rename" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONCURRENT_MUTATION");
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
    const row = prisma._users.find((u: any) => u.username === "alice");
    expect(row.displayName).toBe("Alice");
  });

  it("the ordinary un-raced edit still matches and still 200s (the pin is not a tax on the happy path)", async () => {
    const prisma = createPrismaMock([seededAlice()]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/alice")
      .send({ password: "Reset-secret123" });

    expect(res.status).toBe(200);
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { nextcloudUsername: "alice", role: "family" },
      }),
    );
  });

  it("a username with NO local row still 404s on a credential edit (the pin doesn't hijack that path)", async () => {
    // target === null → nothing to pin against → the pre-existing 404
    // USER_NOT_FOUND must survive, not become a 409.
    const prisma = createPrismaMock([]);
    const app = buildApp(prisma, "admin");

    const res = await request(app)
      .put("/api/auth/users/ghost")
      .send({ password: "Ghost-secret123" });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("USER_NOT_FOUND");
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { nextcloudUsername: "ghost" } }),
    );
    expect(nc.ncUpdateUser).not.toHaveBeenCalled();
  });
});
