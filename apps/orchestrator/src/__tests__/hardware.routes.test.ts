/**
 * WARP-472 — /api/hardware READ-ONLY admin-gated surface (Phase F4).
 *
 * Mirrors models.routes.test.ts pattern: service + route + read-only
 * enforcement assertions.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

import { createHardwareRouter } from "../routes/hardware.js";
import { getHardwarePayload } from "../services/hardware-summary.service.js";

interface MockSetting {
  key: string;
  valueJson: unknown;
}
interface MockDrive {
  displayName: string;
  notes: string | null;
}

function createPrismaMock(over: { settings?: MockSetting[]; drives?: MockDrive[] } = {}) {
  const settings = over.settings ?? [];
  const drives = over.drives ?? [];
  return {
    workspaceSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => {
        return settings.find((s) => s.key === where.key) ?? null;
      }),
    },
    drive: {
      findMany: vi.fn(async () => drives),
    },
  };
}

function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  asUser: { username?: string; role?: string },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createHardwareRouter(prismaMock as unknown as import("@prisma/client").PrismaClient));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-472 — hardware payload composition", () => {
  it("returns FEATURES.md §9 shape with all top-level keys", async () => {
    const prisma = createPrismaMock();
    const payload = await getHardwarePayload(
      prisma as unknown as import("@prisma/client").PrismaClient,
    );
    expect(payload.appliance_id).toBeDefined();
    expect(payload.compute).toBeDefined();
    expect(payload.storage).toBeDefined();
    expect(payload.network).toBeDefined();
    expect(payload.display).toBeDefined();
    expect(payload.supply_chain).toBeDefined();
  });

  it("supply_chain defaults to false when WorkspaceSetting keys absent", async () => {
    const prisma = createPrismaMock();
    const payload = await getHardwarePayload(
      prisma as unknown as import("@prisma/client").PrismaClient,
    );
    expect(payload.supply_chain.taa).toBe(false);
    expect(payload.supply_chain.ndaa_889).toBe(false);
  });

  it("supply_chain reads true from WorkspaceSetting when present", async () => {
    const prisma = createPrismaMock({
      settings: [
        { key: "hardware.supply_chain.taa_compliant", valueJson: true },
        { key: "hardware.supply_chain.ndaa_889_compliant", valueJson: true },
      ],
    });
    const payload = await getHardwarePayload(
      prisma as unknown as import("@prisma/client").PrismaClient,
    );
    expect(payload.supply_chain.taa).toBe(true);
    expect(payload.supply_chain.ndaa_889).toBe(true);
  });

  it("storage section enumerates drives from Drive table", async () => {
    const prisma = createPrismaMock({
      drives: [
        { displayName: "Wedding Photos", notes: null },
        { displayName: "Archive 2025", notes: "cold storage" },
      ],
    });
    const payload = await getHardwarePayload(
      prisma as unknown as import("@prisma/client").PrismaClient,
    );
    expect(payload.storage.drives).toHaveLength(2);
    expect(payload.storage.drives[0]?.display_name).toBe("Wedding Photos");
  });

  it("compute.control_plane is non-empty (host detection)", async () => {
    const prisma = createPrismaMock();
    const payload = await getHardwarePayload(
      prisma as unknown as import("@prisma/client").PrismaClient,
    );
    expect(payload.compute.control_plane).toBeTruthy();
    expect(typeof payload.compute.control_plane).toBe("string");
  });
});

describe("WARP-472 — /api/hardware route", () => {
  it("admin GET returns 200 + payload", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { username: "stefan", role: "admin" });
    const res = await request(app).get("/api/hardware");
    expect(res.status).toBe(200);
    expect(res.body.supply_chain).toBeDefined();
  });

  it("owner GET returns 200", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { username: "stefan", role: "owner" });
    const res = await request(app).get("/api/hardware");
    expect(res.status).toBe(200);
  });

  it("family GET is forbidden (admin-only)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { username: "stefan", role: "family" });
    const res = await request(app).get("/api/hardware");
    expect(res.status).toBe(403);
  });

  it("PATCH /api/hardware 404s (read-only)", async () => {
    const prisma = createPrismaMock();
    const app = buildApp(prisma, { username: "stefan", role: "owner" });
    const res = await request(app).patch("/api/hardware").send({});
    expect(res.status).toBe(404);
  });
});
