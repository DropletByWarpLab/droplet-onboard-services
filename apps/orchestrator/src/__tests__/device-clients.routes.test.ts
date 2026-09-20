import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

// ── Mocks ──
// Prisma double. $transaction runs the interactive-transaction callback against
// mockPrisma itself, so per-test setups on pairingCode/deviceClient drive
// behavior and any throw inside the callback rejects the transaction (models a
// rollback — the consume is not committed).
const mockPrisma = {
  pairingCode: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  deviceClient: {
    create: vi.fn(),
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  pushSubscription: { upsert: vi.fn(), deleteMany: vi.fn() },
  $transaction: vi.fn(),
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
  decryptSecret: vi.fn((s: string) => s.replace(/^enc:/, "")),
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDel: vi.fn(),
}));

vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));

vi.mock("../services/push-dispatch.service.js", () => ({
  dispatchToUser: vi.fn(),
  getPublicVapidKey: vi.fn(() => "vapid-pub"),
}));

// PR #486 finding 2: webdavBaseUrl now resolves the host via the shared
// trusted-origin resolver. Mock config with no canonical-origin env vars set
// and provide the box's trusted origin; the WebDAV URL falls back to it for
// the test's localhost request host.
vi.mock("../config.js", () => ({
  config: {
    ROUTING_MODE: "disabled",
    WIREGUARD_ENDPOINT_HOST: "",
    corsAllowedOrigins: ["https://droplet-ai.local"],
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

import {
  ncGenerateAppPassword,
  ncDeleteAppPassword,
} from "../services/nextcloud.client.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { cacheGet } from "../services/cache.service.js";
import { createDeviceClientsRouter } from "../routes/device-clients.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import type { RecordParams } from "../services/activity.service.js";

// WARP-237: capture pairing/revoke audit rows.
const recordedDeviceClients: RecordParams[] = [];

const mockNcGenerate = vi.mocked(ncGenerateAppPassword);
const mockNcDelete = vi.mocked(ncDeleteAppPassword);
const mockResolveNcToken = vi.mocked(resolveNcToken);
const mockCacheGet = vi.mocked(cacheGet);

const MAX_CLAIM = 20;

function makeApp(username: string | null = "owner-1") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (username) {
      (req as any).user = { username };
    }
    next();
  });
  app.use("/api", createDeviceClientsRouter(mockPrisma as any));
  // Minimal error handler so next(err) yields a 500 rather than hanging.
  app.use(
    (
      err: unknown,
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

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "pc-1",
    code: "ABC123",
    userId: "owner-1",
    // WARP-1202: lifecycle is the explicit status enum, not a used boolean.
    status: "active",
    claimedBy: null,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function claim(app: express.Express) {
  return request(app)
    .post("/api/devices/pair/claim")
    .send({ code: "ABC123", deviceName: "MacBook", appVersion: "1.0.0" });
}

beforeEach(() => {
  vi.clearAllMocks();
  recordedDeviceClients.length = 0;
  _setActivityRecorderForTests(
    {
      record: async (p) => {
        recordedDeviceClients.push(p);
        return {} as never;
      },
    },
    null,
  );
  // Restore the default transaction runner after clearAllMocks wipes impls.
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => unknown) => fn(mockPrisma),
  );
  // Sensible defaults that individual tests override.
  mockCacheGet.mockResolvedValue(null);
  mockResolveNcToken.mockResolvedValue("nc-session-token");
  mockNcGenerate.mockResolvedValue("nc-app-pw");
  mockNcDelete.mockResolvedValue(undefined as never);
});

describe("POST /api/devices/pair/claim — atomic single-use (WARP-564)", () => {
  it("claims a valid code: consumes atomically via updateMany and returns credentials", async () => {
    mockPrisma.pairingCode.findUnique.mockResolvedValue(validRecord());
    mockPrisma.pairingCode.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.deviceClient.create.mockResolvedValue({ id: "client-1" });
    mockPrisma.pairingCode.update.mockResolvedValue({});

    const res = await claim(makeApp());

    expect(res.status).toBe(200);
    expect(res.body.deviceId).toBe("client-1");
    expect(res.body.appPassword).toBe("nc-app-pw");
    expect(res.body.ncUsername).toBe("owner-1");
    // The authoritative gate is the conditional updateMany, not the in-memory
    // read. WARP-1202: the consume keys on the explicit status enum and writes
    // the active→claimed transition.
    expect(mockPrisma.pairingCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "pc-1",
          status: "active",
          // Expiry is authoritative at consume time too (closes the read→consume window).
          expiresAt: { gt: expect.any(Date) },
        }),
        data: expect.objectContaining({ status: "claimed" }),
      }),
    );
    // Consume + create happen inside one transaction.
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
    expect(mockPrisma.deviceClient.create).toHaveBeenCalledOnce();
    // Winner keeps the credential — no compensation.
    expect(mockNcDelete).not.toHaveBeenCalled();
    // WARP-237: pairing (app-password issuance) emits a mandatory row.
    expect(recordedDeviceClients).toContainEqual(
      expect.objectContaining({
        kind: "auth",
        what: "Device client paired",
        refs: expect.objectContaining({ clientId: "client-1" }),
      }),
    );
  });

  it("returns 409 when the conditional consume loses the race (count===0) and compensates the app password", async () => {
    // The pre-read still sees a usable row (read happened before the winner
    // committed) ...
    mockPrisma.pairingCode.findUnique.mockResolvedValue(validRecord());
    // ... but the atomic conditional consume finds no unused row to flip.
    mockPrisma.pairingCode.updateMany.mockResolvedValue({ count: 0 });

    const res = await claim(makeApp());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Pairing code already used");
    expect(mockPrisma.deviceClient.create).not.toHaveBeenCalled();
    // The app password was minted before the tx, so the loser must compensate.
    expect(mockNcDelete).toHaveBeenCalledWith("nc-app-pw");
  });

  it("two parallel claims of one code → exactly one 200, the other 409, exactly one DeviceClient", async () => {
    mockPrisma.pairingCode.findUnique.mockResolvedValue(validRecord());
    mockPrisma.deviceClient.create.mockResolvedValue({ id: "client-1" });
    mockPrisma.pairingCode.update.mockResolvedValue({});

    // First conditional consume flips used=false→true (count 1); every
    // subsequent one finds no unused row (count 0). Models the DB's atomic
    // single-row update under a race.
    let consumed = false;
    mockPrisma.pairingCode.updateMany.mockImplementation(async () => {
      if (consumed) return { count: 0 };
      consumed = true;
      return { count: 1 };
    });

    const [a, b] = await Promise.all([claim(makeApp()), claim(makeApp())]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const ok = a.status === 200 ? a : b;
    const lost = a.status === 409 ? a : b;
    expect(ok.body.deviceId).toBe("client-1");
    expect(lost.body.error).toBe("Pairing code already used");

    // Exactly one DeviceClient minted across both racers.
    expect(mockPrisma.deviceClient.create).toHaveBeenCalledOnce();
  });

  it("rolls back the consume and compensates the app password when DeviceClient create fails", async () => {
    mockPrisma.pairingCode.findUnique.mockResolvedValue(validRecord());
    mockPrisma.pairingCode.updateMany.mockResolvedValue({ count: 1 });
    // The create fails AFTER the consume inside the transaction.
    mockPrisma.deviceClient.create.mockRejectedValue(new Error("db boom"));

    const res = await claim(makeApp());

    // Failure surfaces via the error handler (500), not a silent success.
    expect(res.status).toBe(500);
    // The transaction was entered (consume happened inside it, so a throw rolls
    // it back → the code stays reusable).
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
    // The orphaned Nextcloud app password is compensated (deleted).
    expect(mockNcDelete).toHaveBeenCalledWith("nc-app-pw");
  });

  it("rejects an already-claimed code at read time with 409 (fast path, keyed on status)", async () => {
    mockPrisma.pairingCode.findUnique.mockResolvedValue(
      validRecord({ status: "claimed" }),
    );

    const res = await claim(makeApp());

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Pairing code already used");
    expect(mockPrisma.pairingCode.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.create).not.toHaveBeenCalled();
    // No credential generated for a code already consumed.
    expect(mockNcGenerate).not.toHaveBeenCalled();
  });

  // WARP-1202: a row the daily sweep already stamped `expired` is rejected on
  // its explicit status alone — even if expiresAt were somehow in the future,
  // the persisted state wins.
  it("rejects a sweep-stamped expired code with 410 on status alone", async () => {
    mockPrisma.pairingCode.findUnique.mockResolvedValue(
      validRecord({ status: "expired", expiresAt: new Date(Date.now() + 60_000) }),
    );

    const res = await claim(makeApp());

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Pairing code expired");
    expect(mockPrisma.pairingCode.updateMany).not.toHaveBeenCalled();
    expect(mockNcGenerate).not.toHaveBeenCalled();
  });

  // WARP-1202: `revoked` has no writer yet (reserved), but a non-active row
  // must never be claimable — defensive 410.
  it("rejects a revoked code with 410", async () => {
    mockPrisma.pairingCode.findUnique.mockResolvedValue(
      validRecord({ status: "revoked" }),
    );

    const res = await claim(makeApp());

    expect(res.status).toBe(410);
    expect(res.body.error).toBe("Pairing code no longer valid");
    expect(mockPrisma.pairingCode.updateMany).not.toHaveBeenCalled();
    expect(mockNcGenerate).not.toHaveBeenCalled();
  });

  it("rejects an expired code with 410 and never reaches the consume", async () => {
    mockPrisma.pairingCode.findUnique.mockResolvedValue(
      validRecord({ expiresAt: new Date(Date.now() - 1_000) }),
    );

    const res = await claim(makeApp());

    expect(res.status).toBe(410);
    expect(mockPrisma.pairingCode.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.create).not.toHaveBeenCalled();
  });

  it("treats a code that expires between the read and the atomic consume as not-consumable (count===0 → 409, compensates)", async () => {
    // Unexpired at read time (passes the 410 fast-path) ...
    mockPrisma.pairingCode.findUnique.mockResolvedValue(validRecord());
    // ... but the conditional consume carries `expiresAt: { gt: now }`, so a row
    // that crossed expiresAt in the sub-second window matches no rows → count 0.
    mockPrisma.pairingCode.updateMany.mockResolvedValue({ count: 0 });

    const res = await claim(makeApp());

    expect(res.status).toBe(409);
    // The consume `where` includes the expiry guard — proving expiry is
    // authoritative at consume time, not only at the in-memory read.
    expect(mockPrisma.pairingCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ expiresAt: { gt: expect.any(Date) } }),
      }),
    );
    expect(mockPrisma.deviceClient.create).not.toHaveBeenCalled();
    // App password minted before the tx must be compensated.
    expect(mockNcDelete).toHaveBeenCalledWith("nc-app-pw");
  });

  it("rejects an unknown code with 404", async () => {
    mockPrisma.pairingCode.findUnique.mockResolvedValue(null);

    const res = await claim(makeApp());

    expect(res.status).toBe(404);
    expect(mockPrisma.deviceClient.create).not.toHaveBeenCalled();
  });

  it("rejects an owner mismatch with 403 before minting any credential", async () => {
    mockPrisma.pairingCode.findUnique.mockResolvedValue(
      validRecord({ userId: "someone-else" }),
    );

    const res = await claim(makeApp("owner-1"));

    expect(res.status).toBe(403);
    expect(mockPrisma.pairingCode.updateMany).not.toHaveBeenCalled();
    expect(mockNcGenerate).not.toHaveBeenCalled();
  });

  it("returns 401 when the Nextcloud session is unavailable (no consume)", async () => {
    mockPrisma.pairingCode.findUnique.mockResolvedValue(validRecord());
    mockResolveNcToken.mockResolvedValue(null);

    const res = await claim(makeApp());

    expect(res.status).toBe(401);
    expect(mockPrisma.pairingCode.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.create).not.toHaveBeenCalled();
  });

  it("rate-limits claims by IP with 429", async () => {
    mockCacheGet.mockResolvedValue(MAX_CLAIM);

    const res = await claim(makeApp());

    expect(res.status).toBe(429);
    expect(mockPrisma.pairingCode.findUnique).not.toHaveBeenCalled();
  });

  // WARP-1138: the bucket key comes from proxy-aware req.ip, never the raw
  // client-controlled X-Forwarded-For header — a forged header must not
  // mint a fresh per-IP bucket and dodge the limit.
  it("still 429s an exhausted per-IP bucket when the claim carries a forged X-Forwarded-For (WARP-1138)", async () => {
    mockCacheGet.mockImplementation(async (key: string) =>
      key === "ratelimit:pair:claim:::ffff:127.0.0.1" ? MAX_CLAIM : undefined,
    );

    const res = await request(makeApp())
      .post("/api/devices/pair/claim")
      .set("X-Forwarded-For", "6.6.6.6")
      .send({ code: "ABC123", deviceName: "MacBook", appVersion: "1.0.0" });

    expect(res.status).toBe(429);
    expect(mockPrisma.pairingCode.findUnique).not.toHaveBeenCalled();
  });
});

// CodeQL js/biased-cryptographic-random: the pairing code is drawn with
// crypto.randomInt over the alphabet. Length and charset (no 0/O/1/I) must
// stay exactly what pairing clients and the claim schema expect.
describe("POST /api/devices/pair — code alphabet", () => {
  it("mints 6-char codes drawn only from the unambiguous alphabet", async () => {
    const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    mockCacheGet.mockResolvedValue(null);
    mockPrisma.pairingCode.create.mockResolvedValue({});
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const res = await request(makeApp())
        .post("/api/devices/pair")
        .send({ deviceName: `Charset ${i}`, deviceType: "desktop", platform: "macos" });
      expect(res.status).toBe(200);
      const code = res.body.code as string;
      expect(code).toHaveLength(6);
      for (const ch of code) expect(ALPHABET).toContain(ch);
      seen.add(code);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});
