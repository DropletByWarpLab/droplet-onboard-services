import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";

// Deterministic 32-byte base64 key for the whole test run. Can't derive this
// at runtime because vi.mock is hoisted above top-level statements.
const TEST_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    AUTH_ENABLED: false,
    // departments.ts (registered by createApp) derefs this at module scope to
    // build RESERVED_NAMES; the real config zod-defaults it, so the mock must
    // carry it too or module load throws on undefined.toLowerCase(). (WARP-1292)
    DROPLET_SHARED_FOLDER_NAME: "Household",
    // camera-settings.service.ts derefs this at module scope;
    // the real config defaults it, so the mock must carry it too.
    FRIGATE_URL: "http://frigate:5000",
    DEVICE_SECRET_KEY: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

// Stub the Nextcloud client — only the functions device-clients.ts uses.
vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js"
  );
  return {
    ...actual,
    ncGenerateAppPassword: vi.fn(),
    ncDeleteAppPassword: vi.fn(),
  };
});

// In-memory Prisma stand-ins so the routes get real-looking CRUD behaviour.
const pairingStore = new Map<string, any>();
const clientStore = new Map<string, any>();

vi.mock("@prisma/client", () => {
  const tables = {
    // BUG-11: requirePasswordChangeGate reads prisma.user.findUnique on
    // every request; null = no directory row = fail-open.
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $connect: vi.fn().mockResolvedValue(undefined),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    device: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    pairingCode: {
      create: vi.fn(async ({ data }: any) => {
        const record = {
          id: `pc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          code: data.code,
          userId: data.userId,
          expiresAt: data.expiresAt,
          // WARP-1202: explicit lifecycle status (schema default `active`).
          status: "active",
          claimedBy: null,
          createdAt: new Date(),
        };
        pairingStore.set(data.code, record);
        return record;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        if (where?.code) return pairingStore.get(where.code) ?? null;
        if (where?.id) {
          for (const r of pairingStore.values()) {
            if (r.id === where.id) return r;
          }
        }
        return null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        for (const r of pairingStore.values()) {
          if (r.id === where.id) {
            Object.assign(r, data);
            return r;
          }
        }
        throw new Error("not found");
      }),
      // The claim route consumes the code atomically via
      // `updateMany({ where: { id, status: "active", expiresAt: { gt } } })`
      // and checks `count` to detect replays — honor those predicates.
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const r of pairingStore.values()) {
          if (where?.id && r.id !== where.id) continue;
          if (where?.status !== undefined && r.status !== where.status) continue;
          if (
            where?.expiresAt?.gt &&
            !(new Date(r.expiresAt) > new Date(where.expiresAt.gt))
          ) {
            continue;
          }
          Object.assign(r, data);
          count++;
        }
        return { count };
      }),
    },
    deviceClient: {
      create: vi.fn(async ({ data }: any) => {
        const id = `dc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const record = {
          id,
          ...data,
          lastSeen: new Date(),
          createdAt: new Date(),
        };
        clientStore.set(id, record);
        return record;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        return Array.from(clientStore.values())
          .filter((r) => (where?.userId ? r.userId === where.userId : true))
          .sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
      }),
      findUnique: vi.fn(async ({ where }: any) => clientStore.get(where.id) ?? null),
      update: vi.fn(async ({ where, data }: any) => {
        const r = clientStore.get(where.id);
        if (!r) throw new Error("not found");
        Object.assign(r, data);
        return r;
      }),
    },
  };
  // The pair/claim route consumes the code + creates the DeviceClient
  // inside an interactive transaction (device-clients.ts). Run the
  // callback against the same tables — single-threaded tests need the
  // API shape, not rollback semantics. Object.assign (rather than an
  // inline self-reference) keeps tsc happy: a literal that references
  // itself in its own initializer is TS7022.
  const mockPrisma = Object.assign(tables, {
    $transaction: vi.fn(
      async (fn: (tx: typeof tables) => unknown) => fn(tables),
    ),
  });
  class PrismaClientKnownRequestError extends Error {
    code: string;
    clientVersion: string;
    constructor(message: string, opts: { code: string; clientVersion: string }) {
      super(message);
      this.name = "PrismaClientKnownRequestError";
      this.code = opts.code;
      this.clientVersion = opts.clientVersion;
    }
  }
  return {
    PrismaClient: vi.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError },
  };
});

import { PrismaClient, Prisma } from "@prisma/client";
import { createApp } from "../app.js";
import { initDeviceService } from "../services/device.service.js";
import * as nc from "../services/nextcloud.client.js";
import { __setEncryptionKeyForTest, decryptSecret } from "../services/encryption.service.js";

const ncMock = nc as unknown as {
  ncGenerateAppPassword: ReturnType<typeof vi.fn>;
  ncDeleteAppPassword: ReturnType<typeof vi.fn>;
};

