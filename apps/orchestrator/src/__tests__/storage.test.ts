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
