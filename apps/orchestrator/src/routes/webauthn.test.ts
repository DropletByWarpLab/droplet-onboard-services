/**
 * PR #377 (WARP-___) — WebAuthn / passkey routes.
 *
 * Drives the four real routes via supertest, mocking the @simplewebauthn/server
 * crypto boundary (the library has its own tests for attestation/assertion
 * verification) and the challenge store. What we assert is OUR orchestration:
 *
 *   Registration (protected — requires a signed-in user):
 *     - POST /auth/webauthn/register/options mints a challenge bound to the
 *       user and returns the library options.
 *     - POST /auth/webauthn/register/verify consumes the challenge, verifies
 *       the attestation, and PERSISTS the credential (credentialId, publicKey,
 *       counter, transports) keyed to User.id.
 *     - A missing/expired challenge → 400, no credential written.
 *     - A failed attestation → 400, no credential written.
 *
 *   Authentication (public — passwordless; issues the session):
 *     - POST /auth/webauthn/authenticate/options mints an anonymous challenge.
 *     - POST /auth/webauthn/authenticate/verify consumes the challenge,
 *       verifies the assertion against the stored credential, UPDATES the
 *       signature counter, and issues the cookie session (JWT.sub === User.id),
 *       mirroring POST /auth/login.
 *     - An unknown credential → 401, no session.
 *     - A counter regression (clone) → the library rejects; route → 401, the
 *       stored counter is NOT advanced.
 *
 * Security posture mirrors auth.directory-login.test.ts: same JWT decode of the
 * session cookie, same in-memory Prisma mock shape.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import cookieParser from "cookie-parser";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    AUTH_MODE: "legacy",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    REDIS_URL: "redis://localhost:6379",
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

// @simplewebauthn/server — the crypto boundary. Mocked so the test exercises
// the route's orchestration, not WebAuthn attestation math.
const generateRegistrationOptions = vi.fn();
const verifyRegistrationResponse = vi.fn();
const generateAuthenticationOptions = vi.fn();
const verifyAuthenticationResponse = vi.fn();
vi.mock("@simplewebauthn/server", () => ({
  generateRegistrationOptions: (...a: unknown[]) => generateRegistrationOptions(...a),
  verifyRegistrationResponse: (...a: unknown[]) => verifyRegistrationResponse(...a),
  generateAuthenticationOptions: (...a: unknown[]) => generateAuthenticationOptions(...a),
  verifyAuthenticationResponse: (...a: unknown[]) => verifyAuthenticationResponse(...a),
}));

// Challenge store — unit-tested separately. Here we stub it to assert the
// route mints (register) and consumes (verify) challenges for the right
// ceremony, and to drive the missing/expired-challenge branch.
const createChallenge = vi.fn();
const consumeChallenge = vi.fn();
vi.mock("../services/webauthn-challenge.service.js", () => ({
  createChallenge: (...a: unknown[]) => createChallenge(...a),
  consumeChallenge: (...a: unknown[]) => consumeChallenge(...a),
  WEBAUTHN_CHALLENGE_TTL_MS: 300000,
}));

// The per-IP limiters would share one bucket across every supertest call in
// this file (all from 127.0.0.1); throttling has its own tests.
vi.mock("../middleware/rate-limit.js", () => {
  const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
  return { authRateLimit: passThrough, sensitiveRateLimit: passThrough, standardRateLimit: passThrough };
});

const recordActivity = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => recordActivity(...a),
}));

import {
  createPublicWebAuthnRouter,
  createProtectedWebAuthnRouter,
} from "./webauthn.js";
import { verifyAccessToken } from "../services/jwt.service.js";

interface CredentialRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Buffer;
  counter: number;
  transports: string | null;
  name?: string | null;
  rpId?: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
  /** ORCH-02: SCIM soft-disable. Absent = ACTIVE (matches schema default). */
  directoryStatus?: string;
}

