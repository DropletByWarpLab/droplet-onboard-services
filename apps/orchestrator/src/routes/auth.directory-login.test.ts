/**
 * ADR-012 — built-in argon2id directory is the auth source of truth.
 *
 * POST /auth/login is inverted: it now validates the password LOCALLY
 * (argon2id verify on User.passwordHash, keyed by email) instead of
 * round-tripping Nextcloud OCS to authenticate. Nextcloud is demoted to
 * a downstream-provisioned WebDAV account — after a successful LOCAL
 * auth, we ensure/refresh the NC app-password session (provisioning, not
 * authentication), and an NC failure there does NOT fail the login.
 *
 * Coverage:
 *   1. Happy path: local argon2id verify passes → 200, JWT.sub === the
 *      local User.id UUID (WARP-485 preserved), cookies set.
 *   2. Auth is LOCAL: ncLoginWithCredentials is NOT used to authenticate
 *      (the directory hash is the gate). It MAY be called afterwards to
 *      provision the WebDAV session.
 *   3. Wrong password → 401 "Invalid credentials".
 *   4. Unknown email → identical 401 "Invalid credentials", AND an
 *      argon2id verify is still spent (anti-enumeration) — no DB user,
 *      no NC token stored.
 *   5. Account with a null passwordHash → identical 401 (no enumeration
 *      leak distinguishing "no account" from "account, no password").
 *   6. Nextcloud provisioning failure is non-fatal: login still 200s and
 *      issues the JWT (directory already authenticated).
 *   7. The wire error string + status are identical across the unknown-
 *      email and wrong-password branches (no enumeration oracle).
 *
 * Strategy mirrors auth.jwt-uuid.test.ts: drive the real route via
 * supertest, mock the NC client + nc-session helpers + password.service,
 * and use the in-memory Prisma mock.
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

const storeNcToken = vi.fn().mockResolvedValue(undefined);
const getNcToken = vi.fn().mockResolvedValue(null);
const deleteNcToken = vi.fn().mockResolvedValue(undefined);
const touchNcToken = vi.fn().mockResolvedValue(undefined);
const resolveNcToken = vi.fn().mockResolvedValue("test-nc-token");
vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: (...args: unknown[]) => storeNcToken(...args),
  getNcToken: (...args: unknown[]) => getNcToken(...args),
  deleteNcToken: (...args: unknown[]) => deleteNcToken(...args),
  touchNcToken: (...args: unknown[]) => touchNcToken(...args),
  resolveNcToken: (...args: unknown[]) => resolveNcToken(...args),
}));

// password.service is the argon2id boundary. Mock it so the test is fast
// and we can assert the login route calls verify (happy/wrong) and the
// anti-enumeration dummy verify (unknown email / null hash).
const verifyPassword = vi.fn();
const verifyDummyPassword = vi.fn().mockResolvedValue(false);
const hashPassword = vi.fn().mockResolvedValue("$argon2id$mock");
vi.mock("../services/password.service.js", () => ({
  verifyPassword: (...args: unknown[]) => verifyPassword(...args),
  verifyDummyPassword: (...args: unknown[]) => verifyDummyPassword(...args),
  hashPassword: (...args: unknown[]) => hashPassword(...args),
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
import { verifyAccessToken } from "../services/jwt.service.js";

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  nextcloudUsername: string | null;
  passwordHash: string | null;
  role: string;
  isLocal: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock(seed: UserRow[] = []) {
  const users: UserRow[] = [...seed];
  const self: any = {};
  self.user = {
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      if (where.email !== undefined) {
        return users.find((u) => u.email === where.email) ?? null;
      }
      if (where.nextcloudUsername !== undefined) {
        return users.find((u) => u.nextcloudUsername === where.nextcloudUsername) ?? null;
      }
      if (where.id !== undefined) {
        return users.find((u) => u.id === where.id) ?? null;
      }
      if (where.username !== undefined) {
        return users.find((u) => u.username === where.username) ?? null;
      }
      return null;
    }),
  };
  self._users = users;
  return self;
}

function buildApp(prismaMock: any) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createPublicAuthRouter(prismaMock));
  return app;
}

function decode(res: request.Response) {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const sessionCookie = cookies.find((c) => c?.startsWith("droplet_session="));
  if (!sessionCookie) throw new Error("droplet_session cookie not set");
  const raw = sessionCookie.split(";")[0]!.replace("droplet_session=", "");
  const decoded = verifyAccessToken(raw);
  if (!decoded) throw new Error("verifyAccessToken returned null");
  return decoded;
}

const stefan: UserRow = {
  id: "u-uuid-stefan-7777",
  username: "stefan",
  displayName: "Stefan Cruceru",
  email: "stefan@warp.test",
  nextcloudUsername: "stefan",
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$abc$def",
  role: "owner",
  isLocal: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  storeNcToken.mockResolvedValue(undefined);
  verifyDummyPassword.mockResolvedValue(false);
  (nc.ncLoginWithCredentials as any).mockResolvedValue({
    token: "nc-app-password",
    loginName: "stefan",
  });
});

describe("ADR-012 — POST /auth/login validates locally against the directory", () => {
  it("happy path: local argon2id verify passes → 200 + JWT.sub is the User.id UUID", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    const prisma = createPrismaMock([stefan]);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "correct-horse" });

    expect(res.status).toBe(200);
    // Verify ran against the stored hash, keyed by the email lookup.
    expect(verifyPassword).toHaveBeenCalledTimes(1);
    expect(verifyPassword).toHaveBeenCalledWith(stefan.passwordHash, "correct-horse");

    const decoded = decode(res);
    expect(decoded.sub).toBe("u-uuid-stefan-7777"); // WARP-485 UUID preserved
    expect(decoded.username).toBe("stefan");
    expect(decoded.role).toBe("owner");
    expect(res.body.user.id).toBe("u-uuid-stefan-7777");
  });

  it("does NOT authenticate via Nextcloud — the directory hash is the gate", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    const prisma = createPrismaMock([stefan]);
    const app = buildApp(prisma);

    await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "correct-horse" });

    // The NC token is still stored for downstream WebDAV (provisioning),
    // but the AUTH decision came from verifyPassword, never from a
    // pre-verify ncLoginWithCredentials gate. Assert verify drove it:
    // when verify fails, NC must never be consulted (see wrong-password
    // test) — proving NC is not the authenticator.
    expect(verifyPassword).toHaveBeenCalled();
    expect(storeNcToken).toHaveBeenCalledTimes(1);
    const [storedUserId] = storeNcToken.mock.calls[0]!;
    expect(storedUserId).toBe("u-uuid-stefan-7777"); // keyed by UUID
  });

  it("wrong password → 401 Invalid credentials, and Nextcloud is never consulted", async () => {
    verifyPassword.mockResolvedValueOnce(false);
    const prisma = createPrismaMock([stefan]);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
    expect(res.headers["set-cookie"]).toBeUndefined();
    // No NC provisioning + no token store on a failed local auth.
    expect(nc.ncLoginWithCredentials).not.toHaveBeenCalled();
    expect(storeNcToken).not.toHaveBeenCalled();
  });

  it("unknown email → 401 Invalid credentials, dummy verify spent (anti-enumeration), no NC token stored", async () => {
    const prisma = createPrismaMock([stefan]); // stefan exists, we ask for someone else
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@warp.test", password: "whatever" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
    // Real verify never runs (no row), but the dummy verify DOES — so the
    // wall-clock cost is comparable to the wrong-password branch.
    expect(verifyPassword).not.toHaveBeenCalled();
    expect(verifyDummyPassword).toHaveBeenCalledTimes(1);
    expect(storeNcToken).not.toHaveBeenCalled();
    expect(nc.ncLoginWithCredentials).not.toHaveBeenCalled();
  });

  it("account with null passwordHash → identical 401, dummy verify spent (no enumeration leak)", async () => {
    const noHash: UserRow = { ...stefan, id: "u-nohash", email: "nohash@warp.test", passwordHash: null };
    const prisma = createPrismaMock([noHash]);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nohash@warp.test", password: "whatever" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
    // Must spend a comparable verify even though there's no hash to check.
    expect(verifyDummyPassword).toHaveBeenCalledTimes(1);
    expect(storeNcToken).not.toHaveBeenCalled();
  });

  it("Nextcloud provisioning failure is non-fatal — login still 200s", async () => {
    verifyPassword.mockResolvedValueOnce(true);
    // Downstream NC session refresh fails (Nextcloud down / not yet
    // provisioned). The directory already authenticated, so the login
    // must still succeed and issue the JWT.
    (nc.ncLoginWithCredentials as any).mockResolvedValueOnce(null);
    const prisma = createPrismaMock([stefan]);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "correct-horse" });

    expect(res.status).toBe(200);
    const decoded = decode(res);
    expect(decoded.sub).toBe("u-uuid-stefan-7777");
  });

  it("mixed-case email at login resolves the normalized stored row (case-insensitive login)", async () => {
    // BLOCKER regression: the directory stores the normalized (lowercased)
    // email. A login that types the address with different casing must
    // still resolve the same row — otherwise the owner who set up with
    // `Foo@X.com` is locked out when they later sign in as `foo@x.com`
    // (ADR-012 removed the Nextcloud auth fallback, so there's no recovery
    // short of a DB edit).
    verifyPassword.mockResolvedValueOnce(true);
    const normalized: UserRow = {
      ...stefan,
      id: "u-uuid-foo",
      username: "foo",
      email: "foo@x.com", // stored normalized
    };
    const prisma = createPrismaMock([normalized]);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "  Foo@X.com  ", password: "correct-horse" });

    expect(res.status).toBe(200);
    // The lookup value handed to Prisma must be trim+lowercased so it
    // matches the normalized stored row.
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "foo@x.com" },
    });
    expect(verifyPassword).toHaveBeenCalledWith(normalized.passwordHash, "correct-horse");
    const decoded = decode(res);
    expect(decoded.sub).toBe("u-uuid-foo");
  });

  it("normalizes the legacy `username`-carried identifier the same way", async () => {
    // A client mid-rollout still sends the address under `username`. That
    // path feeds the same `loginEmail` lookup and must normalize identically.
    verifyPassword.mockResolvedValueOnce(true);
    const normalized: UserRow = {
      ...stefan,
      id: "u-uuid-foo2",
      username: "foo2",
      email: "foo2@x.com",
    };
    const prisma = createPrismaMock([normalized]);
    const app = buildApp(prisma);

    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "FOO2@X.COM", password: "correct-horse" });

    expect(res.status).toBe(200);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "foo2@x.com" },
    });
  });

  it("unknown-email and wrong-password branches are wire-indistinguishable", async () => {
    // Wrong password against an existing account.
    verifyPassword.mockResolvedValueOnce(false);
    const prismaA = createPrismaMock([stefan]);
    const wrongPw = await request(buildApp(prismaA))
      .post("/api/auth/login")
      .send({ email: "stefan@warp.test", password: "wrong" });

    // Unknown email entirely.
    const prismaB = createPrismaMock([stefan]);
    const unknown = await request(buildApp(prismaB))
      .post("/api/auth/login")
      .send({ email: "ghost@warp.test", password: "whatever" });

    expect(wrongPw.status).toBe(unknown.status);
    expect(wrongPw.body).toEqual(unknown.body);
  });
});
