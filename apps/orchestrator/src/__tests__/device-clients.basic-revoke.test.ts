/**
 * WARP-349 — server-side device revoke on "Forget this Droplet".
 *
 * DELETE /api/devices/clients/:id additionally accepts
 * `Authorization: Basic <ncUsername:appPassword>` when no authenticated
 * session is present. The Basic path authenticates by decrypting the target
 * DeviceClient's stored Nextcloud app password and timing-safe-comparing it
 * against the presented password, AND requires the presented username to
 * match the device's owner. It can ONLY revoke the device whose credentials
 * were presented; every mismatch (wrong password, wrong username, another
 * device's :id, unknown id, already-revoked row) is a uniform 401 with no
 * existence leak. The session-cookie path keeps its exact prior behavior.
 *
 * The app under test mirrors the production mounting order in app.ts:
 *   cookieParser → self-revoke router (pre-auth) → authMiddleware stand-in
 *   → protected device-clients router.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { Buffer } from "node:buffer";

// ── Mocks (same set as device-clients.routes.test.ts) ──
const mockPrisma = {
  deviceClient: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
};

vi.mock("../services/nextcloud.client.js", () => ({
  ncGenerateAppPassword: vi.fn(),
  ncDeleteAppPassword: vi.fn(),
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(),
}));

vi.mock("../services/encryption.service.js", () => ({
  encryptSecret: vi.fn((s: string) => `enc:${s}`),
  decryptSecret: vi.fn((s: string) => {
    if (!s.startsWith("enc:")) throw new Error("bad ciphertext");
    return s.slice(4);
  }),
}));

// device-clients.ts imports SESSION_COOKIE_NAME from middleware/auth.js,
// which pulls in jwt.service — mock every cache.service name either module
// binds so ESM named-import validation stays happy.
vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheSetNx: vi.fn(),
  cacheDel: vi.fn(),
  cacheSetAdd: vi.fn(),
  cacheSetRemove: vi.fn(),
  cacheSetMembers: vi.fn(),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../services/push-dispatch.service.js", () => ({
  dispatchToUser: vi.fn(),
  getPublicVapidKey: vi.fn(() => "vapid-pub"),
}));

vi.mock("../config.js", () => ({
  config: {
    ROUTING_MODE: "disabled",
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import { ncDeleteAppPassword } from "../services/nextcloud.client.js";
import { publish } from "../services/mqtt.service.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import {
  createDeviceClientsRouter,
  createDeviceSelfRevokeRouter,
} from "../routes/device-clients.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import type { RecordParams } from "../services/activity.service.js";

const mockNcDelete = vi.mocked(ncDeleteAppPassword);
const mockPublish = vi.mocked(publish);
const mockCacheGet = vi.mocked(cacheGet);
const mockCacheSet = vi.mocked(cacheSet);

// WARP-237: capture the self-revoke audit row.
const recordedRevoke: RecordParams[] = [];

/**
 * Production mounting order (app.ts): the self-revoke router mounts BEFORE
 * the auth middleware; requests it doesn't handle fall through to a stand-in
 * with authMiddleware's contract (populate req.user for a session, 401
 * otherwise) and then to the protected device-clients router.
 */
function makeApp(sessionUser: string | null = null) {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use("/api", createDeviceSelfRevokeRouter(mockPrisma as never));
  app.use((req, res, next) => {
    if (sessionUser) {
      // Same shape stand-in as device-clients.routes.test.ts — the route
      // only reads req.user.username via getUser().
      (req as any).user = { username: sessionUser };
      next();
      return;
    }
    res.status(401).json({ error: "Missing or invalid authentication" });
  });
  app.use("/api", createDeviceClientsRouter(mockPrisma as never));
  app.use(
    (
      _err: unknown,
      _req: express.Request,
      res: express.Response,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: "internal" });
    },
  );
  return app;
}

function deviceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "dc-1",
    userId: "owner-1",
    deviceName: "Pixel 9",
    deviceType: "mobile",
    platform: "android",
    appVersion: "1.0.0",
    ncAppPassword: "enc:app-pw-123",
    lastSeen: new Date(),
    status: "active",
    createdAt: new Date(),
    ...overrides,
  };
}

function basicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64");
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedRevoke.length = 0;
  _setActivityRecorderForTests(
    {
      record: async (p) => {
        recordedRevoke.push(p);
        return {} as never;
      },
    },
    null,
  );
  mockPrisma.deviceClient.update.mockResolvedValue({});
});

describe("DELETE /api/devices/clients/:id — Basic-auth device self-revoke (WARP-349)", () => {
  it("revokes the caller's own device with valid Basic credentials and runs the full cleanup", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: "dc-1" });
    // Same cleanup as the session path: upstream revoke, row marked revoked,
    // MQTT event published.
    expect(mockNcDelete).toHaveBeenCalledWith("app-pw-123");
    expect(mockPrisma.deviceClient.update).toHaveBeenCalledWith({
      where: { id: "dc-1" },
      data: { status: "revoked" },
    });
    expect(mockPublish).toHaveBeenCalledWith("droplet/devices/owner-1/revoked", {
      deviceId: "dc-1",
    });
    // WARP-237: device self-revoke over Basic auth is a system-actor
    // credential-lifecycle emit.
    expect(recordedRevoke).toContainEqual(
      expect.objectContaining({
        kind: "auth",
        what: "Device client revoked",
        actor: { type: "system", id: null },
        refs: expect.objectContaining({ clientId: "dc-1", via: "device-basic-auth" }),
      }),
    );
  });

  it("401s a wrong password without revoking anything", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "wrong-password"));

    expect(res.status).toBe(401);
    expect(mockNcDelete).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
  });

  it("401s valid credentials presented against another device's :id (same owner)", async () => {
    // The target row belongs to the same user but holds a DIFFERENT app
    // password — the presented credential authenticates dc-1, not dc-2.
    mockPrisma.deviceClient.findUnique.mockResolvedValue(
      deviceRow({ id: "dc-2", ncAppPassword: "enc:other-devices-pw" }),
    );

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-2")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"));

    expect(res.status).toBe(401);
    expect(mockNcDelete).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
  });

  it("401s when the username does not match the target device's owner", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(
      deviceRow({ userId: "someone-else" }),
    );

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"));

    expect(res.status).toBe(401);
    expect(mockNcDelete).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
  });

  it("401s an unknown :id with a body identical to the wrong-password case (no existence leak)", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(null);
    const unknown = await request(makeApp())
      .delete("/api/devices/clients/no-such-device")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"));

    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());
    const wrongPw = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "wrong-password"));

    expect(unknown.status).toBe(401);
    expect(wrongPw.status).toBe(401);
    expect(unknown.body).toEqual(wrongPw.body);
    expect(mockNcDelete).not.toHaveBeenCalled();
  });

  it("401s credentials of an already-revoked device (revoked creds no longer authenticate)", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(
      deviceRow({ status: "revoked" }),
    );

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"));

    expect(res.status).toBe(401);
    expect(mockNcDelete).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
  });

  it("401s malformed Basic credentials (no colon, empty username, empty password)", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());
    const app = makeApp();

    const noColon = await request(app)
      .delete("/api/devices/clients/dc-1")
      .set(
        "Authorization",
        "Basic " + Buffer.from("no-colon-here", "utf8").toString("base64"),
      );
    const emptyUser = await request(app)
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("", "app-pw-123"));
    const emptyPass = await request(app)
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", ""));

    expect(noColon.status).toBe(401);
    expect(emptyUser.status).toBe(401);
    expect(emptyPass.status).toBe(401);
    expect(mockNcDelete).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
  });

  it("falls through to the normal auth 401 when no Basic header is present on an unauthenticated request", async () => {
    const res = await request(makeApp()).delete("/api/devices/clients/dc-1");

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Missing or invalid authentication" });
    expect(mockPrisma.deviceClient.findUnique).not.toHaveBeenCalled();
  });

  it("defers to the session path when a session cookie is present, even with Basic credentials attached", async () => {
    // The target device belongs to someone else. The Basic credentials would
    // authenticate it, but the session cookie means the session path decides:
    // owner mismatch → the session path's 404, not the Basic path's revoke.
    mockPrisma.deviceClient.findUnique.mockResolvedValue(
      deviceRow({ userId: "someone-else" }),
    );

    const res = await request(makeApp("owner-1"))
      .delete("/api/devices/clients/dc-1")
      .set("Cookie", `${SESSION_COOKIE_NAME}=some-session-token`)
      .set("Authorization", basicAuth("someone-else", "app-pw-123"));

    expect(res.status).toBe(404);
    expect(mockNcDelete).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
  });

  it("keeps the session path intact: an authenticated operator revokes their device without Basic", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    const res = await request(makeApp("owner-1")).delete(
      "/api/devices/clients/dc-1",
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: "dc-1" });
    expect(mockNcDelete).toHaveBeenCalledWith("app-pw-123");
    expect(mockPrisma.deviceClient.update).toHaveBeenCalledWith({
      where: { id: "dc-1" },
      data: { status: "revoked" },
    });
    expect(mockPublish).toHaveBeenCalledWith("droplet/devices/owner-1/revoked", {
      deviceId: "dc-1",
    });
    // WARP-237: the session (operator) revoke path emits too.
    expect(recordedRevoke).toContainEqual(
      expect.objectContaining({
        kind: "auth",
        what: "Device client revoked",
        refs: expect.objectContaining({ clientId: "dc-1" }),
      }),
    );
  });

  it("keeps the session path intact: 404 for another user's device via session", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(
      deviceRow({ userId: "someone-else" }),
    );

    const res = await request(makeApp("owner-1")).delete(
      "/api/devices/clients/dc-1",
    );

    expect(res.status).toBe(404);
    expect(mockNcDelete).not.toHaveBeenCalled();
  });

  it("401s undecryptable stored ciphertext (tamper / key mismatch) like any credential failure", async () => {
    // decryptSecret's mock throws for anything not "enc:"-prefixed.
    mockPrisma.deviceClient.findUnique.mockResolvedValue(
      deviceRow({ ncAppPassword: "corrupt-ciphertext" }),
    );

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Invalid device credentials" });
    expect(mockNcDelete).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
  });
});

