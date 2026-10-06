/**
 * POST /api/storage/network-drive/personal — per-user WebDAV drive login for
 * Finder / File Explorer (docs/network-drive.md "Per-user drive (WebDAV)").
 * Owner/admin/family only, and only while the owner has turned personal
 * drives on (`Workspace.personalDriveEnabled`, default off).
 *
 * Real config (default trusted origin https://droplet-ai.lan); Nextcloud,
 * cache, crypto, MQTT and push are stubbed like device-clients.routes.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  deviceClient: { create: vi.fn(), update: vi.fn() },
  workspace: { findUnique: vi.fn() },
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
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
vi.mock("../services/push-dispatch.service.js", () => ({
  dispatchToUser: vi.fn(),
  getPublicVapidKey: vi.fn(() => "vapid-pub"),
}));
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import {
  ncGenerateAppPassword,
  ncDeleteAppPassword,
} from "../services/nextcloud.client.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { cacheGet } from "../services/cache.service.js";
import { createDeviceClientsRouter } from "../routes/device-clients.js";

const mockNcGenerate = vi.mocked(ncGenerateAppPassword);
const mockNcDelete = vi.mocked(ncDeleteAppPassword);
const mockResolveNcToken = vi.mocked(resolveNcToken);
const mockCacheGet = vi.mocked(cacheGet);

const URL_PATH = "/api/storage/network-drive/personal";

function makeApp(role = "family", username = "alice") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id: "u1", username, displayName: "Alice", role };
    next();
  });
  app.use("/api", createDeviceClientsRouter(mockPrisma as any));
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

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveNcToken.mockResolvedValue("nc-token");
  mockNcGenerate.mockResolvedValue("app-pw-123");
  mockNcDelete.mockResolvedValue(undefined as never);
  mockCacheGet.mockResolvedValue(undefined as never);
  mockPrisma.deviceClient.create.mockResolvedValue({ id: "dc-1" });
  mockPrisma.workspace.findUnique.mockResolvedValue({ personalDriveEnabled: true });
});

describe("POST /api/storage/network-drive/personal", () => {
  it("mints a per-user app password and returns the connect payload once", async () => {
    const res = await request(makeApp())
      .post(URL_PATH)
      .send({ platform: "macos", computerName: "Alice's MacBook" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      deviceId: "dc-1",
      username: "alice",
      appPassword: "app-pw-123",
      webdavUrl: "https://droplet-ai.lan/nextcloud/remote.php/dav/files/alice/",
      macosUrl: "https://droplet-ai.lan/nextcloud/remote.php/dav/files/alice/",
      windowsPath:
        "\\\\droplet-ai.lan@SSL\\nextcloud\\remote.php\\dav\\files\\alice",
    });
    expect(mockPrisma.deviceClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "alice",
        deviceName: "Finder on Alice's MacBook",
        deviceType: "desktop",
        platform: "macos",
        ncAppPassword: "enc:app-pw-123",
        status: "active",
        // Explicit discriminator: "personal drives off" revokes by this column.
        kind: "personal_drive",
      }),
    });
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });

  it("percent-encodes the uid in the URL but keeps it raw in the UNC path", async () => {
    // Nextcloud uids may contain spaces (never \\, / or %). The URL form must be
    // encoded; Windows WebClient encodes UNC components itself.
    const res = await request(makeApp("family", "anne marie"))
      .post(URL_PATH)
      .send({ platform: "windows" });
    expect(res.status).toBe(200);
    expect(res.body.webdavUrl).toBe(
      "https://droplet-ai.lan/nextcloud/remote.php/dav/files/anne%20marie/",
    );
    expect(res.body.windowsPath).toBe(
      "\\\\droplet-ai.lan@SSL\\nextcloud\\remote.php\\dav\\files\\anne marie",
    );
  });

  it("defaults the device name per platform", async () => {
    await request(makeApp("family")).post(URL_PATH).send({ platform: "windows" });
    expect(mockPrisma.deviceClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        deviceName: "File Explorer on My PC",
        platform: "windows",
      }),
    });
  });

  it.each(["owner", "admin", "family"])("allows %s when personal drives are on", async (role) => {
    const res = await request(makeApp(role)).post(URL_PATH).send({ platform: "macos" });
    expect(res.status).toBe(200);
  });

  it.each(["guest", "service"])("403s %s without minting anything", async (role) => {
    const res = await request(makeApp(role)).post(URL_PATH).send({ platform: "macos" });
    expect(res.status).toBe(403);
    expect(mockNcGenerate).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.create).not.toHaveBeenCalled();
  });

  it.each(["owner", "admin", "family"])(
    "403s personal_drive_disabled for %s while the owner setting is off, minting nothing",
    async (role) => {
      mockPrisma.workspace.findUnique.mockResolvedValue({ personalDriveEnabled: false });
      const res = await request(makeApp(role)).post(URL_PATH).send({ platform: "macos" });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "personal_drive_disabled" });
      expect(mockNcGenerate).not.toHaveBeenCalled();
      expect(mockPrisma.deviceClient.create).not.toHaveBeenCalled();
      expect(recordActivityMock).not.toHaveBeenCalled();
    },
  );

  // The mint is a Nextcloud round-trip; a switch-off (whose revoke sweep has
  // already run) can land between the first check and the row insert.
  it.each([{ personalDriveEnabled: false }, null])(
    "revokes the login it just created and 403s when the owner switches off mid-mint (re-read: %j)",
    async (reread) => {
      mockPrisma.workspace.findUnique
        .mockResolvedValueOnce({ personalDriveEnabled: true })
        .mockResolvedValueOnce(reread);
      const res = await request(makeApp()).post(URL_PATH).send({ platform: "macos" });
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: "personal_drive_disabled" });
      expect(JSON.stringify(res.body)).not.toContain("app-pw-123");
      expect(mockPrisma.deviceClient.create).toHaveBeenCalledTimes(1);
      // Revoked upstream and in the database, never handed out or announced.
      expect(mockNcDelete).toHaveBeenCalledWith("app-pw-123");
      expect(mockPrisma.deviceClient.update).toHaveBeenCalledWith({
        where: { id: "dc-1" },
        data: { status: "revoked" },
      });
      expect(recordActivityMock).not.toHaveBeenCalled();
    },
  );

  it("reads the flag from the Workspace singleton (id = 1)", async () => {
    await request(makeApp()).post(URL_PATH).send({ platform: "macos" });
    expect(mockPrisma.workspace.findUnique).toHaveBeenCalledWith({
      where: { id: 1 },
      select: { personalDriveEnabled: true },
    });
  });

  it("treats a missing Workspace row as off", async () => {
    mockPrisma.workspace.findUnique.mockResolvedValue(null);
    const res = await request(makeApp()).post(URL_PATH).send({ platform: "macos" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "personal_drive_disabled" });
    expect(mockNcGenerate).not.toHaveBeenCalled();
  });

  it("fails closed (500, nothing minted) when the setting cannot be read", async () => {
    mockPrisma.workspace.findUnique.mockRejectedValue(new Error("db down"));
    const res = await request(makeApp()).post(URL_PATH).send({ platform: "macos" });
    expect(res.status).toBe(500);
    expect(mockNcGenerate).not.toHaveBeenCalled();
  });

  it("400s an unknown platform", async () => {
    const res = await request(makeApp()).post(URL_PATH).send({ platform: "linux" });
    expect(res.status).toBe(400);
    expect(mockNcGenerate).not.toHaveBeenCalled();
  });

  it("409s nc_credential_unavailable when the session has no Nextcloud token", async () => {
    mockResolveNcToken.mockResolvedValue(null);
    const res = await request(makeApp()).post(URL_PATH).send({ platform: "macos" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "nc_credential_unavailable" });
    expect(mockPrisma.deviceClient.create).not.toHaveBeenCalled();
  });

  it("502s when Nextcloud refuses to mint", async () => {
    mockNcGenerate.mockResolvedValue(null as never);
    const res = await request(makeApp()).post(URL_PATH).send({ platform: "macos" });
    expect(res.status).toBe(502);
  });

  it("429s once the per-user hourly budget is spent", async () => {
    mockCacheGet.mockResolvedValue(10 as never);
    const res = await request(makeApp()).post(URL_PATH).send({ platform: "macos" });
    expect(res.status).toBe(429);
    expect(mockNcGenerate).not.toHaveBeenCalled();
  });

  it("deletes the minted app password when the DB write fails", async () => {
    mockPrisma.deviceClient.create.mockRejectedValue(new Error("db down"));
    const res = await request(makeApp()).post(URL_PATH).send({ platform: "macos" });
    expect(res.status).toBe(500);
    expect(mockNcDelete).toHaveBeenCalledWith("app-pw-123");
  });
});