function createPrismaMock(opts: { users?: UserRow[]; credentials?: CredentialRow[] } = {}) {
  const users = [...(opts.users ?? [])];
  const credentials = [...(opts.credentials ?? [])];
  let seq = 0;
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) return users.find((u) => u.id === where.id) ?? null;
        if (where.email) return users.find((u) => u.email === where.email) ?? null;
        return null;
      }),
    },
    webAuthnCredential: {
      findUnique: vi.fn(async ({ where }: { where: { credentialId: string } }) =>
        credentials.find((c) => c.credentialId === where.credentialId) ?? null,
      ),
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        credentials.filter((c) => c.userId === where.userId),
      ),
      create: vi.fn(async ({ data }: { data: Omit<CredentialRow, "id" | "createdAt" | "lastUsedAt"> }) => {
        const row: CredentialRow = {
          id: `cred-${++seq}`,
          createdAt: new Date(),
          lastUsedAt: null,
          ...data,
        };
        credentials.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<CredentialRow> }) => {
        const row = credentials.find((c) => c.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; userId: string }; data: Partial<CredentialRow> }) => {
          const rows = credentials.filter((c) => c.id === where.id && c.userId === where.userId);
          rows.forEach((r) => Object.assign(r, data));
          return { count: rows.length };
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { id: string; userId: string } }) => {
        const before = credentials.length;
        for (let i = credentials.length - 1; i >= 0; i--) {
          if (credentials[i]!.id === where.id && credentials[i]!.userId === where.userId) {
            credentials.splice(i, 1);
          }
        }
        return { count: before - credentials.length };
      }),
    },
  } as unknown as import("@prisma/client").PrismaClient;
  return { prisma, users, credentials };
}

const stefan: UserRow = {
  id: "u-uuid-stefan-7777",
  username: "stefan",
  displayName: "Stefan Cruceru",
  email: "stefan@warp.test",
  role: "owner",
};

/** supertest sends `Host: 127.0.0.1:<port>` — an IP, which the routes refuse
 *  as an RP ID (WARP-1157). Stand in the box's LAN name unless a test sets
 *  x-forwarded-host itself to exercise that refusal. */
const lanHost: express.RequestHandler = (req, _res, next) => {
  req.headers.host = "droplet-ai.local";
  next();
};

/** Build an app with the PUBLIC webauthn router (no auth middleware). */
function buildPublicApp(prisma: import("@prisma/client").PrismaClient) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(lanHost);
  app.use("/api", createPublicWebAuthnRouter(prisma));
  return app;
}

/** Build an app with the PROTECTED webauthn router behind a fake auth shim
 *  that injects req.user (mirrors how authMiddleware populates it). */
function buildProtectedApp(
  prisma: import("@prisma/client").PrismaClient,
  user: { id: string; username: string; displayName: string; role: string } | null,
) {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(lanHost);
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user: typeof user }).user = user;
    next();
  });
  app.use("/api", createProtectedWebAuthnRouter(prisma));
  return app;
}

const CHALLENGE = "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa";

/** Build a ceremony response whose clientDataJSON encodes the given challenge,
 *  the way the browser does. The route reads the challenge out of here before
 *  consuming the store row. */
function ceremonyResponse(credentialId: string, challenge = CHALLENGE) {
  const clientData = { type: "webauthn.get", challenge, origin: "http://droplet.local" };
  const clientDataJSON = Buffer.from(JSON.stringify(clientData), "utf8").toString("base64url");
  return {
    id: credentialId,
    rawId: credentialId,
    type: "public-key",
    response: { clientDataJSON },
  };
}

function sessionFromCookie(res: request.Response) {
  const setCookie = res.headers["set-cookie"];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  const sessionCookie = cookies.find((c) => c?.startsWith("droplet_session="));
  if (!sessionCookie) throw new Error("droplet_session cookie not set");
  const raw = sessionCookie.split(";")[0]!.replace("droplet_session=", "");
  const decoded = verifyAccessToken(raw);
  if (!decoded) throw new Error("verifyAccessToken returned null");
  return decoded;
}

beforeEach(() => {
  vi.clearAllMocks();
  createChallenge.mockResolvedValue("mock-challenge-aaaaaaaaaaaaaaaaaaaaaa");
});