// WARP-1030 — the Basic branch is an unauthenticated credential oracle;
// brute-force protection must sit in front of the verify.
describe("DELETE /api/devices/clients/:id — Basic-path rate limiting (WARP-1030)", () => {
  it("429s when the per-IP bucket is exhausted, before any DB lookup", async () => {
    mockCacheGet.mockImplementation(async (key: string) =>
      key.startsWith("ratelimit:revoke:ip:") ? 20 : undefined,
    );
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"));

    expect(res.status).toBe(429);
    expect(mockPrisma.deviceClient.findUnique).not.toHaveBeenCalled();
    expect(mockNcDelete).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
  });

  it("429s when the per-target bucket is exhausted (rotating-IP attacker)", async () => {
    mockCacheGet.mockImplementation(async (key: string) =>
      key === "ratelimit:revoke:target:dc-1" ? 10 : undefined,
    );
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"));

    expect(res.status).toBe(429);
    expect(mockPrisma.deviceClient.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
  });

  it("counts failed attempts against both buckets", async () => {
    mockCacheGet.mockResolvedValue(undefined as never);
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "wrong-password"));

    const bumped = mockCacheSet.mock.calls.map((c) => c[0]);
    expect(bumped).toContain("ratelimit:revoke:ip:::ffff:127.0.0.1");
    expect(bumped).toContain("ratelimit:revoke:target:dc-1");
  });

  it("a legitimate single revoke is unaffected", async () => {
    mockCacheGet.mockResolvedValue(undefined as never);
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: "dc-1" });
  });

  it("does not rate-limit the session-cookie path", async () => {
    mockCacheGet.mockImplementation(async (key: string) =>
      key.startsWith("ratelimit:revoke:") ? 999 : undefined,
    );
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    const res = await request(makeApp("owner-1")).delete(
      "/api/devices/clients/dc-1",
    );

    expect(res.status).toBe(200);
  });
});

