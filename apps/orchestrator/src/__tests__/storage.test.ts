/**
 * WARP-174 — Storage routes.
 *
 * Covers the wizard-relevant slice:
 *   - GET /api/storage/drives left-joins the Drive table so bridge
 *     entries surface the customer-chosen displayName / icon / notes
 *     when one exists, or null fields when one doesn't.
 *   - PATCH /api/storage/drives/:uuid upserts the Drive row. First
 *     PATCH requires displayName; subsequent PATCHes can be partial.
 *
 * Mocks the device-bridge fetch + ncGetUserQuota, builds an in-memory
 * Prisma stand-in for the Drive table, hands the result to
 * createStorageRouter.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

// Mock Nextcloud session resolution so the existing /api/storage path
// doesn't try to call out — these tests focus on /drives, not quota.
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(async () => null),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetUserQuota: vi.fn(),
}));

import { createStorageRouter } from "../routes/storage.js";

// Bridge response fixture — three drives, one with a friendly name in
// the Drive table, two without.
const fixtureSnapshot = {
  drives: [
    {
      device: "/dev/sda1",
      mount: "/mnt/droplet/data",
      label: "TOSHIBA EXT",
      uuid: "UUID-MAIN-DRIVE",
      size_bytes: 2_000_000_000_000,
      used_bytes: 100_000_000_000,
      free_bytes: 1_900_000_000_000,
      mounted: true,
    },
    {
      device: "/dev/sda2",
      mount: "/mnt/droplet/nvr",
      label: "WD ELEMENTS",
      uuid: "UUID-NVR-DRIVE",
      size_bytes: 1_000_000_000_000,
      used_bytes: 0,
      free_bytes: 1_000_000_000_000,
      mounted: true,
    },
    {
      device: "/dev/sdb1",
      mount: "/mnt/droplet/data2",
      label: "SAMSUNG T7",
      uuid: "UUID-BACKUP",
      size_bytes: 500_000_000_000,
      used_bytes: 50_000_000_000,
      free_bytes: 450_000_000_000,
      mounted: true,
    },
  ],
  count: 3,
  snapshot_at: "2026-05-14T12:00:00Z",
};

// In-memory Prisma stand-in for the Drive table.
function createPrismaMock() {
  const rows = new Map<string, any>();
  return {
    rows,
    drive: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        const uuids = where?.uuid?.in ?? [];
        return uuids
          .map((u: string) => rows.get(u))
          .filter((r: any): r is any => !!r);
      }),
      findUnique: vi.fn(async ({ where }: any) => rows.get(where.uuid) ?? null),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        const existing = rows.get(where.uuid);
        if (existing) {
          const next = {
            ...existing,
            ...update,
            updatedAt: new Date(),
          };
          rows.set(where.uuid, next);
          return next;
        }
        const created = {
          ...create,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        rows.set(where.uuid, created);
        return created;
      }),
    },
  };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>) {
  const app = express();
  app.use(express.json());
  // WARP-171: PATCH /api/storage/drives/:uuid now sits behind a
  // requireRole("owner", "admin") guard. The real authMiddleware isn't
  // in this test's pipeline; inject a synthetic owner so the guard
  // lets the request reach the handler. Same shape the rbac matrix
  // and the vpn test use.
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string; username: string; displayName: string; role: string } }).user = {
      id: "stefan",
      username: "stefan",
      displayName: "Stefan",
      role: "owner",
    };
    next();
  });
  app.use("/api", createStorageRouter(prisma as any));
  return app;
}

beforeEach(() => {
  // Mock global fetch so the storage router's bridge call gets the fixture.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => fixtureSnapshot,
    })),
  );
});

describe("storage routes (WARP-174)", () => {
  describe("GET /api/storage/drives", () => {
    it("returns bridge drives with null displayName when no Drive rows exist", async () => {
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/storage/drives");
      expect(res.status).toBe(200);
      expect(res.body.drives).toHaveLength(3);
      for (const d of res.body.drives) {
        expect(d.displayName).toBeNull();
        expect(d.icon).toBeNull();
        expect(d.notes).toBeNull();
      }
    });

    it("attaches displayName when a Drive row exists for the UUID", async () => {
      const prisma = createPrismaMock();
      prisma.rows.set("UUID-MAIN-DRIVE", {
        uuid: "UUID-MAIN-DRIVE",
        displayName: "Wedding Photos",
        icon: "camera",
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const app = buildApp(prisma);
      const res = await request(app).get("/api/storage/drives");
      expect(res.status).toBe(200);
      const main = res.body.drives.find(
        (d: any) => d.uuid === "UUID-MAIN-DRIVE",
      );
      expect(main.displayName).toBe("Wedding Photos");
      expect(main.icon).toBe("camera");
      // Other drives untouched.
      const nvr = res.body.drives.find(
        (d: any) => d.uuid === "UUID-NVR-DRIVE",
      );
      expect(nvr.displayName).toBeNull();
    });

    it("survives a bridge failure without 500-ing", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: false,
          status: 502,
          json: async () => ({}),
        })),
      );
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/storage/drives");
      expect(res.status).toBe(502);
      expect(res.body.drives).toEqual([]);
    });

    // WARP-645: the device-bridge only runs with the OLED/display compose
    // profile. On hosts without it the fetch throws ECONNREFUSED — an expected
    // deployment shape, not an error. Degrade to 200 + reason rather than the
    // raw "fetch failed" error string.
    it("degrades cleanly when the bridge is not running (ECONNREFUSED)", async () => {
      const connErr = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:9090"), {
          code: "ECONNREFUSED",
        }),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw connErr;
        }),
      );
      const app = buildApp(createPrismaMock());
      const res = await request(app).get("/api/storage/drives");
      expect(res.status).toBe(200);
      expect(res.body.drives).toEqual([]);
      expect(res.body.count).toBe(0);
      expect(res.body.reason).toBe("bridge_unavailable");
      // The raw error string must NOT leak through on this expected path.
      expect(res.body.error).toBeUndefined();
    });
  });

  describe("PATCH /api/storage/drives/:uuid", () => {
    it("creates a Drive row on first PATCH with displayName", async () => {
      const prisma = createPrismaMock();
      const app = buildApp(prisma);
      const res = await request(app)
        .patch("/api/storage/drives/UUID-MAIN-DRIVE")
        .send({ displayName: "Wedding Photos" });
      expect(res.status).toBe(200);
      expect(res.body.displayName).toBe("Wedding Photos");
      expect(prisma.rows.get("UUID-MAIN-DRIVE")).toBeDefined();
    });

    it("rejects first PATCH without displayName", async () => {
      const app = buildApp(createPrismaMock());
      const res = await request(app)
        .patch("/api/storage/drives/UUID-MAIN-DRIVE")
        .send({ icon: "camera" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/displayName is required/i);
    });

    it("updates only the provided fields on subsequent PATCH", async () => {
      const prisma = createPrismaMock();
      prisma.rows.set("UUID-MAIN-DRIVE", {
        uuid: "UUID-MAIN-DRIVE",
        displayName: "Old Name",
        icon: "drive",
        notes: "keep me",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const app = buildApp(prisma);
      const res = await request(app)
        .patch("/api/storage/drives/UUID-MAIN-DRIVE")
        .send({ displayName: "Wedding Photos" });
      expect(res.status).toBe(200);
      const row = prisma.rows.get("UUID-MAIN-DRIVE");
      expect(row.displayName).toBe("Wedding Photos");
      expect(row.icon).toBe("drive"); // unchanged
      expect(row.notes).toBe("keep me"); // unchanged
    });

    it("rejects a body with no fields", async () => {
      const prisma = createPrismaMock();
      prisma.rows.set("UUID-MAIN-DRIVE", {
        uuid: "UUID-MAIN-DRIVE",
        displayName: "Existing",
        icon: null,
        notes: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const app = buildApp(prisma);
      const res = await request(app)
        .patch("/api/storage/drives/UUID-MAIN-DRIVE")
        .send({});
      expect(res.status).toBe(400);
    });

    it("rejects an invalid UUID", async () => {
      const app = buildApp(createPrismaMock());
      const res = await request(app)
        .patch("/api/storage/drives/has spaces in it")
        .send({ displayName: "X" });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid drive UUID/i);
    });
  });
});

describe("storage routes — bus enrichment + rescan (WARP-612)", () => {
  it("falls back to a neutral bus class when the bridge omits it", async () => {
    // The bridge sends the real transport (it reads lsblk on the host). When
    // an older bridge omits it, the orchestrator name-guesses: nvme is
    // unambiguous, but sd* stays neutral 'disk' — it could be SATA/SAS, not
    // necessarily USB (ADR-011, no hardware assumption).
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          drives: [
            { device: "/dev/nvme0n1p1", mount: "/mnt/droplet/vault", label: "Vault", uuid: "U-NVME", size_bytes: 4e12, used_bytes: 1e12, free_bytes: 3e12, mounted: true },
            { device: "/dev/sda1", mount: "/mnt/droplet/data", label: "Data", uuid: "U-SD", size_bytes: 2e12, used_bytes: 0, free_bytes: 2e12, mounted: true },
          ],
          count: 2,
          snapshot_at: "2026-05-31T00:00:00Z",
        }),
      })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.status).toBe(200);
    const byUuid = Object.fromEntries(res.body.drives.map((d: any) => [d.uuid, d]));
    expect(byUuid["U-NVME"].bus).toBe("nvme");
    expect(byUuid["U-SD"].bus).toBe("disk");
  });

  it("passes through the bridge's fs/bus/readonly when present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          drives: [
            { device: "/dev/sda1", mount: "/mnt/x", label: "X", uuid: "U1", size_bytes: 1e9, used_bytes: 0, free_bytes: 1e9, mounted: true, bus: "usb", fs: "exfat", readonly: true },
          ],
          count: 1,
          snapshot_at: "2026-05-31T00:00:00Z",
        }),
      })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.body.drives[0].bus).toBe("usb");
    expect(res.body.drives[0].fs).toBe("exfat");
    expect(res.body.drives[0].readonly).toBe(true);
  });

  describe("POST /api/storage/drives/rescan", () => {
    it("returns ok when the bridge accepts the cache-invalidation", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) })));
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/rescan");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it("502s when the bridge is unreachable", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })));
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/rescan");
      expect(res.status).toBe(502);
      expect(res.body.ok).toBe(false);
    });

    // WARP-645: a connection error (bridge not running) must degrade with a
    // typed reason instead of leaking the raw "fetch failed" string.
    it("degrades with 503 + reason when the bridge is not running (ECONNREFUSED)", async () => {
      const connErr = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:9090"), {
          code: "ECONNREFUSED",
        }),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw connErr;
        }),
      );
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/rescan");
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.reason).toBe("bridge_unavailable");
      // The raw error string must NOT leak through on this expected path.
      expect(res.body.error).not.toMatch(/fetch failed/i);
    });

    it("forbids non-admins", async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { user: { id: string; username: string; displayName: string; role: string } }).user = {
          id: "fam",
          username: "fam",
          displayName: "Fam",
          role: "family",
        };
        next();
      });
      app.use("/api", createStorageRouter(createPrismaMock() as any));
      const res = await request(app).post("/api/storage/drives/rescan");
      expect(res.status).toBe(403);
    });

    it("fails closed when no authenticated user is present", async () => {
      // No synthetic user injected — mirrors a request that never passed
      // authMiddleware. isAdmin() must treat a missing req.user.role as
      // not-admin (fail closed): 403, not a throw and not an allow.
      const app = express();
      app.use(express.json());
      app.use("/api", createStorageRouter(createPrismaMock() as any));
      const res = await request(app).post("/api/storage/drives/rescan");
      expect(res.status).toBe(403);
    });
  });
});

describe("storage routes — SMART + eject (WARP-612)", () => {
  it("passes through SMART health + temperature when the bridge provides them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          drives: [
            { device: "/dev/sda1", mount: "/mnt/droplet/x", label: "X", uuid: "U1", size_bytes: 1e9, used_bytes: 0, free_bytes: 1e9, mounted: true, smart: "PASSED", temp_c: 41 },
          ],
          count: 1,
          snapshot_at: "2026-05-31T00:00:00Z",
        }),
      })),
    );
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/storage/drives");
    expect(res.body.drives[0].smart).toBe("PASSED");
    expect(res.body.drives[0].temp_c).toBe(41);
  });

  describe("POST /api/storage/drives/:uuid/eject", () => {
    it("forbids non-admins", async () => {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { user: { id: string; username: string; displayName: string; role: string } }).user = {
          id: "fam", username: "fam", displayName: "Fam", role: "family",
        };
        next();
      });
      app.use("/api", createStorageRouter(createPrismaMock() as any));
      const res = await request(app).post("/api/storage/drives/U1/eject");
      expect(res.status).toBe(403);
    });

    it("rejects an invalid UUID", async () => {
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/has spaces/eject");
      expect(res.status).toBe(400);
    });

    it("503s when no device-bridge auth token is configured", async () => {
      vi.stubEnv("BRIDGE_AUTH_TOKEN", "");
      vi.stubEnv("SERVICE_TOKEN_DISPLAY", "");
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/U1/eject");
      expect(res.status).toBe(503);
      vi.unstubAllEnvs();
    });

    it("forwards to the bridge with auth + returns ok on success", async () => {
      vi.stubEnv("BRIDGE_AUTH_TOKEN", "secret-token");
      const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, ejected: "U1" }) }));
      vi.stubGlobal("fetch", fetchMock);
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/U1/eject");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
      expect(String(url)).toMatch(/\/drives\/U1\/eject$/);
      expect(init.headers["X-Droplet-Auth"]).toBe("secret-token");
      vi.unstubAllEnvs();
    });

    // WARP-645: a connection error (bridge not running) must degrade with a
    // typed reason instead of leaking the raw "fetch failed" string.
    it("degrades with 503 + reason when the bridge is not running (ECONNREFUSED)", async () => {
      vi.stubEnv("BRIDGE_AUTH_TOKEN", "secret-token");
      const connErr = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:9090"), {
          code: "ECONNREFUSED",
        }),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw connErr;
        }),
      );
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/U1/eject");
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.reason).toBe("bridge_unavailable");
      // The raw error string must NOT leak through on this expected path.
      expect(res.body.error).not.toMatch(/fetch failed/i);
      vi.unstubAllEnvs();
    });

    it("surfaces a 409 from the bridge (drive busy / not ejectable)", async () => {
      vi.stubEnv("BRIDGE_AUTH_TOKEN", "secret-token");
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: "umount failed — the drive may be in use" }) })),
      );
      const app = buildApp(createPrismaMock());
      const res = await request(app).post("/api/storage/drives/U1/eject");
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/in use/i);
      vi.unstubAllEnvs();
    });
  });
});
