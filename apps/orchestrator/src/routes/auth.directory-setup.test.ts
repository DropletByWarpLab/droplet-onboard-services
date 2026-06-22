/**
 * ADR-013 — account creation writes the argon2id hash to the directory.
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
    // WARP-165 — default OFF; individual gate tests flip this on the mutable
    // mock object. Default-off keeps every existing /auth/setup test (above)
    // on the un-gated path with no claimCode field.
    DROPLET_CLAIM_GATE_ENABLED: false,
  },
}));

// WARP-165 — control the read-only physical-presence verify so the gate tests
// don't need a seeded ClaimCode row. The real primitive is unit-tested in
// setup-claim.service.test.ts; here we only assert the ROUTE wires it correctly
// (enabled→required+verified, disabled→untouched, ordered AFTER the N1 guard).
const verifyClaimCodePresence = vi.fn(async (_p: unknown, _c: string) => true);
vi.mock("../services/setup-claim.service.js", () => ({
  verifyClaimCodePresence: (...args: unknown[]) =>
    verifyClaimCodePresence(...(args as [unknown, string])),
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
import { config } from "../config.js";

function createPrismaMock(seed: any[] = []) {
  const users: any[] = [...seed];
  const callOrder: string[] = [];
  const self: any = {};
  self.user = {
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
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
  // WARP-165 — reset the gate to OFF + verify-true between tests so a gate
  // test can't leak its flag/stub into the un-gated suite above.
  (config as any).DROPLET_CLAIM_GATE_ENABLED = false;
  verifyClaimCodePresence.mockImplementation(async () => true);
});

describe("ADR-013 — POST /auth/setup writes the argon2id hash to the directory", () => {
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
        password: "Super-secret-pw1",
        displayName: "The Owner",
        email: "owner@warp.test",
      });

    expect(res.status).toBe(200);
    expect(hashPassword).toHaveBeenCalledWith("Super-secret-pw1");

    const row = prisma._users[0];
    expect(row).toBeDefined();
    // The stored value is whatever password.service produced (an argon2id
    // PHC string in production) — the route writes the hash, not the
    // plaintext. The mock returns a fixed PHC-shaped string that does NOT
    // echo the plaintext, so we can assert the plaintext never lands.
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain("Super-secret-pw1");
    expect(JSON.stringify(row)).not.toContain("Super-secret-pw1");
  });

  it("persists the email as the stable login key when provided", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    await request(app)
      .post("/api/auth/setup")
      .send({
        password: "Another-secret1",
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
      .send({ password: "Third-secret123", email: "owner3@warp.test" });

    expect(res.status).toBe(200);
    // WARP-883: the owner is provisioned into the "admin" role group AND the
    // household group so the shared "Household" groupfolder mounts for them.
    // (The mocked config here lacks DROPLET_SHARED_FOLDER_NAME, so
    // householdGroupName() falls back to its canonical "household" default.)
    expect(nc.ncInstallAndCreateAdmin).toHaveBeenCalledWith(
      "owner3",
      "Third-secret123",
      undefined,
      ["admin", "household"],
    );
    // Idempotent local write lands BEFORE the one-shot NC provisioning.
    expect(prisma._callOrder).toEqual(["user.upsert", "ncInstallAndCreateAdmin"]);
  });
});

describe("WARP-883 — /auth/setup adds the owner to the household group", () => {
  it("provisions the owner into the household group (not just 'admin') so the shared space mounts", async () => {
    const prisma = createPrismaMock(); // empty directory → genuine first owner
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "Owner-secret123", email: "owner@warp.test" });

    expect(res.status).toBe(200);
    // The owner-provisioning call MUST include the household group. Without it
    // the primary owner is in neither the literal "admin" nor the household
    // group → GET /api/files/spaces returns sharedAvailable:false for them and
    // the SpaceSwitcher never appears (the QA finding this guards against).
    expect(nc.ncInstallAndCreateAdmin).toHaveBeenCalledTimes(1);
    const groupsArg = (nc.ncInstallAndCreateAdmin as any).mock.calls[0][3] as string[];
    expect(groupsArg).toContain("household");
    // The owner keeps their existing Nextcloud "admin" group too.
    expect(groupsArg).toContain("admin");
    // No duplicate household entry.
    expect(groupsArg.filter((g) => g === "household")).toHaveLength(1);
  });
});

describe("BLOCKER — /auth/setup normalizes the email login key (trim + lowercase)", () => {
  it("writes the email trim+lowercased so login can resolve it case-insensitively", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({
        password: "Super-secret-pw1",
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
        password: "Another-secret1",
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
        password: "Takeover-attempt1",
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
        password: "First-secret123",
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
      .send({ password: "No-email-secret1" });

    expect(res.status).toBe(400);
    // The owner-creating write must not happen — a login-unable owner is
    // exactly the lockout ADR-013 forbids (no NC auth fallback).
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(nc.ncInstallAndCreateAdmin).not.toHaveBeenCalled();
  });

  it("rejects a setup whose password is below the policy with WEAK_PASSWORD", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ email: "weak@warp.test", password: "short1A" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("WEAK_PASSWORD");
    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("derives a unique userid when the base is already taken", async () => {
    const prisma = createPrismaMock([
      { id: "u1", username: "owner", nextcloudUsername: "owner", email: "x@y.z", role: "family" },
    ]);
    prisma.user.findFirst = vi.fn(async ({ where }: any) => {
      const c = where.OR?.[0]?.username;
      return prisma._users.find((u: any) => u.username === c || u.nextcloudUsername === c) ?? null;
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ email: "owner@warp.test", password: "Owner-secret123" });
    expect(res.status).toBe(200);
    const created = prisma._users.find((u: any) => u.email === "owner@warp.test");
    expect(created.username).toBe("owner-2");
    expect(created.nextcloudUsername).toBe("owner-2");
  });
});

/**
 * WARP-165 — physical-presence claim gate on POST /auth/setup.
 *
 * When DROPLET_CLAIM_GATE_ENABLED is ON, the first-owner request must carry the
 * front-panel claim code, verified READ-ONLY (verifyClaimCodePresence — never
 * consumed, so the cloud-bind step's consume lifecycle is untouched). The gate
 * is positioned AFTER the N1 owner-exists guard so a dropped-response retry
 * after a successful setup hits the benign 409 OWNER_EXISTS, NOT a new claim
 * 403 (the finding-#2 regression we must not reintroduce). When OFF, the route
 * behaves exactly as on main — no claim field required.
 */