// WARP-1138 — the per-IP bucket key must come from proxy-aware `req.ip`
// (the auth.ts callerIpFromReq standard, WARP-579), never the raw
// client-controlled X-Forwarded-For header: rotating that header used to
// mint a fresh `revoke:ip:<forged>` bucket per request, zeroing the limit.
describe("DELETE /api/devices/clients/:id — forged X-Forwarded-For cannot mint fresh per-IP buckets (WARP-1138)", () => {
  it("still 429s an exhausted per-IP bucket under rotating forged X-Forwarded-For values", async () => {
    // Only the socket-derived bucket is exhausted; any XFF-derived key
    // would read as a fresh bucket and let the request through.
    mockCacheGet.mockImplementation(async (key: string) =>
      key === "ratelimit:revoke:ip:::ffff:127.0.0.1" ? 20 : undefined,
    );
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    const app = makeApp();
    for (const forged of ["6.6.6.6", "7.7.7.7", "8.8.8.8"]) {
      const res = await request(app)
        .delete("/api/devices/clients/dc-1")
        .set("Authorization", basicAuth("owner-1", "app-pw-123"))
        .set("X-Forwarded-For", forged);
      expect(res.status).toBe(429);
    }
    expect(mockPrisma.deviceClient.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
  });

  it("bumps the req.ip-keyed bucket, never an attacker-named one", async () => {
    mockCacheGet.mockResolvedValue(undefined as never);
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"))
      .set("X-Forwarded-For", "6.6.6.6");

    const bumped = mockCacheSet.mock.calls.map((c) => c[0]);
    expect(bumped).toContain("ratelimit:revoke:ip:::ffff:127.0.0.1");
    expect(bumped.some((k) => String(k).includes("6.6.6.6"))).toBe(false);
  });

  it("an empty X-Forwarded-For does not collapse callers into a shared empty-key bucket", async () => {
    mockCacheGet.mockResolvedValue(undefined as never);
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", basicAuth("owner-1", "app-pw-123"))
      .set("X-Forwarded-For", "");

    const bumped = mockCacheSet.mock.calls.map((c) => c[0]);
    expect(bumped).toContain("ratelimit:revoke:ip:::ffff:127.0.0.1");
    expect(bumped).not.toContain("ratelimit:revoke:ip:");
  });
});

// CodeQL js/polynomial-redos: the scheme matcher is `/^Basic\s+(\S.*)$/i`
// (the credential must start with a non-space so `\s+` and the capture
// can't overlap). The accept set the client relies on must not move.
describe("DELETE /api/devices/clients/:id — Basic header matching", () => {
  it("accepts extra whitespace between the scheme and the credential", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", "Basic \t   " + basicAuth("owner-1", "app-pw-123").slice(6));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: "dc-1" });
  });

  it("matches the scheme case-insensitively (RFC 7235)", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());

    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", "bAsIc " + basicAuth("owner-1", "app-pw-123").slice(6));

    expect(res.status).toBe(200);
  });

  it("does not engage for a non-Basic scheme — falls through to the session path", async () => {
    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", "Bearer " + basicAuth("owner-1", "app-pw-123").slice(6));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Missing or invalid authentication" });
    expect(mockPrisma.deviceClient.findUnique).not.toHaveBeenCalled();
  });

  it("decides a 5,000-space credential run in well under 100 ms", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(deviceRow());
    const started = performance.now();
    const res = await request(makeApp())
      .delete("/api/devices/clients/dc-1")
      .set("Authorization", "Basic" + " ".repeat(5000) + basicAuth("owner-1", "wrong").slice(6));
    expect(performance.now() - started).toBeLessThan(100);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(BASIC_REVOKE_401_BODY);
  });
});

/** The uniform Basic-path rejection body (device-clients.ts BASIC_REVOKE_401). */
const BASIC_REVOKE_401_BODY = { error: "Invalid device credentials" };