describe("WebAuthn registration (protected) — POST /auth/webauthn/register/*", () => {
  it("options: requires a signed-in user (401 when anonymous)", async () => {
    const { prisma } = createPrismaMock({ users: [stefan] });
    const res = await request(buildProtectedApp(prisma, null)).post(
      "/api/auth/webauthn/register/options",
    );
    expect(res.status).toBe(401);
    expect(createChallenge).not.toHaveBeenCalled();
  });

  it("options: mints a REGISTRATION challenge bound to the user and returns library options", async () => {
    const { prisma } = createPrismaMock({ users: [stefan] });
    generateRegistrationOptions.mockResolvedValue({
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      rp: { name: "Droplet", id: "droplet.local" },
      user: { id: "x", name: "stefan", displayName: "Stefan Cruceru" },
      pubKeyCredParams: [],
    });

    const res = await request(buildProtectedApp(prisma, stefan)).post(
      "/api/auth/webauthn/register/options",
    );

    expect(res.status).toBe(200);
    expect(createChallenge).toHaveBeenCalledTimes(1);
    const [, arg] = createChallenge.mock.calls[0]!;
    expect(arg).toMatchObject({ type: "REGISTRATION", userId: "u-uuid-stefan-7777" });
    expect(res.body.challenge).toBe("mock-challenge-aaaaaaaaaaaaaaaaaaaaaa");
  });

  it("verify: consumes the challenge, verifies attestation, persists the credential keyed to User.id", async () => {
    const { prisma, credentials } = createPrismaMock({ users: [stefan] });
    consumeChallenge.mockResolvedValue({
      id: "c-1",
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      type: "REGISTRATION",
      userId: "u-uuid-stefan-7777",
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    verifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: "cred-id-b64url",
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: ["internal", "hybrid"],
        },
      },
    });

    const res = await request(buildProtectedApp(prisma, stefan))
      .post("/api/auth/webauthn/register/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    // Challenge consumed for the REGISTRATION ceremony.
    expect(consumeChallenge).toHaveBeenCalledWith(
      expect.anything(),
      "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      "REGISTRATION",
    );
    // Credential persisted, keyed to the user, with the lib's fields mapped.
    expect(credentials).toHaveLength(1);
    const cred = credentials[0]!;
    expect(cred.userId).toBe("u-uuid-stefan-7777");
    expect(cred.credentialId).toBe("cred-id-b64url");
    expect(cred.counter).toBe(0);
    expect(cred.transports).toBe("internal,hybrid");
    expect(Buffer.isBuffer(cred.publicKey)).toBe(true);
  });

  it("verify: missing/expired challenge → 400, no credential written", async () => {
    const { prisma, credentials } = createPrismaMock({ users: [stefan] });
    consumeChallenge.mockResolvedValue(null); // expired / unknown

    const res = await request(buildProtectedApp(prisma, stefan))
      .post("/api/auth/webauthn/register/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });

    expect(res.status).toBe(400);
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
    expect(credentials).toHaveLength(0);
  });

  it("verify: failed attestation → 400, no credential written", async () => {
    const { prisma, credentials } = createPrismaMock({ users: [stefan] });
    consumeChallenge.mockResolvedValue({
      id: "c-1",
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      type: "REGISTRATION",
      userId: "u-uuid-stefan-7777",
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    verifyRegistrationResponse.mockResolvedValue({ verified: false });

    const res = await request(buildProtectedApp(prisma, stefan))
      .post("/api/auth/webauthn/register/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });

    expect(res.status).toBe(400);
    expect(credentials).toHaveLength(0);
  });
});

describe("WebAuthn authentication (public, passwordless) — POST /auth/webauthn/authenticate/*", () => {
  const credential: CredentialRow = {
    id: "cred-1",
    userId: "u-uuid-stefan-7777",
    credentialId: "cred-id-b64url",
    publicKey: Buffer.from([1, 2, 3, 4]),
    counter: 5,
    transports: "internal",
    createdAt: new Date(),
    lastUsedAt: null,
  };

  it("options: mints an anonymous AUTHENTICATION challenge (no user required)", async () => {
    const { prisma } = createPrismaMock();
    generateAuthenticationOptions.mockResolvedValue({
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      rpId: "droplet.local",
      allowCredentials: [],
    });

    const res = await request(buildPublicApp(prisma)).post(
      "/api/auth/webauthn/authenticate/options",
    );

    expect(res.status).toBe(200);
    expect(createChallenge).toHaveBeenCalledTimes(1);
    const [, arg] = createChallenge.mock.calls[0]!;
    expect(arg).toMatchObject({ type: "AUTHENTICATION", userId: null });
    expect(res.body.challenge).toBe("mock-challenge-aaaaaaaaaaaaaaaaaaaaaa");
  });

  it("verify: consumes challenge, verifies assertion, advances counter, issues the session", async () => {
    const { prisma, credentials } = createPrismaMock({
      users: [stefan],
      credentials: [{ ...credential }],
    });
    consumeChallenge.mockResolvedValue({
      id: "c-1",
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      type: "AUTHENTICATION",
      userId: null,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });

    const res = await request(buildPublicApp(prisma))
      .post("/api/auth/webauthn/authenticate/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });

    expect(res.status).toBe(200);
    expect(consumeChallenge).toHaveBeenCalledWith(
      expect.anything(),
      "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      "AUTHENTICATION",
    );
    // Counter advanced to the verified newCounter.
    expect(credentials[0]!.counter).toBe(6);
    // Session issued — JWT.sub is the User.id UUID (mirrors /auth/login).
    const decoded = sessionFromCookie(res);
    expect(decoded.sub).toBe("u-uuid-stefan-7777");
    expect(decoded.role).toBe("owner");
    expect(res.body.user.id).toBe("u-uuid-stefan-7777");
  });

  it("verify: unknown credential → 401, no session, assertion never verified", async () => {
    const { prisma } = createPrismaMock({ users: [stefan], credentials: [] });
    consumeChallenge.mockResolvedValue({
      id: "c-1",
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      type: "AUTHENTICATION",
      userId: null,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });

    const res = await request(buildPublicApp(prisma))
      .post("/api/auth/webauthn/authenticate/verify")
      .send({ response: ceremonyResponse("ghost-credential") });

    expect(res.status).toBe(401);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("verify: ?return=body from a native client (no browser markers) returns tokens in the body (WARP-582)", async () => {
    const { prisma } = createPrismaMock({
      users: [stefan],
      credentials: [{ ...credential }],
    });
    consumeChallenge.mockResolvedValue({
      id: "c-1",
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      type: "AUTHENTICATION",
      userId: null,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });

    const res = await request(buildPublicApp(prisma))
      .post("/api/auth/webauthn/authenticate/verify?return=body")
      .send({ response: ceremonyResponse("cred-id-b64url") });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
  });

  it("verify: ?return=body from a BROWSER context (Origin present) issues the cookie session but NO body tokens (WARP-582)", async () => {
    const { prisma } = createPrismaMock({
      users: [stefan],
      credentials: [{ ...credential }],
    });
    consumeChallenge.mockResolvedValue({
      id: "c-1",
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      type: "AUTHENTICATION",
      userId: null,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });

    const res = await request(buildPublicApp(prisma))
      .post("/api/auth/webauthn/authenticate/verify?return=body")
      .set("origin", "https://droplet-ai.local")
      .set("sec-fetch-mode", "cors")
      .send({ response: ceremonyResponse("cred-id-b64url") });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    // The browser still gets its normal cookie session.
    const decoded = sessionFromCookie(res);
    expect(decoded.sub).toBe("u-uuid-stefan-7777");
  });

  it("verify: directory-DEACTIVATED user is rejected (401), no session, even with a valid passkey (ORCH-02)", async () => {
    // Offboarded user: SCIM set active:false → directoryStatus DEACTIVATED, a
    // SOFT disable that retains the row AND the registered passkey. The
    // assertion verifies cleanly, but the deactivation gate must still deny —
    // parity with /auth/login and SSO, closing the third-login-path hole.
    const deactivated: UserRow = { ...stefan, directoryStatus: "DEACTIVATED" };
    const { prisma, credentials } = createPrismaMock({
      users: [deactivated],
      credentials: [{ ...credential }],
    });
    consumeChallenge.mockResolvedValue({
      id: "c-1",
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      type: "AUTHENTICATION",
      userId: null,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });

    const res = await request(buildPublicApp(prisma))
      .post("/api/auth/webauthn/authenticate/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid credentials");
    // No session minted…
    expect(res.headers["set-cookie"]).toBeUndefined();
    // …a warn-level denial IS recorded (audit parity with the password
    // path's denyInvalid — a deactivated user probing via passkey must leave
    // the same trail), but never a success activity.
    expect(recordActivity).toHaveBeenCalledTimes(1);
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "warn",
        refs: expect.objectContaining({
          outcome: "invalid_credentials",
          method: "webauthn",
        }),
      }),
    );
    // Counter is NOT advanced — the credential update is deferred until after
    // the deactivation gate, so a blocked attempt leaves state untouched
    // (parity with the clone-rejection path). Starts and stays at 5.
    expect(credentials[0]!.counter).toBe(5);
  });

  it("verify: counter regression (clone) → 401 and the stored counter is NOT advanced", async () => {
    const { prisma, credentials } = createPrismaMock({
      users: [stefan],
      credentials: [{ ...credential, counter: 10 }],
    });
    consumeChallenge.mockResolvedValue({
      id: "c-1",
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      type: "AUTHENTICATION",
      userId: null,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    // The library throws when the asserted counter is <= the stored counter
    // (clone detection). The route must surface 401 and leave the row intact.
    verifyAuthenticationResponse.mockRejectedValue(
      new Error("Response counter value 9 was lower than expected 10"),
    );

    const res = await request(buildPublicApp(prisma))
      .post("/api/auth/webauthn/authenticate/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });

    expect(res.status).toBe(401);
    expect(credentials[0]!.counter).toBe(10); // unchanged
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("verify: missing/expired challenge → 400 before any assertion work", async () => {
    const { prisma } = createPrismaMock({ users: [stefan], credentials: [{ ...credential }] });
    consumeChallenge.mockResolvedValue(null);

    const res = await request(buildPublicApp(prisma))
      .post("/api/auth/webauthn/authenticate/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });

    expect(res.status).toBe(400);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  // WARP-1160 — the audit-row IP must come from proxy-aware `req.ip` (the
  // auth.ts callerIpFromReq standard, WARP-579), never the raw
  // client-controlled X-Forwarded-For header: the old derivation recorded
  // whatever IP the caller chose to claim in every WebAuthn audit row.
  it("verify: audit row records the socket-derived IP, ignoring a forged X-Forwarded-For (WARP-1160)", async () => {
    const { prisma } = createPrismaMock({ users: [stefan], credentials: [{ ...credential }] });
    consumeChallenge.mockResolvedValue({
      id: "c-1",
      challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
      type: "AUTHENTICATION",
      userId: null,
      expiresAt: new Date(Date.now() + 60000),
      createdAt: new Date(),
    });
    verifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });

    const res = await request(buildPublicApp(prisma))
      .post("/api/auth/webauthn/authenticate/verify")
      .set("X-Forwarded-For", "6.6.6.6")
      .send({ response: ceremonyResponse("cred-id-b64url") });

    expect(res.status).toBe(200);
    expect(recordActivity).toHaveBeenCalledTimes(1);
    const activity = recordActivity.mock.calls[0]![0] as {
      sub: string;
      refs: { ip: string | null };
    };
    // Supertest connects over loopback; the recorded IP is the socket-derived
    // address, never the attacker-claimed 6.6.6.6.
    expect(activity.refs.ip).toBe("::ffff:127.0.0.1");
    expect(activity.sub).not.toContain("6.6.6.6");
  });
});

// =====================================================================
// WARP-1157 — secure-origin refusal, coded errors, and the passkey list.
// =====================================================================
describe("WARP-1157 — honest refusals and coded errors", () => {
  const liveChallenge = {
    id: "c-1",
    challenge: "mock-challenge-aaaaaaaaaaaaaaaaaaaaaa",
    type: "REGISTRATION",
    userId: "u-uuid-stefan-7777",
    expiresAt: new Date(Date.now() + 60000),
    createdAt: new Date(),
  };
  const verifiedAttestation = {
    verified: true,
    registrationInfo: {
      credential: { id: "cred-id-b64url", publicKey: new Uint8Array([1]), counter: 0, transports: [] },
    },
  };

  it("register/options on a raw IP → 400 origin_unsupported, no challenge minted", async () => {
    const { prisma } = createPrismaMock({ users: [stefan] });
    const res = await request(buildProtectedApp(prisma, stefan))
      .post("/api/auth/webauthn/register/options")
      .set("X-Forwarded-Host", "192.168.9.195");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("origin_unsupported");
    expect(createChallenge).not.toHaveBeenCalled();
  });

  it("authenticate/options on an IPv6 literal → 400 origin_unsupported", async () => {
    const { prisma } = createPrismaMock();
    const res = await request(buildPublicApp(prisma))
      .post("/api/auth/webauthn/authenticate/options")
      .set("X-Forwarded-Host", "[fe80::1]:443");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("origin_unsupported");
    expect(createChallenge).not.toHaveBeenCalled();
  });

  it("register/verify records the RP ID the passkey was made on", async () => {
    const { prisma, credentials } = createPrismaMock({ users: [stefan] });
    consumeChallenge.mockResolvedValue(liveChallenge);
    verifyRegistrationResponse.mockResolvedValue(verifiedAttestation);
    const res = await request(buildProtectedApp(prisma, stefan))
      .post("/api/auth/webauthn/register/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });
    expect(res.status).toBe(200);
    expect(credentials[0]!.rpId).toBe("droplet-ai.local");
  });

  it("register/verify: expired challenge carries code challenge_expired", async () => {
    const { prisma } = createPrismaMock({ users: [stefan] });
    consumeChallenge.mockResolvedValue(null);
    const res = await request(buildProtectedApp(prisma, stefan))
      .post("/api/auth/webauthn/register/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });
    expect(res.body.code).toBe("challenge_expired");
  });

  it("register/verify: failed attestation carries code verification_failed", async () => {
    const { prisma } = createPrismaMock({ users: [stefan] });
    consumeChallenge.mockResolvedValue(liveChallenge);
    verifyRegistrationResponse.mockRejectedValue(new Error("Unexpected origin"));
    const res = await request(buildProtectedApp(prisma, stefan))
      .post("/api/auth/webauthn/register/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("verification_failed");
  });

  it("register/verify: duplicate credential id → 409 already_registered", async () => {
    const { prisma } = createPrismaMock({ users: [stefan] });
    consumeChallenge.mockResolvedValue(liveChallenge);
    verifyRegistrationResponse.mockResolvedValue(verifiedAttestation);
    (prisma.webAuthnCredential.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const res = await request(buildProtectedApp(prisma, stefan))
      .post("/api/auth/webauthn/register/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("already_registered");
  });

  it("register/verify: a database failure → 500 storage_failed, and no audit row", async () => {
    const { prisma } = createPrismaMock({ users: [stefan] });
    consumeChallenge.mockResolvedValue(liveChallenge);
    verifyRegistrationResponse.mockResolvedValue(verifiedAttestation);
    (prisma.webAuthnCredential.create as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("connection terminated"),
    );
    const res = await request(buildProtectedApp(prisma, stefan))
      .post("/api/auth/webauthn/register/verify")
      .send({ response: ceremonyResponse("cred-id-b64url") });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe("storage_failed");
    expect(JSON.stringify(res.body)).not.toMatch(/connection terminated/);
    expect(recordActivity).not.toHaveBeenCalled();
  });
});

describe("WARP-1157 — the signed-in user's passkey list", () => {
  const other: UserRow = { ...stefan, id: "u-other", username: "mallory" };
  function seed(): CredentialRow[] {
    return [
      {
        id: "row-mine",
        userId: stefan.id,
        credentialId: "secret-cred-id",
        publicKey: Buffer.from([9, 9, 9]),
        counter: 3,
        transports: "internal,hybrid",
        name: null,
        rpId: "droplet-ai.local",
        createdAt: new Date("2026-09-01T00:00:00Z"),
        lastUsedAt: null,
      },
      {
        id: "row-theirs",
        userId: other.id,
        credentialId: "their-cred-id",
        publicKey: Buffer.from([7]),
        counter: 0,
        transports: null,
        name: "Their key",
        rpId: "droplet-ai.local",
        createdAt: new Date(),
        lastUsedAt: null,
      },
    ];
  }

  it("GET lists only my passkeys, without public keys or credential ids", async () => {
    const { prisma } = createPrismaMock({ users: [stefan, other], credentials: seed() });
    const res = await request(buildProtectedApp(prisma, stefan)).get("/api/auth/webauthn/credentials");
    expect(res.status).toBe(200);
    expect(res.body.credentials).toHaveLength(1);
    expect(res.body.credentials[0]).toMatchObject({
      id: "row-mine",
      rpId: "droplet-ai.local",
      transports: ["internal", "hybrid"],
    });
    // The route asks Prisma for a projection that omits the key material.
    const call = (prisma.webAuthnCredential.findMany as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.select.publicKey).toBeUndefined();
    expect(call.select.credentialId).toBeUndefined();
  });

  it("GET requires a signed-in user", async () => {
    const { prisma } = createPrismaMock({ credentials: seed() });
    const res = await request(buildProtectedApp(prisma, null)).get("/api/auth/webauthn/credentials");
    expect(res.status).toBe(401);
  });

  it("PATCH renames my passkey and audits it", async () => {
    const { prisma, credentials } = createPrismaMock({ users: [stefan], credentials: seed() });
    const res = await request(buildProtectedApp(prisma, stefan))
      .patch("/api/auth/webauthn/credentials/row-mine")
      .send({ name: "  Work laptop  " });
    expect(res.status).toBe(200);
    expect(credentials.find((c) => c.id === "row-mine")!.name).toBe("Work laptop");
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ refs: expect.objectContaining({ outcome: "passkey_renamed" }) }),
    );
  });

  it("PATCH on someone else's passkey → 404 and nothing changes", async () => {
    const { prisma, credentials } = createPrismaMock({ users: [stefan, other], credentials: seed() });
    const res = await request(buildProtectedApp(prisma, stefan))
      .patch("/api/auth/webauthn/credentials/row-theirs")
      .send({ name: "pwned" });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
    expect(credentials.find((c) => c.id === "row-theirs")!.name).toBe("Their key");
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("PATCH rejects an empty or over-long name", async () => {
    const { prisma } = createPrismaMock({ users: [stefan], credentials: seed() });
    const app = buildProtectedApp(prisma, stefan);
    expect((await request(app).patch("/api/auth/webauthn/credentials/row-mine").send({ name: "   " })).status).toBe(400);
    expect(
      (await request(app).patch("/api/auth/webauthn/credentials/row-mine").send({ name: "x".repeat(65) })).status,
    ).toBe(400);
  });

  it("DELETE removes my passkey and audits it", async () => {
    const { prisma, credentials } = createPrismaMock({ users: [stefan], credentials: seed() });
    const res = await request(buildProtectedApp(prisma, stefan)).delete("/api/auth/webauthn/credentials/row-mine");
    expect(res.status).toBe(204);
    expect(credentials.map((c) => c.id)).toEqual(["row-theirs"]);
    expect(recordActivity).toHaveBeenCalledWith(
      expect.objectContaining({ refs: expect.objectContaining({ outcome: "passkey_removed" }) }),
    );
  });

  it("DELETE on someone else's passkey → 404 and it survives", async () => {
    const { prisma, credentials } = createPrismaMock({ users: [stefan, other], credentials: seed() });
    const res = await request(buildProtectedApp(prisma, stefan)).delete("/api/auth/webauthn/credentials/row-theirs");
    expect(res.status).toBe(404);
    expect(credentials).toHaveLength(2);
  });
});
