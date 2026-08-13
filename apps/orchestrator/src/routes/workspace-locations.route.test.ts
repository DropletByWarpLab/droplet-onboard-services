/**
 * WARP-1906 — `/api/workspace-locations` CRUD route tests.
 *
 * What this file pins:
 *   - reads are member-wide (any authenticated role — the suggestions and the
 *     settings list both consume it), unauthenticated is 401;
 *   - every write (POST/PATCH/DELETE) is admin-gated with the same
 *     requireRole("owner","admin") posture as the other workspace admin
 *     writes — a non-admin write is 403 AND never touches prisma;
 *   - duplicate building+room is a 409 (case-insensitive), blank fields 400;
 *   - createdBy stamps the USERNAME (Workspace.setBy shape, WARP-1014);
 *   - responses carry the composed canonical `label` ("HQ - Room Aurora").
 *
 * Prisma is a lightweight hand-rolled mock (departments.detail.test.ts
 * pattern) — no real DB.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn(),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));
vi.mock("../services/activity.service.js", () => ({
  actorFromRequest: vi.fn(() => ({ type: "user", id: "caller" })),
}));

import { createWorkspaceLocationsRouter } from "./workspace-locations.js";

const ROW = {
  id: "loc-1",
  building: "HQ",
  room: "Room Aurora",
  createdBy: "stefan",
  createdAt: new Date("2026-08-12T00:00:00Z"),
  updatedAt: new Date("2026-08-12T00:00:00Z"),
};

function mkPrisma() {
  return {
    workspaceLocation: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(ROW),
      update: vi.fn().mockResolvedValue(ROW),
      delete: vi.fn().mockResolvedValue(ROW),
    },
  };
}

type Identity = { id: string; username: string; role: string } | undefined;

function mkApp(prisma: ReturnType<typeof mkPrisma>, user: Identity) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: Identity }).user = user;
    next();
  });
  app.use("/api", createWorkspaceLocationsRouter(prisma as never));
  return app;
}

const ADMIN: Identity = { id: "u-admin", username: "stefan", role: "admin" };
const MEMBER: Identity = { id: "u-fam", username: "sam", role: "family" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/workspace-locations", () => {
  it("401s an unauthenticated request", async () => {
    const res = await request(mkApp(mkPrisma(), undefined)).get(
      "/api/workspace-locations",
    );
    expect(res.status).toBe(401);
  });

  it("lists rooms with the composed label for ANY member — reads are not admin-gated", async () => {
    const prisma = mkPrisma();
    prisma.workspaceLocation.findMany.mockResolvedValueOnce([ROW]);
    const res = await request(mkApp(prisma, MEMBER)).get(
      "/api/workspace-locations",
    );
    expect(res.status).toBe(200);
    expect(res.body.locations).toHaveLength(1);
    expect(res.body.locations[0]).toMatchObject({
      id: "loc-1",
      building: "HQ",
      room: "Room Aurora",
      label: "HQ - Room Aurora",
    });
    // Stable building-then-room ordering — the settings list groups visually
    // by building without client-side sorting.
    expect(prisma.workspaceLocation.findMany).toHaveBeenCalledWith({
      orderBy: [{ building: "asc" }, { room: "asc" }],
    });
  });
});

describe("POST /api/workspace-locations", () => {
  it("creates a room as admin — trims input and stamps createdBy with the username", async () => {
    const prisma = mkPrisma();
    const res = await request(mkApp(prisma, ADMIN))
      .post("/api/workspace-locations")
      .send({ building: "  HQ ", room: " Room Aurora  " });
    expect(res.status).toBe(201);
    expect(res.body.location.label).toBe("HQ - Room Aurora");
    expect(prisma.workspaceLocation.create).toHaveBeenCalledWith({
      data: { building: "HQ", room: "Room Aurora", createdBy: "stefan" },
    });
  });

  it("403s a non-admin write and never touches prisma (the admin gate)", async () => {
    const prisma = mkPrisma();
    const res = await request(mkApp(prisma, MEMBER))
      .post("/api/workspace-locations")
      .send({ building: "HQ", room: "Room Aurora" });
    expect(res.status).toBe(403);
    expect(prisma.workspaceLocation.create).not.toHaveBeenCalled();
  });

  it("409s a duplicate building+room (case-insensitive)", async () => {
    const prisma = mkPrisma();
    prisma.workspaceLocation.findFirst.mockResolvedValueOnce(ROW);
    const res = await request(mkApp(prisma, ADMIN))
      .post("/api/workspace-locations")
      .send({ building: "hq", room: "room aurora" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_LOCATION");
    expect(prisma.workspaceLocation.create).not.toHaveBeenCalled();
  });

  it("400s a blank building", async () => {
    const prisma = mkPrisma();
    const res = await request(mkApp(prisma, ADMIN))
      .post("/api/workspace-locations")
      .send({ building: "   ", room: "Room Aurora" });
    expect(res.status).toBe(400);
    expect(prisma.workspaceLocation.create).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/workspace-locations/:id", () => {
  it("renames a room as admin", async () => {
    const prisma = mkPrisma();
    prisma.workspaceLocation.findUnique.mockResolvedValueOnce(ROW);
    prisma.workspaceLocation.update.mockResolvedValueOnce({
      ...ROW,
      room: "Fishbowl",
    });
    const res = await request(mkApp(prisma, ADMIN))
      .patch("/api/workspace-locations/loc-1")
      .send({ room: "Fishbowl" });
    expect(res.status).toBe(200);
    expect(res.body.location.label).toBe("HQ - Fishbowl");
    expect(prisma.workspaceLocation.update).toHaveBeenCalledWith({
      where: { id: "loc-1" },
      data: { building: "HQ", room: "Fishbowl" },
    });
  });

  it("404s an unknown id", async () => {
    const prisma = mkPrisma();
    const res = await request(mkApp(prisma, ADMIN))
      .patch("/api/workspace-locations/loc-404")
      .send({ room: "Fishbowl" });
    expect(res.status).toBe(404);
    expect(prisma.workspaceLocation.update).not.toHaveBeenCalled();
  });

  it("403s a non-admin rename and never touches prisma", async () => {
    const prisma = mkPrisma();
    prisma.workspaceLocation.findUnique.mockResolvedValueOnce(ROW);
    const res = await request(mkApp(prisma, MEMBER))
      .patch("/api/workspace-locations/loc-1")
      .send({ room: "Fishbowl" });
    expect(res.status).toBe(403);
    expect(prisma.workspaceLocation.update).not.toHaveBeenCalled();
  });

  it("409s when the rename collides with another row", async () => {
    const prisma = mkPrisma();
    prisma.workspaceLocation.findUnique.mockResolvedValueOnce(ROW);
    prisma.workspaceLocation.findFirst.mockResolvedValueOnce({
      ...ROW,
      id: "loc-2",
      room: "Fishbowl",
    });
    const res = await request(mkApp(prisma, ADMIN))
      .patch("/api/workspace-locations/loc-1")
      .send({ room: "Fishbowl" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_LOCATION");
    expect(prisma.workspaceLocation.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/workspace-locations/:id", () => {
  it("removes a room as admin", async () => {
    const prisma = mkPrisma();
    prisma.workspaceLocation.findUnique.mockResolvedValueOnce(ROW);
    const res = await request(mkApp(prisma, ADMIN)).delete(
      "/api/workspace-locations/loc-1",
    );
    expect(res.status).toBe(204);
    expect(prisma.workspaceLocation.delete).toHaveBeenCalledWith({
      where: { id: "loc-1" },
    });
  });

  it("404s an unknown id", async () => {
    const prisma = mkPrisma();
    const res = await request(mkApp(prisma, ADMIN)).delete(
      "/api/workspace-locations/loc-404",
    );
    expect(res.status).toBe(404);
    expect(prisma.workspaceLocation.delete).not.toHaveBeenCalled();
  });

  it("403s a non-admin delete and never touches prisma", async () => {
    const prisma = mkPrisma();
    prisma.workspaceLocation.findUnique.mockResolvedValueOnce(ROW);
    const res = await request(mkApp(prisma, MEMBER)).delete(
      "/api/workspace-locations/loc-1",
    );
    expect(res.status).toBe(403);
    expect(prisma.workspaceLocation.delete).not.toHaveBeenCalled();
  });
});