describe("Device clients / pairing", () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
    __setEncryptionKeyForTest(TEST_KEY);
  });

  beforeEach(() => {
    pairingStore.clear();
    clientStore.clear();
    ncMock.ncGenerateAppPassword.mockReset();
    ncMock.ncDeleteAppPassword.mockReset();
    ncMock.ncGenerateAppPassword.mockResolvedValue("nc-fresh-app-password-ABC");
    ncMock.ncDeleteAppPassword.mockResolvedValue(undefined);
  });

  describe("POST /api/devices/pair", () => {
    it("generates a code + droplet:// pair URL", async () => {
      const res = await request(app).post("/api/devices/pair").send({
        deviceName: "Alice's MacBook",
        deviceType: "desktop",
        platform: "macos",
      });
      expect(res.status).toBe(200);
      expect(res.body.code).toMatch(/^[A-Z2-9]{6}$/);
      expect(res.body.pairUrl).toContain("droplet://pair?server=");
      expect(res.body.pairUrl).toContain(`code=${res.body.code}`);
      expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("rejects invalid input", async () => {
      const res = await request(app)
        .post("/api/devices/pair")
        .send({ deviceName: "", deviceType: "laptop", platform: "os/2" });
      expect(res.status).toBe(400);
    });

    it("uses different codes for different requests", async () => {
      const one = await request(app).post("/api/devices/pair").send({
        deviceName: "A",
        deviceType: "desktop",
        platform: "linux",
      });
      const two = await request(app).post("/api/devices/pair").send({
        deviceName: "B",
        deviceType: "mobile",
        platform: "android",
      });
      expect(one.body.code).not.toBe(two.body.code);
    });

    // WARP-1150/1151: Generate code must mint a code for EVERY platform the
    // dialog offers (the repro was platform iOS), plus the API-only "other".
    it.each([
      ["macos", "desktop"],
      ["windows", "desktop"],
      ["linux", "desktop"],
      ["ios", "mobile"],
      ["android", "mobile"],
      ["other", "desktop"],
    ] as const)(
      "generates a code for platform %s",
      async (platform, deviceType) => {
        const res = await request(app).post("/api/devices/pair").send({
          deviceName: "bdeep",
          deviceType,
          platform,
        });
        expect(res.status).toBe(200);
        expect(res.body.code).toMatch(/^[A-Z2-9]{6}$/);
        expect(res.body.pairUrl).toContain(`code=${res.body.code}`);
      },
    );

    // WARP-1151: `PairingCode.code` is unique and old rows are never purged,
    // so a random collision must be retried with a fresh code — not 500 the
    // Generate-code step.
    it("retries with a fresh code when the random code collides (P2002)", async () => {
      const prisma = new PrismaClient() as unknown as {
        pairingCode: { create: ReturnType<typeof vi.fn> };
      };
      const callsBefore = prisma.pairingCode.create.mock.calls.length;
      prisma.pairingCode.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError(
          "Unique constraint failed on the fields: (`code`)",
          { code: "P2002", clientVersion: "test" },
        ),
      );

      const res = await request(app).post("/api/devices/pair").send({
        deviceName: "Collision survivor",
        deviceType: "desktop",
        platform: "macos",
      });

      expect(res.status).toBe(200);
      expect(res.body.code).toMatch(/^[A-Z2-9]{6}$/);
      // One collided attempt + one successful retry.
      expect(prisma.pairingCode.create.mock.calls.length).toBe(callsBefore + 2);
    });

    it("answers 503 (retryable), not 500, when every allocation attempt collides", async () => {
      const prisma = new PrismaClient() as unknown as {
        pairingCode: { create: ReturnType<typeof vi.fn> };
      };
      for (let i = 0; i < 5; i++) {
        prisma.pairingCode.create.mockRejectedValueOnce(
          new Prisma.PrismaClientKnownRequestError(
            "Unique constraint failed on the fields: (`code`)",
            { code: "P2002", clientVersion: "test" },
          ),
        );
      }

      const res = await request(app).post("/api/devices/pair").send({
        deviceName: "Unlucky",
        deviceType: "desktop",
        platform: "macos",
      });

      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/try again/i);
    });

    it("still fails loudly on a non-collision create error", async () => {
      const prisma = new PrismaClient() as unknown as {
        pairingCode: { create: ReturnType<typeof vi.fn> };
      };
      prisma.pairingCode.create.mockRejectedValueOnce(new Error("db down"));

      const res = await request(app).post("/api/devices/pair").send({
        deviceName: "DB outage",
        deviceType: "desktop",
        platform: "macos",
      });

      expect(res.status).toBe(500);
    });
  });

  describe("GET /api/devices/pair/:code/status", () => {
    it("returns unused/not-expired for a fresh code", async () => {
      const created = await request(app).post("/api/devices/pair").send({
        deviceName: "Test",
        deviceType: "desktop",
        platform: "linux",
      });
      const code = created.body.code;

      const res = await request(app).get(`/api/devices/pair/${code}/status`);
      expect(res.status).toBe(200);
      expect(res.body.used).toBe(false);
      expect(res.body.expired).toBe(false);
      expect(res.body.code).toBe(code);
    });

    it("404s on unknown code", async () => {
      const res = await request(app).get("/api/devices/pair/NOPENO/status");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /api/devices/pair/claim", () => {
    async function createCode(): Promise<string> {
      const res = await request(app).post("/api/devices/pair").send({
        deviceName: "Test Device",
        deviceType: "desktop",
        platform: "macos",
      });
      return res.body.code;
    }

    it("mints a fresh Nextcloud app password, encrypts it, and returns the plaintext once", async () => {
      const code = await createCode();
      const res = await request(app)
        .post("/api/devices/pair/claim")
        .send({ code });

      expect(res.status).toBe(200);
      expect(res.body.deviceId).toMatch(/^dc-/);
      expect(res.body.ncUsername).toBe("dev");
      expect(res.body.webdavUrl).toContain("/remote.php/dav/files/dev/");
      expect(res.body.appPassword).toBe("nc-fresh-app-password-ABC");
      expect(ncMock.ncGenerateAppPassword).toHaveBeenCalledTimes(1);

      // Stored value is encrypted, not plaintext.
      const stored = clientStore.get(res.body.deviceId);
      expect(stored).toBeDefined();
      expect(stored.ncAppPassword).not.toContain("nc-fresh-app-password-ABC");
      // And round-trips correctly via the decrypt path.
      expect(decryptSecret(stored.ncAppPassword)).toBe("nc-fresh-app-password-ABC");
    });

    it("marks the pairing code used after a successful claim", async () => {
      const code = await createCode();
      await request(app).post("/api/devices/pair/claim").send({ code });

      const status = await request(app).get(`/api/devices/pair/${code}/status`);
      expect(status.body.used).toBe(true);
      expect(status.body.claimedBy).toMatch(/^dc-/);
    });

    // WARP-1150/1151: the full observed repro shape — an iOS device named
    // "bdeep" — generate a code, then prove the claim endpoint accepts that
    // exact code before its 10-minute expiry.
    it("a freshly generated iOS code is accepted by /pair/claim before expiry", async () => {
      const created = await request(app).post("/api/devices/pair").send({
        deviceName: "bdeep",
        deviceType: "mobile",
        platform: "ios",
      });
      expect(created.status).toBe(200);
      expect(new Date(created.body.expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );

      const claim = await request(app)
        .post("/api/devices/pair/claim")
        .send({ code: created.body.code, deviceName: "bdeep" });

      expect(claim.status).toBe(200);
      expect(claim.body.deviceId).toMatch(/^dc-/);
      expect(claim.body.appPassword).toBe("nc-fresh-app-password-ABC");

      const status = await request(app).get(
        `/api/devices/pair/${created.body.code}/status`,
      );
      expect(status.body.used).toBe(true);
    });

    it("rejects replay: second claim with the same code 409s", async () => {
      const code = await createCode();
      const first = await request(app).post("/api/devices/pair/claim").send({ code });
      expect(first.status).toBe(200);

      const second = await request(app).post("/api/devices/pair/claim").send({ code });
      expect(second.status).toBe(409);
    });

    it("rejects an unknown code with 404", async () => {
      const res = await request(app)
        .post("/api/devices/pair/claim")
        .send({ code: "NOPENO" });
      expect(res.status).toBe(404);
    });

    it("returns 502 when Nextcloud refuses to mint an app password", async () => {
      ncMock.ncGenerateAppPassword.mockResolvedValue(null);
      const code = await createCode();
      const res = await request(app)
        .post("/api/devices/pair/claim")
        .send({ code });
      expect(res.status).toBe(502);
      // Code should NOT be marked used when the claim fails.
      const status = await request(app).get(`/api/devices/pair/${code}/status`);
      expect(status.body.used).toBe(false);
    });
  });

  describe("GET /api/devices/clients", () => {
    it("returns only the caller's devices and strips ncAppPassword", async () => {
      // Pair two devices. We pass the deviceName through the claim body
      // directly — in production the /pair endpoint also stashes it in
      // Redis as a fallback, but the test Redis is a no-op so the claim
      // body is the source of truth here.
      for (const name of ["Laptop", "Phone"]) {
        const code = (
          await request(app).post("/api/devices/pair").send({
            deviceName: name,
            deviceType: name === "Laptop" ? "desktop" : "mobile",
            platform: "macos",
          })
        ).body.code;
        await request(app)
          .post("/api/devices/pair/claim")
          .send({ code, deviceName: name });
      }

      const res = await request(app).get("/api/devices/clients");
      expect(res.status).toBe(200);
      expect(res.body.clients).toHaveLength(2);
      for (const client of res.body.clients) {
        expect(client).not.toHaveProperty("ncAppPassword");
        expect(client.status).toBe("active");
      }
      expect(res.body.clients.map((c: any) => c.deviceName).sort()).toEqual([
        "Laptop",
        "Phone",
      ]);
    });
  });

  describe("DELETE /api/devices/clients/:id", () => {
    async function pairOne(): Promise<string> {
      const code = (
        await request(app).post("/api/devices/pair").send({
          deviceName: "Revokable",
          deviceType: "desktop",
          platform: "linux",
        })
      ).body.code;
      const claim = await request(app)
        .post("/api/devices/pair/claim")
        .send({ code });
      return claim.body.deviceId;
    }

    it("decrypts the stored password and revokes it upstream", async () => {
      const id = await pairOne();
      const res = await request(app).delete(`/api/devices/clients/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.revoked).toBe(id);
      expect(ncMock.ncDeleteAppPassword).toHaveBeenCalledWith(
        "nc-fresh-app-password-ABC"
      );

      // Row is marked revoked, not removed.
      const listed = await request(app).get("/api/devices/clients");
      const client = listed.body.clients.find((c: any) => c.id === id);
      expect(client.status).toBe("revoked");
    });

    it("is idempotent — revoking an already-revoked device returns 200", async () => {
      const id = await pairOne();
      const first = await request(app).delete(`/api/devices/clients/${id}`);
      expect(first.status).toBe(200);
      // Second call: Nextcloud revoke should NOT fire again.
      ncMock.ncDeleteAppPassword.mockClear();
      const second = await request(app).delete(`/api/devices/clients/${id}`);
      expect(second.status).toBe(200);
      expect(ncMock.ncDeleteAppPassword).not.toHaveBeenCalled();
    });

    it("404s on unknown id", async () => {
      const res = await request(app).delete("/api/devices/clients/does-not-exist");
      expect(res.status).toBe(404);
    });

    // WARP-349 — the app-level wiring for the Basic-auth self-revoke path:
    // the self-revoke router mounts BEFORE authMiddleware in app.ts, so a
    // request presenting `Authorization: Basic <user:appPassword>` and no
    // session cookie is authenticated against the target row's own stored
    // (encrypted) app password.
    it("WARP-349: revokes via Basic <ncUsername:appPassword> with no session", async () => {
      const id = await pairOne();
      const res = await request(app)
        .delete(`/api/devices/clients/${id}`)
        .auth("dev", "nc-fresh-app-password-ABC");
      expect(res.status).toBe(200);
      expect(res.body.revoked).toBe(id);
      expect(ncMock.ncDeleteAppPassword).toHaveBeenCalledWith(
        "nc-fresh-app-password-ABC"
      );

      const listed = await request(app).get("/api/devices/clients");
      const client = listed.body.clients.find((c: any) => c.id === id);
      expect(client.status).toBe("revoked");
    });

    it("WARP-349: Basic path 401s uniformly for wrong password and unknown id", async () => {
      const id = await pairOne();
      const wrongPw = await request(app)
        .delete(`/api/devices/clients/${id}`)
        .auth("dev", "not-the-app-password");
      const unknown = await request(app)
        .delete("/api/devices/clients/does-not-exist")
        .auth("dev", "nc-fresh-app-password-ABC");

      expect(wrongPw.status).toBe(401);
      expect(unknown.status).toBe(401);
      // Uniform body — an attacker can't distinguish "wrong password" from
      // "device does not exist".
      expect(wrongPw.body).toEqual(unknown.body);
      expect(ncMock.ncDeleteAppPassword).not.toHaveBeenCalled();

      // The target row is untouched.
      const listed = await request(app).get("/api/devices/clients");
      const client = listed.body.clients.find((c: any) => c.id === id);
      expect(client.status).toBe("active");
    });

    it("WARP-349: Basic path can only revoke the device the credentials belong to", async () => {
      // Two paired devices for the same user, each with its own app password.
      const firstId = await pairOne();
      ncMock.ncGenerateAppPassword.mockResolvedValue("nc-second-app-password-XYZ");
      const secondId = await pairOne();

      // First device's password presented against the second device's id.
      const res = await request(app)
        .delete(`/api/devices/clients/${secondId}`)
        .auth("dev", "nc-fresh-app-password-ABC");
      expect(res.status).toBe(401);
      expect(ncMock.ncDeleteAppPassword).not.toHaveBeenCalled();

      const listed = await request(app).get("/api/devices/clients");
      for (const wanted of [firstId, secondId]) {
        expect(
          listed.body.clients.find((c: any) => c.id === wanted).status
        ).toBe("active");
      }
    });
  });
});
