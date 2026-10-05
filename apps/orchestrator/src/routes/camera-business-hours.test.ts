import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
const resolveEffectiveAccess = vi.hoisted(() => vi.fn());
vi.mock("../services/effective-access.service.js", () => ({ resolveEffectiveAccess }));
import { createCameraBusinessHoursRouter } from "./camera-business-hours.js";
import { emptyCameraBusinessHours } from "../services/camera-business-hours.service.js";

const findUnique = vi.fn();
const upsert = vi.fn();
const prisma = { systemFlag: { findUnique, upsert } } as unknown as PrismaClient;
function app(role?: string) {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (role) req.user = { id: "test", username: "test", displayName: "Test", role: role as never };
    next();
  });
  server.use("/api", createCameraBusinessHoursRouter(prisma));
  return server;
}
beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(null);
  upsert.mockReset().mockResolvedValue({});
  resolveEffectiveAccess.mockReset().mockResolvedValue(null);
});

describe("camera business hours routes", () => {
  it.each(["owner", "admin", "family"])("lets camera viewers read hours (%s)", async (role) => {
    const response = await request(app(role)).get("/api/cameras/business-hours");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(emptyCameraBusinessHours());
  });
  it.each([undefined, "guest", "service"])("denies reading for %s", async (role) => {
    expect((await request(app(role)).get("/api/cameras/business-hours")).status).toBe(403);
    expect(findUnique).not.toHaveBeenCalled();
  });
  it.each(["owner", "admin"])("saves validated hours for %s", async (role) => {
    const hours = { ...emptyCameraBusinessHours(), configured: true, timezone: "America/Los_Angeles" };
    const response = await request(app(role)).put("/api/cameras/business-hours").send(hours);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(hours);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, "family", "guest", "service"])("denies configuring for %s", async (role) => {
    expect((await request(app(role)).put("/api/cameras/business-hours").send(emptyCameraBusinessHours())).status).toBe(403);
    expect(upsert).not.toHaveBeenCalled();
  });
  it("returns validation details and refuses an invalid schedule", async () => {
    const response = await request(app("owner")).put("/api/cameras/business-hours")
      .send({ ...emptyCameraBusinessHours(), timezone: "Not/AZone" });
    expect(response.status).toBe(400);
    expect(response.body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "timezone" })]));
    expect(upsert).not.toHaveBeenCalled();
  });
  it("honors a narrowed administrator's feature access", async () => {
    resolveEffectiveAccess.mockResolvedValue({ features: [{ moduleId: "cameras", level: "view" }] });
    expect((await request(app("admin")).put("/api/cameras/business-hours").send(emptyCameraBusinessHours())).status).toBe(404);
    expect(upsert).not.toHaveBeenCalled();
  });
});
