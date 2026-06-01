/**
 * ADR-012 — account creation writes the argon2id hash to the directory.
 *
 * POST /auth/setup (the onboarding Account-step backend / first-admin
 * bootstrap) must persist the argon2id `passwordHash` to the local
 * directory — the directory is the auth source of truth — and still
 * provision the Nextcloud admin downstream (Files/WebDAV).
 *
 * Coverage:
 *   1. setup hashes the password (password.service) and writes the
 *      resulting argon2id PHC string to User.passwordHash.
 *   2. setup persists the email when provided (the stable login key).
 *   3. the plaintext password is NEVER written to the row.
 *   4. Nextcloud is still provisioned downstream (ncInstallAndCreateAdmin).
 *   5. order: the idempotent local write lands, then NC provisioning.
 *
 * Strategy mirrors auth.directory-login.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    REDIS_URL: "redis://localhost:6379",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
  },
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
    ncUpdateUser: vi.fn(),
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

const hashPassword = vi.fn(async (_pw: string) => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g");
vi.mock("../services/password.service.js", () => ({
  hashPassword: (...args: unknown[]) => hashPassword(...(args as [string])),
  verifyPassword: vi.fn().mockResolvedValue(true),
  verifyDummyPassword: vi.fn().mockResolvedValue(false),
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

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

import { createPublicAuthRouter } from "./auth.js";
import * as nc from "../services/nextcloud.client.js";

function createPrismaMock(seed: any[] = []) {
  const users: any[] = [...seed];
  const callOrder: string[] = [];
  const self: any = {};
  self.user = {
    findUnique: vi.fn(async () => null),
    // Mirrors the people.ts owner-count idiom — the N1 guard counts
    // existing owners before allowing /auth/setup to (re)write one.
    count: vi.fn(async ({ where }: any = {}) => {
      if (where?.role !== undefined) {
        return users.filter((u) => u.role === where.role).length;
      }
      return users.length;
    }),
    upsert: vi.fn(async ({ where, create, update }: any) => {
      callOrder.push("user.upsert");
      const idx = users.findIndex(
        (u) =>
          (where.nextcloudUsername !== undefined &&
            u.nextcloudUsername === where.nextcloudUsername) ||
          (where.email !== undefined && u.email === where.email),
      );
      if (idx >= 0) {
        users[idx] = { ...users[idx], ...update };
        return users[idx];
      }
      // Enforce the plain (case-sensitive) unique index on email exactly
      // as Postgres would: a CREATE whose email already exists on another
      // row trips P2002. The route hands an already-normalized
      // (trim+lowercased) value, so an exact-string match here faithfully
      // models the DB rejecting `Owner@x` once `owner@x` is present.
      if (
        create.email != null &&
        users.some((u) => u.email === create.email)
      ) {
        const e: any = new Error(
          'Unique constraint failed on the fields: ("email")',
        );
        e.code = "P2002";
        e.meta = { target: ["email"] };
        throw e;
      }
      const row = {
        id: create.id ?? `u-${users.length + 1}`,
        ...create,
      };
      users.push(row);
      return row;
    }),
  };
  self._users = users;
  self._callOrder = callOrder;
  return self;
}

function buildApp(prismaMock: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createPublicAuthRouter(prismaMock));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  (nc.ncInstallAndCreateAdmin as any).mockClear();
  hashPassword.mockImplementation(async (_pw: string) => "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g");
});

describe("ADR-012 — POST /auth/setup writes the argon2id hash to the directory", () => {
  it("hashes the password and stores the argon2id PHC string on the User row", async () => {
    const prisma = createPrismaMock();
    (nc.ncInstallAndCreateAdmin as any).mockImplementation(() => {
      prisma._callOrder.push("ncInstallAndCreateAdmin");
      return Promise.resolve();
    });
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({
        username: "owner1",
        password: "super-secret-pw",
        displayName: "The Owner",
        email: "owner@warp.test",
      });

    expect(res.status).toBe(200);
    expect(hashPassword).toHaveBeenCalledWith("super-secret-pw");

    const row = prisma._users[0];
    expect(row).toBeDefined();
    // The stored value is whatever password.service produced (an argon2id
    // PHC string in production) — the route writes the hash, not the
    // plaintext. The mock returns a fixed PHC-shaped string that does NOT
    // echo the plaintext, so we can assert the plaintext never lands.
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain("super-secret-pw");
    expect(JSON.stringify(row)).not.toContain("super-secret-pw");
  });

  it("persists the email as the stable login key when provided", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    await request(app)
      .post("/api/auth/setup")
      .send({
        username: "owner2",
        password: "another-secret",
        email: "owner2@warp.test",
      });

    expect(prisma._users[0].email).toBe("owner2@warp.test");
  });

  it("still provisions the Nextcloud admin downstream, after the local write", async () => {
    const prisma = createPrismaMock();
    (nc.ncInstallAndCreateAdmin as any).mockImplementation(() => {
      prisma._callOrder.push("ncInstallAndCreateAdmin");
      return Promise.resolve();
    });
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ username: "owner3", password: "third-secret", email: "owner3@warp.test" });

    expect(res.status).toBe(200);
    expect(nc.ncInstallAndCreateAdmin).toHaveBeenCalledWith(
      "owner3",
      "third-secret",
      undefined,
    );
    // Idempotent local write lands BEFORE the one-shot NC provisioning.
    expect(prisma._callOrder).toEqual(["user.upsert", "ncInstallAndCreateAdmin"]);
  });
});

describe("BLOCKER — /auth/setup normalizes the email login key (trim + lowercase)", () => {
  it("writes the email trim+lowercased so login can resolve it case-insensitively", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({
        username: "ownerMixed",
        password: "super-secret-pw",
        email: "  Foo@X.com  ",
      });

    expect(res.status).toBe(200);
    // Stored value is normalized — NOT the verbatim mixed-case input.
    expect(prisma._users[0].email).toBe("foo@x.com");
  });

  it("two casings of the same email converge to one normalized value → the plain unique index now catches the collision", async () => {
    // Seed an existing owner row that already holds the normalized email.
    // A second setup that supplies `Owner@X.com` must normalize to the
    // identical `owner@x.com`, which the (case-sensitive) unique index
    // rejects with P2002 — closing the pre-fix unique-bypass where
    // `owner@x` and `Owner@x` could co-exist.
    //
    // NOTE: this row carries role "family" (not "owner") so the N1
    // owner-guard does not short-circuit before the upsert — this test
    // isolates the normalization/collision behavior, not the guard.
    const prisma = createPrismaMock([
      {
        id: "u-existing",
        username: "existing",
        displayName: "Existing",
        email: "owner@x.com",
        nextcloudUsername: "existing",
        passwordHash: "$argon2id$existing",
        role: "family",
        isLocal: true,
      },
    ]);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({
        username: "newowner",
        password: "another-secret",
        email: "Owner@X.com",
      });

    // The collision surfaces as a server error (P2002 bubbles into the
    // setup catch → 500). The point of the assertion is that the second
    // write did NOT silently create a duplicate login identity.
    expect(res.status).toBe(500);
    // Still exactly one row holding that email — no duplicate minted.
    expect(
      prisma._users.filter((u: { email?: string | null }) => u.email === "owner@x.com"),
    ).toHaveLength(1);
  });
});

describe("N1 — /auth/setup refuses to rewrite/duplicate an existing owner", () => {
  it("returns 409 and does NOT touch the existing owner's hash when an owner already exists", async () => {
    const existingOwner = {
      id: "u-owner",
      username: "owner",
      displayName: "The Owner",
      email: "owner@warp.test",
      nextcloudUsername: "owner",
      passwordHash: "$argon2id$ORIGINAL-HASH",
      role: "owner",
      isLocal: true,
    };
    const prisma = createPrismaMock([existingOwner]);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({
        username: "attacker",
        password: "takeover-attempt",
        email: "attacker@warp.test",
      });

    expect(res.status).toBe(409);
    // No second owner minted, and the original hash is untouched
    // (account-takeover prevented).
    expect(prisma._users).toHaveLength(1);
    expect(prisma._users[0].passwordHash).toBe("$argon2id$ORIGINAL-HASH");
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    // Must short-circuit BEFORE the one-shot Nextcloud provisioning.
    expect(nc.ncInstallAndCreateAdmin).not.toHaveBeenCalled();
  });

  it("allows the first owner when none exists yet (count === 0 → proceeds)", async () => {
    const prisma = createPrismaMock(); // empty directory
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({
        username: "firstowner",
        password: "first-secret",
        email: "first@warp.test",
      });

    expect(res.status).toBe(200);
    expect(prisma._users).toHaveLength(1);
    expect(prisma._users[0].role).toBe("owner");
  });
});

describe("N2 — first owner cannot be created login-unable (email required at setup)", () => {
  it("rejects setup without an email with 400", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ username: "noemail", password: "no-email-secret" });

    expect(res.status).toBe(400);
    // The owner-creating write must not happen — a login-unable owner is
    // exactly the lockout ADR-012 forbids (no NC auth fallback).
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(nc.ncInstallAndCreateAdmin).not.toHaveBeenCalled();
  });
});