describe("WARP-165 — /auth/setup physical-presence claim gate", () => {
  it("gate OFF (default): setup succeeds with NO claim code and never verifies", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ email: "owner@warp.test", password: "Gate-off-secret1" });

    expect(res.status).toBe(200);
    expect(prisma._users).toHaveLength(1);
    // The verify primitive is never even consulted on the un-gated path.
    expect(verifyClaimCodePresence).not.toHaveBeenCalled();
  });

  it("gate ON + missing claim code → 403 CLAIM_CODE_REQUIRED, no owner created", async () => {
    (config as any).DROPLET_CLAIM_GATE_ENABLED = true;
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ email: "owner@warp.test", password: "Gate-on-secret1" });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CLAIM_CODE_REQUIRED");
    // No side effects: no owner row, no Nextcloud provisioning.
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(nc.ncInstallAndCreateAdmin).not.toHaveBeenCalled();
  });

  it("gate ON + WRONG claim code → 403 CLAIM_CODE_INVALID, no owner created", async () => {
    (config as any).DROPLET_CLAIM_GATE_ENABLED = true;
    verifyClaimCodePresence.mockImplementation(async () => false);
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({
        email: "owner@warp.test",
        password: "Gate-on-secret1",
        claimCode: "DRPL-WRON-GGGG",
      });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CLAIM_CODE_INVALID");
    expect(verifyClaimCodePresence).toHaveBeenCalledWith(prisma, "DRPL-WRON-GGGG");
    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(nc.ncInstallAndCreateAdmin).not.toHaveBeenCalled();
    // The 403 body must never echo the submitted/real code (secret-in-logs gate).
    expect(JSON.stringify(res.body)).not.toContain("WRON");
  });

  it("gate ON + CORRECT claim code → setup succeeds and owner is created", async () => {
    (config as any).DROPLET_CLAIM_GATE_ENABLED = true;
    verifyClaimCodePresence.mockImplementation(async () => true);
    const prisma = createPrismaMock();
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({
        email: "owner@warp.test",
        password: "Gate-on-secret1",
        claimCode: "DRPL-7K2Q-9F4M",
      });

    expect(res.status).toBe(200);
    expect(prisma._users).toHaveLength(1);
    expect(prisma._users[0].role).toBe("owner");
    expect(verifyClaimCodePresence).toHaveBeenCalledWith(prisma, "DRPL-7K2Q-9F4M");
  });

  it("dropped-retry: gate ON, owner already exists → 409 OWNER_EXISTS, NOT a claim 403", async () => {
    // The genuine first-owner-creation succeeded but its response was dropped;
    // the client retries. With the gate ON this must NOT surface a new claim
    // 403 — it must hit the benign owner-exists path (finding #2). The N1
    // guard runs BEFORE the claim gate, so the claim code isn't even consulted.
    (config as any).DROPLET_CLAIM_GATE_ENABLED = true;
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

    // Retry WITHOUT a claim code (a naive client retry of the original body).
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ email: "owner@warp.test", password: "Gate-on-secret1" });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("OWNER_EXISTS");
    // The claim gate must be short-circuited by the earlier N1 guard.
    expect(verifyClaimCodePresence).not.toHaveBeenCalled();
    // The original owner is untouched.
    expect(prisma._users).toHaveLength(1);
    expect(prisma._users[0].passwordHash).toBe("$argon2id$ORIGINAL-HASH");
  });
});
