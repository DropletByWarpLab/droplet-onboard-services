/**
 * WARP-469 — /api/home aggregation surface (Phase F1).
 *
 * Two layers:
 *   - Service-level: `getHomePayload` is a pure-ish composition over
 *     Prisma queries. Mock prisma + inject `now` to snapshot the shape.
 *   - Route-level: supertest the GET endpoint, confirm 200 + the
 *     response carries every top-level section.
 *
 * Pattern mirrors memory.routes.test.ts (WARP-461) and
 * context-pins.routes.test.ts (WARP-460).
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

import { createHomeRouter } from "../routes/home.js";
import { getHomePayload, timeOfDay } from "../services/home-aggregation.service.js";

function createPrismaMock(over: Partial<{
  activityRows: Array<{ at: Date; severity: string; sourceIcon: string; what: string; sub: string | null; kind: string }>;
  sessionTitles: string[];
  filesCount: number;
  camerasCount: number;
  networkCount: number;
  devicesCount: number;
}> = {}) {
  const activityRows = over.activityRows ?? [];
  const sessionTitles = over.sessionTitles ?? [];
  return {
    activityRow: {
      findMany: vi.fn(async () => activityRows),
    },
    chatSession: {
      findMany: vi.fn(async () =>
        sessionTitles.map((t) => ({ title: t })),
      ),
    },
    brainMemoryItem: {
      count: vi.fn(async () => over.filesCount ?? 0),
    },
    camera: {
      count: vi.fn(async () => over.camerasCount ?? 0),
    },
    networkDevice: {
      count: vi.fn(async () => over.networkCount ?? 0),
    },
    deviceClient: {
      count: vi.fn(async () => over.devicesCount ?? 0),
    },
  };
}

function buildApp(
  prismaMock: ReturnType<typeof createPrismaMock>,
  asUser: { id?: string; username?: string; displayName?: string; role?: string },
) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as unknown as { user?: typeof asUser }).user = asUser;
    next();
  });
  app.use("/api", createHomeRouter(prismaMock as unknown as import("@prisma/client").PrismaClient));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-469 — home aggregation", () => {
  it("timeOfDay maps hours to the three buckets", () => {
    expect(timeOfDay(new Date("2026-05-27T06:00:00"))).toBe("morning");
    expect(timeOfDay(new Date("2026-05-27T13:00:00"))).toBe("afternoon");
    expect(timeOfDay(new Date("2026-05-27T20:00:00"))).toBe("evening");
  });

  it("getHomePayload composes greeting, tiles, timeline, chips", async () => {
    const prisma = createPrismaMock({
      activityRows: [
        {
          at: new Date("2026-05-27T09:00:00Z"),
          severity: "ok",
          sourceIcon: "file",
          what: "indexed wedding-photos.zip",
          sub: "12 MB",
          kind: "file",
        },
      ],
      sessionTitles: ["Carrier delays this week", "Carrier delays this week", "Camera offline"],
      filesCount: 12,
      camerasCount: 3,
      networkCount: 18,
      devicesCount: 4,
    });
    const payload = await getHomePayload(
      prisma as unknown as import("@prisma/client").PrismaClient,
      // role gates the timeline (owner/admin only — privacy boundary added
      // after this test was written; family/guest get an empty timeline).
      { displayName: "Stefan", username: "stefan", role: "owner" },
      new Date("2026-05-27T10:00:00"),
    );
    expect(payload.greeting.text).toBe("Good morning, Stefan");
    expect(payload.greeting.timeOfDay).toBe("morning");
    expect(payload.tiles.files.count).toBe(12);
    expect(payload.tiles.cameras.sub).toBe("3 cameras");
    expect(payload.tiles.devices.sub).toBe("4 paired devices");
    expect(payload.timeline).toHaveLength(1);
    expect(payload.timeline[0]?.what).toBe("indexed wedding-photos.zip");
    expect(payload.suggestionChips[0]).toBe("Carrier delays this week");
    expect(payload.suggestedTools).toEqual([]);
    expect(payload.systemChip.severity).toBe("ok");
  });

  it("greeting falls back to 'there' when no displayName/username", async () => {
    const prisma = createPrismaMock();
    const payload = await getHomePayload(
      prisma as unknown as import("@prisma/client").PrismaClient,
      {},
      new Date("2026-05-27T20:00:00"),
    );
    expect(payload.greeting.text).toBe("Good evening, there");
  });

  it("timeline dedupes by (what + sub)", async () => {
    const prisma = createPrismaMock({
      activityRows: [
        { at: new Date("2026-05-27T09:30:00Z"), severity: "ok", sourceIcon: "x", what: "A", sub: "1", kind: "file" },
        { at: new Date("2026-05-27T09:20:00Z"), severity: "ok", sourceIcon: "x", what: "A", sub: "1", kind: "file" },
        { at: new Date("2026-05-27T09:10:00Z"), severity: "ok", sourceIcon: "y", what: "B", sub: null, kind: "chat" },
      ],
    });
    const payload = await getHomePayload(
      prisma as unknown as import("@prisma/client").PrismaClient,
      { username: "s", role: "owner" },
      new Date("2026-05-27T10:00:00"),
    );
    expect(payload.timeline).toHaveLength(2);
  });

  it("singular vs plural sub copy is correct on tiles", async () => {
    const prisma = createPrismaMock({ filesCount: 1, camerasCount: 1, networkCount: 0, devicesCount: 1 });
    const payload = await getHomePayload(
      prisma as unknown as import("@prisma/client").PrismaClient,
      { username: "s" },
    );
    expect(payload.tiles.files.sub).toBe("1 file indexed");
    expect(payload.tiles.cameras.sub).toBe("1 camera");
    expect(payload.tiles.network.sub).toBe("0 active clients");
    expect(payload.tiles.devices.sub).toBe("1 paired device");
  });

  it("GET /api/home returns 200 + payload via the route", async () => {
    const prisma = createPrismaMock({ filesCount: 5, camerasCount: 2 });
    const app = buildApp(prisma, { username: "stefan", displayName: "Stefan", role: "family" });
    const res = await request(app).get("/api/home");
    expect(res.status).toBe(200);
    expect(res.body.greeting).toBeDefined();
    expect(res.body.tiles.files.count).toBe(5);
    expect(res.body.tiles.cameras.count).toBe(2);
    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(Array.isArray(res.body.suggestedTools)).toBe(true);
    expect(Array.isArray(res.body.suggestionChips)).toBe(true);
  });
});
