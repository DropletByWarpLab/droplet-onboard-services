/**
 * WARP-582 — `?return=body` must be a NATIVE-client-only escape hatch.
 *
 * POST /auth/login?return=body returns the JWT pair in the JSON body for
 * droplet-android/-ios (OkHttp/URLSession can't reliably read httpOnly
 * Set-Cookie). On a browser that same body would defeat the httpOnly-cookie
 * posture (XSS-readable tokens), so the route now suppresses the body tokens
 * whenever the request carries a browser-only marker header (Sec-Fetch-*,
 * Origin, Referer — all attached unconditionally by browsers; Sec-Fetch-* and
 * Origin are forbidden header names page script cannot strip). Login itself
 * still succeeds for a browser: cookies are set exactly as before.
 *
 * Harness mirrors auth.session-mint.test.ts (real route handlers via
 * supertest, real JWT signers, NC client + nc-session + password.service
 * mocked).
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
    SERVICE_TOKEN_VOICE: "",
    SERVICE_TOKEN_MCP: "",
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  cacheIncr: vi.fn().mockResolvedValue(1),
}));

vi.mock("../services/nextcloud.client.js", () => ({
  ncCheckSetupRequired: vi.fn(),
  ncInstallAndCreateAdmin: vi.fn().mockResolvedValue(undefined),
  ncLoginWithCredentials: vi.fn().mockResolvedValue({ token: "nc", loginName: "x" }),
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
  NextcloudUserExistsError: class extends Error {},
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: vi.fn().mockResolvedValue(undefined),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn().mockResolvedValue(undefined),
  touchNcToken: vi.fn().mockResolvedValue(undefined),
  resolveNcToken: vi.fn().mockResolvedValue("tok"),
}));

vi.mock("../services/password.service.js", () => ({
  hashPassword: vi.fn(async () => "$argon2id$stub"),
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
    registerRefreshSession: vi.fn().mockResolvedValue(undefined),
    unregisterRefreshSession: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-gate-0001", evictedSids: [] })),
  deleteSession: vi.fn(async () => undefined),
  checkSession: vi.fn(async () => ({
    kind: "ok",
    record: { userId: "u-1", role: "family", createdAt: 0, lastSeenAt: 0 },
  })),
  revokeAllSessions: vi.fn(async () => 0),
}));

vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/brain-memory.service.js", () => ({
  purgeUserData: vi.fn().mockResolvedValue({ items: 0, chunks: 0 }),
}));

import { createPublicAuthRouter } from "./auth.js";

const aliceRow = {
  id: "u-uuid-alice-1",
  username: "alice",
  displayName: "Alice",
  email: "alice@warp.test",
  nextcloudUsername: "alice",
  passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA",
  role: "family",
  isLocal: true,
  directoryStatus: "ACTIVE",
  mustChangePassword: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createPrismaMock() {
  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.email === aliceRow.email || where.id === aliceRow.id) return aliceRow;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        where.email === aliceRow.email ? aliceRow : null,
      ),
      update: vi.fn(async () => aliceRow),
    },
    totpCredential: { findUnique: vi.fn(async () => null) },
    recoveryCode: { findMany: vi.fn(async () => []) },
  };
}

function publicApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api", createPublicAuthRouter(createPrismaMock() as never));
  return app;
}

const CREDS = { email: "alice@warp.test", password: "hunter22hunter22" };

/** Normalise supertest's set-cookie (string | string[]) to one string. */
function setCookieText(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  return Array.isArray(raw) ? raw.join(";") : (raw ?? "");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/auth/login?return=body — WARP-582 browser gate", () => {
  it("ACCEPTED shape: a native client (no browser markers) gets tokens in the body", async () => {
    const res = await request(publicApp())
      .post("/api/auth/login?return=body")
      .send(CREDS);

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    expect(res.body.accessTokenExpiresAt).toEqual(expect.any(Number));
    // Cookies are still set alongside (unchanged native contract).
    expect(setCookieText(res)).toContain("droplet_session=");
  });

  it("accepts the legacy ?return=body=1 spelling from a native client", async () => {
    const res = await request(publicApp())
      .post("/api/auth/login?return=body=1")
      .send(CREDS);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
  });

  it.each([
    ["sec-fetch-site", "same-origin"],
    ["sec-fetch-mode", "cors"],
    ["sec-fetch-dest", "empty"],
    ["origin", "https://droplet-ai.local"],
    ["referer", "https://droplet-ai.local/login"],
  ])(
    "REJECTED shape: %s marks a browser — login succeeds but the body carries NO tokens",
    async (header, value) => {
      const res = await request(publicApp())
        .post("/api/auth/login?return=body")
        .set(header, value)
        .send(CREDS);

      // The login itself is NOT rejected — the browser gets its normal
      // cookie-only session; only the body-token escape hatch is closed.
      expect(res.status).toBe(200);
      expect(res.body.user?.username).toBe("alice");
      expect(res.body.accessToken).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();
      expect(res.body.accessTokenExpiresAt).toBeUndefined();
      expect(res.body.refreshTokenExpiresAt).toBeUndefined();
      expect(setCookieText(res)).toContain("droplet_session=");
    },
  );

  it("a browser-marked login WITHOUT return=body is byte-identical to before (no tokens)", async () => {
    const res = await request(publicApp())
      .post("/api/auth/login")
      .set("origin", "https://droplet-ai.local")
      .send(CREDS);
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeUndefined();
  });
});
