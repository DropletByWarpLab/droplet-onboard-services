import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
const fetchRecordings = vi.hoisted(() => vi.fn());
const getCameras = vi.hoisted(() => vi.fn());
vi.mock("../services/frigate.client.js", () => ({ fetchRecordings }));
vi.mock("../services/camera.service.js", () => ({ getCameras }));
import { createCameraMotionRouter } from "./camera-motion.js";
import { emptyCameraBusinessHours } from "../services/camera-business-hours.service.js";
import { userDirectory } from "../__tests__/helpers/user-directory.js";

const after = Date.parse("2026-10-05T17:00:00Z") / 1000, before = after + 3600;
const hours = { ...emptyCameraBusinessHours(), configured: true };
hours.days.monday = { open: "09:00", close: "17:00" };
const grantRead = vi.fn();
const prisma = { systemFlag: { findUnique: async () => ({ valueJson: hours }) },
  cameraAccessGrant: { findMany: grantRead } } as unknown as PrismaClient;
function app(role?: string) {
  const server = express();
  server.use((req, _res, next) => {
    if (role) req.user = { id: "test", username: "test", displayName: "Test", role: role as never };
    next();
  });
  server.use("/api", createCameraMotionRouter(prisma));
  return server;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-05T20:00:00Z"));
  fetchRecordings.mockReset().mockResolvedValue([{ start_time: after, end_time: after + 10, motion: 23 }]);
  getCameras.mockReset().mockResolvedValue([{ name: "office" }, { name: "bedroom" }]);
  grantRead.mockReset().mockResolvedValue([{ camera: { name: "office" } }]);
});
afterEach(() => vi.useRealTimers());
const query = `after=${after}&before=${before}`;

describe("retained motion route", () => {
  it.each([undefined, "guest", "service"])("denies non-viewers (%s) before reading footage", async (role) => {
    expect((await request(app(role)).get(`/api/cameras/motion?${query}`)).status).toBe(403);
    expect(fetchRecordings).not.toHaveBeenCalled();
  });
  it("scopes camera selection, activity and coverage before upstream recording fetches", async () => {
    const response = await request(app("family")).get(`/api/cameras/motion?${query}&cameras=office,bedroom&businessHours=outside`);
    expect(response.status).toBe(200);
    expect(response.body.activity).toHaveLength(1);
    expect(response.body.activity[0]).toMatchObject({ camera: "office", motion: 23, outsideBusinessHours: true });
    expect(response.body.coverage.cameras.map((camera: { camera: string }) => camera.camera)).toEqual(["office"]);
    expect(fetchRecordings).toHaveBeenCalledExactlyOnceWith("office", after, before);
    expect(getCameras).not.toHaveBeenCalled();
  });
  it("uses only granted cameras when a viewer omits camera selection", async () => {
    const response = await request(app("family")).get(`/api/cameras/motion?${query}`);
    expect(response.status).toBe(200);
    expect(fetchRecordings).toHaveBeenCalledExactlyOnceWith("office", after, before);
  });
  it("returns no footage or leaked camera names when no cameras are granted", async () => {
    grantRead.mockResolvedValue([]);
    const response = await request(app("family")).get(`/api/cameras/motion?${query}&cameras=bedroom`);
    expect(response.body.activity).toEqual([]);
    expect(response.body.coverage.cameras).toEqual([]);
    expect(fetchRecordings).not.toHaveBeenCalled();
  });
  it.each(["after=1&before=1000000", `after=${after}&before=${before}&businessHours=wrong`,
    `${query}&cursor=invalid`, `${query}&cameras=../secret`, `${query}&limit=201`])("rejects invalid or unbounded windows: %s", async (params) => {
    expect((await request(app("owner")).get(`/api/cameras/motion?${params}`)).status).toBe(400);
    expect(fetchRecordings).not.toHaveBeenCalled();
  });
  it("defaults to the last 24 hours and lists cameras for an unrestricted owner", async () => {
    const response = await request(app("owner")).get("/api/cameras/motion");
    expect(response.status).toBe(200);
    expect(response.body.coverage.before - response.body.coverage.after).toBe(86400);
    expect(getCameras).toHaveBeenCalledTimes(1);
    expect(fetchRecordings.mock.calls.map((call) => call[0])).toEqual(["office", "bedroom"]);
  });
});

// WARP-3927: get_camera_motion / summarize_camera_activity read this route as the
// `_service:mcp` principal. It is admitted, but only as the person it acts for.
describe("retained motion route — MCP principal (WARP-3927)", () => {
  const directory = userDirectory([
    { id: "u-sam", username: "sam", nextcloudUsername: "sam", role: "family" },
    { id: "u-romain", username: "romain", nextcloudUsername: "romain", role: "owner" },
  ]);
  const mcpPrisma = { user: directory, systemFlag: { findUnique: async () => ({ valueJson: hours }) },
    cameraAccessGrant: { findMany: grantRead } } as unknown as PrismaClient;
  function mcpApp() {
    const server = express();
    server.use((req, _res, next) => {
      req.user = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" };
      next();
    });
    server.use("/api", createCameraMotionRouter(mcpPrisma));
    return server;
  }
  it("is admitted and scoped to the acting person's granted cameras", async () => {
    const response = await request(mcpApp()).get(`/api/cameras/motion?${query}&cameras=office,bedroom`).set("X-Nextcloud-User", "sam");
    expect(response.status).toBe(200);
    expect(response.body.coverage.cameras.map((camera: { camera: string }) => camera.camera)).toEqual(["office"]);
    expect(fetchRecordings).toHaveBeenCalledExactlyOnceWith("office", after, before);
  });
  it("lets an acting owner see every camera", async () => {
    const response = await request(mcpApp()).get(`/api/cameras/motion?${query}`).set("X-Nextcloud-User", "romain");
    expect(response.status).toBe(200);
    expect(fetchRecordings.mock.calls.map((call) => call[0])).toEqual(["office", "bedroom"]);
  });
  it("gets nothing when it does not say who is asking", async () => {
    const response = await request(mcpApp()).get(`/api/cameras/motion?${query}`);
    expect(response.status).toBe(401);
    expect(fetchRecordings).not.toHaveBeenCalled();
  });
});
