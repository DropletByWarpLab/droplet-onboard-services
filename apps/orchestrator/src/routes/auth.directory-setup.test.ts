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
    agentMaxIter: { defaultIter: 5, capIter: 10 },
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
    ncEnsureGroup: vi.fn().mockResolvedValue(undefined),
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
import { authRateLimit } from "../middleware/rate-limit.js";
import * as nc from "../services/nextcloud.client.js";
import { config } from "../config.js";
import { readUserEmail } from "../services/user-directory.service.js";
import { emailLookupHash } from "../services/column-crypto.service.js";

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
      // Enforce the unique index exactly as Postgres would — WARP-233 moved
      // it to emailLookupHash (the deterministic blind index; GCM ciphertext
      // cannot carry uniqueness). Two casings of one address produce the
      // SAME hash, so the collision still trips P2002.
      if (
        create.emailLookupHash != null &&
        users.some((u) => u.emailLookupHash === create.emailLookupHash)
      ) {
        const e: any = new Error(
          'Unique constraint failed on the fields: ("emailLookupHash")',
        );
        e.code = "P2002";
        e.meta = { target: ["emailLookupHash"] };
        throw e;
      }
      const row = {
        id: create.id ?? `u-${users.length + 1}`,
        ...create,
      };
      users.push(row);
      return row;
    }),
    // WARP-989 — the atomic-rollback path deletes the just-created owner row
    // when Nextcloud provisioning fails. Generic field matcher over the seed
    // array; count mirrors Prisma's deleteMany result shape.
    deleteMany: vi.fn(async ({ where }: any = {}) => {
      callOrder.push("user.deleteMany");
      const before = users.length;
      for (let i = users.length - 1; i >= 0; i -= 1) {
        const matches = Object.entries(where ?? {}).every(
          ([k, v]) => users[i][k] === v,
        );
        if (matches) users.splice(i, 1);
      }
      return { count: before - users.length };
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

// CodeQL js/missing-rate-limiting sweep — the routes under test now carry the
// shared express-rate-limit presets (module singletons, MemoryStore keyed on
// req.ip). Every request in this file comes from supertest's loopback, which the
// limiter keys as "127.0.0.1" (`::ffff:127.0.0.1` from
// __tests__/supertest-loopback.setup.ts is IPv4-mapped, so ipKeyGenerator
// collapses it to the v4 form), so the file as a whole would exhaust the 20/min
// auth budget. Reset that one bucket before each test; no single test sends
// more than the budget, and the Redis lockouts under test are untouched.
const RATE_LIMIT_TEST_KEY = "127.0.0.1";

beforeEach(() => {
  authRateLimit.resetKey(RATE_LIMIT_TEST_KEY);

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

    // WARP-233: at rest the email is a dcv1 blob + blind index; the
    // plaintext round-trips through readUserEmail.
    expect(readUserEmail(prisma._users[0].email)).toBe("owner2@warp.test");
    expect(prisma._users[0].emailLookupHash).toBe(emailLookupHash("owner2@warp.test"));
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
    // WARP-1558: plus `droplet-admins` — the owner is admin-tier, and
    // ADR-029 §2.5 Tier-1 see-all is that group membership.
    expect(nc.ncInstallAndCreateAdmin).toHaveBeenCalledWith(
      "owner3",
      "Third-secret123",
      undefined,
      ["admin", "droplet-admins", "household"],
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
    expect(readUserEmail(prisma._users[0].email)).toBe("foo@x.com");
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
        // Post-backfill shape: the blind index carries the uniqueness
        // (encrypt-existing-phi-columns.ts populated it).
        email: "owner@x.com",
        emailLookupHash: emailLookupHash("owner@x.com"),
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
    const created = prisma._users.find(
      (u: any) => readUserEmail(u.email) === "owner@warp.test",
    );
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

/**
 * WARP-989 — POST /auth/setup must be ATOMIC.
 *
 * The local owner row is written before Nextcloud provisioning (idempotent
 * write first — the PR #279 ordering), but the N1 owner-exists guard turns a
 * leftover row into a permanent lockout: when ncInstallAndCreateAdmin failed
 * (live .87 incident: "OCS error creating user: Group household does not
 * exist"), the owner row survived, every retry answered 409 OWNER_EXISTS,
 * and the owner had NO Nextcloud account (all /api/files/* 401 forever).
 *
 * Coverage:
 *   1. NC provisioning failure → typed 500 SETUP_PROVISIONING_FAILED and the
 *      half-created local owner row is rolled back (deleted).
 *   2. A retry after that failure succeeds — no OWNER_EXISTS lockout.
 *   3. The household group is idempotently ensured BEFORE the owner is
 *      provisioned into it (the WARP-990 trigger prevention).
 *   4. A failed group-ensure alone is best-effort (never blocks a setup that
 *      would otherwise succeed).
 *   5. Worst case: even when the rollback itself fails, the typed error still
 *      reaches the client (never the misleading sign-in copy).
 */
describe("WARP-989 — /auth/setup is atomic (NC failure rolls back the local owner)", () => {
  it("NC failure → 500 SETUP_PROVISIONING_FAILED and the local owner row is NOT persisted", async () => {
    const prisma = createPrismaMock();
    (nc.ncInstallAndCreateAdmin as any).mockRejectedValueOnce(
      new Error("OCS error creating user: Group household does not exist"),
    );
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "Atomic-secret123", email: "owner@warp.test" });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("SETUP_PROVISIONING_FAILED");
    // The rollback targets exactly the row this request created.
    expect(prisma.user.deleteMany).toHaveBeenCalledWith({
      where: { nextcloudUsername: "owner", role: "owner" },
    });
    // No half-created owner row survives → no OWNER_EXISTS lockout.
    expect(prisma._users).toHaveLength(0);
  });

  it("a retry after an NC provisioning failure succeeds (no OWNER_EXISTS lockout)", async () => {
    const prisma = createPrismaMock();
    (nc.ncInstallAndCreateAdmin as any)
      .mockRejectedValueOnce(
        new Error("OCS error creating user: Group household does not exist"),
      )
      .mockResolvedValueOnce(undefined);
    const app = buildApp(prisma);

    const first = await request(app)
      .post("/api/auth/setup")
      .send({ password: "Atomic-secret123", email: "owner@warp.test" });
    expect(first.status).toBe(500);
    expect(first.body.code).toBe("SETUP_PROVISIONING_FAILED");

    // Pre-fix this answered 409 OWNER_EXISTS forever; now the wiped slate
    // lets the same request run to completion.
    const second = await request(app)
      .post("/api/auth/setup")
      .send({ password: "Atomic-secret123", email: "owner@warp.test" });
    expect(second.status).toBe(200);
    expect(prisma._users).toHaveLength(1);
    expect(prisma._users[0].role).toBe("owner");
  });

  it("idempotently ensures the household group exists BEFORE provisioning the owner into it", async () => {
    const prisma = createPrismaMock();
    (nc.ncEnsureGroup as any).mockImplementation(() => {
      prisma._callOrder.push("ncEnsureGroup");
      return Promise.resolve();
    });
    (nc.ncInstallAndCreateAdmin as any).mockImplementation(() => {
      prisma._callOrder.push("ncInstallAndCreateAdmin");
      return Promise.resolve();
    });
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "Group-secret1234", email: "owner@warp.test" });

    expect(res.status).toBe(200);
    // The mocked config lacks DROPLET_SHARED_FOLDER_NAME, so
    // householdGroupName() falls back to the canonical "household".
    expect(nc.ncEnsureGroup).toHaveBeenCalledWith("household");
    // WARP-1558: `droplet-admins` gets the same treatment — the owner's group
    // list now carries it, and OCS rejects the ENTIRE create-user call when
    // any listed group is missing. On a fresh appliance no department has been
    // provisioned yet, so nothing has lazily created this group: without the
    // ensure, adding it to the owner's list would break setup on every box.
    expect(nc.ncEnsureGroup).toHaveBeenCalledWith("droplet-admins");
    expect(prisma._callOrder).toEqual([
      "user.upsert",
      "ncEnsureGroup",
      "ncEnsureGroup",
      "ncInstallAndCreateAdmin",
    ]);
  });

  it("a failed group-ensure alone does NOT block setup (best-effort)", async () => {
    const prisma = createPrismaMock();
    (nc.ncEnsureGroup as any).mockRejectedValueOnce(
      new Error("OCS error creating group: boom"),
    );
    (nc.ncInstallAndCreateAdmin as any).mockResolvedValueOnce(undefined);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "Ensure-secret123", email: "owner@warp.test" });

    expect(res.status).toBe(200);
    expect(prisma._users).toHaveLength(1);
  });

  /**
   * WARP-1558 — the droplet-admins ensure carries the same best-effort
   * posture as the household one. It is a convenience that prevents a
   * predictable OCS rejection; it must never become a new way for setup to
   * die. (If the group is genuinely uncreatable, ncInstallAndCreateAdmin
   * fails on its own and the WARP-989 rollback keeps setup re-runnable.)
   */
  it("a failed droplet-admins ensure does NOT block setup either", async () => {
    const prisma = createPrismaMock();
    (nc.ncEnsureGroup as any).mockImplementation((group: string) =>
      group === "droplet-admins"
        ? Promise.reject(new Error("OCS 503"))
        : Promise.resolve(undefined),
    );
    (nc.ncInstallAndCreateAdmin as any).mockResolvedValueOnce(undefined);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "Admins-secret123", email: "owner@warp.test" });

    expect(res.status).toBe(200);
    expect(prisma._users).toHaveLength(1);
    // The owner was still provisioned WITH the group in their list — the
    // reconciler's membership sweep converges the membership either way.
    const groupsArg = (nc.ncInstallAndCreateAdmin as any).mock.calls[0][3] as string[];
    expect(groupsArg).toContain("droplet-admins");
  });

  it("worst case: rollback itself fails → the typed SETUP_PROVISIONING_FAILED still reaches the client", async () => {
    const prisma = createPrismaMock();
    (nc.ncInstallAndCreateAdmin as any).mockRejectedValueOnce(new Error("NC down"));
    prisma.user.deleteMany.mockRejectedValueOnce(new Error("db down"));
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "Worst-secret1234", email: "owner@warp.test" });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("SETUP_PROVISIONING_FAILED");
  });

  it("a non-NC setup failure carries the typed SETUP_FAILED code", async () => {
    const prisma = createPrismaMock();
    prisma.user.upsert.mockRejectedValueOnce(new Error("db down"));
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "Generic-secret12", email: "owner@warp.test" });

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("SETUP_FAILED");
  });
});
