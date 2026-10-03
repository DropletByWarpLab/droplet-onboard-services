/**
 * WARP-3384 — the owner/admin view of a person's paired devices, and the admin
 * revoke of someone else's client.
 *
 *   GET    /api/admin/devices/clients?userId=   owner/admin only
 *   DELETE /api/admin/devices/clients/:id        owner/admin only, audited
 *
 * And the additive `kind` on the caller's OWN list (`GET /api/devices/clients`),
 * which keeps its shape otherwise. Nextcloud, cache, crypto, MQTT and push are
 * stubbed like device-clients.personal-drive.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  deviceClient: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  user: { findMany: vi.fn() },
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

import { ncDeleteAppPassword } from "../services/nextcloud.client.js";
import { createDeviceClientsRouter } from "../routes/device-clients.js";

const mockNcDelete = vi.mocked(ncDeleteAppPassword);

const LIST = "/api/admin/devices/clients";

function makeApp(role: string, username = "root", id = "u-root") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = { id, username, displayName: "Root", role };
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

function clientRow(over: Record<string, unknown> = {}) {
  return {
    id: "dc-1",
    userId: "alice",
    deviceName: "Alice's MacBook",
    deviceType: "desktop",
    platform: "macos",
    appVersion: "1.2.3",
    kind: "app_pairing",
    ncAppPassword: "enc:the-secret-app-password",
    lastSeen: new Date("2026-10-01T10:00:00.000Z"),
    status: "active",
    createdAt: new Date("2026-09-20T09:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockNcDelete.mockResolvedValue(true);
  mockPrisma.deviceClient.findMany.mockResolvedValue([]);
  mockPrisma.deviceClient.findUnique.mockResolvedValue(null);
  mockPrisma.deviceClient.update.mockResolvedValue({});
  mockPrisma.user.findMany.mockResolvedValue([]);
});

describe("GET /api/admin/devices/clients", () => {
  it.each(["owner", "admin"])("lets %s list a person's clients, labelled by kind and owner", async (role) => {
    mockPrisma.deviceClient.findMany.mockResolvedValue([
      clientRow({ id: "dc-app", kind: "app_pairing" }),
      clientRow({ id: "dc-drive", kind: "personal_drive", deviceName: "Finder on My Mac" }),
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { username: "alice", displayName: "Alice Martin", directoryStatus: "ACTIVE" },
    ]);

    const res = await request(makeApp(role)).get(`${LIST}?userId=alice`);

    expect(res.status).toBe(200);
    expect(mockPrisma.deviceClient.findMany).toHaveBeenCalledWith({
      where: { userId: "alice" },
      orderBy: { createdAt: "desc" },
    });
    expect(res.body.clients).toEqual([
      {
        id: "dc-app",
        deviceName: "Alice's MacBook",
        deviceType: "desktop",
        platform: "macos",
        appVersion: "1.2.3",
        kind: "app_pairing",
        lastSeen: "2026-10-01T10:00:00.000Z",
        status: "active",
        createdAt: "2026-09-20T09:00:00.000Z",
        userId: "alice",
        displayName: "Alice Martin",
        personStatus: "active",
      },
      expect.objectContaining({ id: "dc-drive", kind: "personal_drive", deviceName: "Finder on My Mac" }),
    ]);
    // The encrypted app password never leaves the box.
    expect(JSON.stringify(res.body)).not.toContain("the-secret-app-password");
  });

  it("without userId lists everyone, and says whether each owner is active, deactivated or removed", async () => {
    mockPrisma.deviceClient.findMany.mockResolvedValue([
      clientRow({ id: "dc-a", userId: "alice" }),
      clientRow({ id: "dc-b", userId: "bob", status: "revoked" }),
      clientRow({ id: "dc-c", userId: "carol" }),
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { username: "alice", displayName: "Alice Martin", directoryStatus: "ACTIVE" },
      { username: "bob", displayName: "Bob Leaver", directoryStatus: "DEACTIVATED" },
    ]);

    const res = await request(makeApp("owner")).get(LIST);

    expect(res.status).toBe(200);
    expect(mockPrisma.deviceClient.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: "desc" },
    });
    // One lookup for the people, for the distinct owners only.
    expect(mockPrisma.user.findMany).toHaveBeenCalledWith({
      where: { username: { in: ["alice", "bob", "carol"] } },
      select: { username: true, displayName: true, directoryStatus: true },
    });
    const byId = Object.fromEntries(res.body.clients.map((c: any) => [c.id, c]));
    expect(byId["dc-a"]).toMatchObject({ displayName: "Alice Martin", personStatus: "active" });
    expect(byId["dc-b"]).toMatchObject({ displayName: "Bob Leaver", personStatus: "deactivated", status: "revoked" });
    // A deleted person (no User row) still shows their rows, by username.
    expect(byId["dc-c"]).toMatchObject({ userId: "carol", displayName: "carol", personStatus: "removed" });
  });

  it("400s a malformed userId without touching the database", async () => {
    const res = await request(makeApp("admin")).get(`${LIST}?userId=a&userId=b`);
    expect(res.status).toBe(400);
    expect(mockPrisma.deviceClient.findMany).not.toHaveBeenCalled();
  });

  it.each(["family", "guest", "service"])("refuses %s with 403 and reads nothing", async (role) => {
    const res = await request(makeApp(role)).get(`${LIST}?userId=alice`);
    expect(res.status).toBe(403);
    expect(mockPrisma.deviceClient.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/devices/clients/:id", () => {
  it.each(["owner", "admin"])(
    "lets %s revoke another person's client and audits the actor AND the person",
    async (role) => {
      mockPrisma.deviceClient.findUnique.mockResolvedValue(clientRow({ userId: "alice" }));

      const res = await request(makeApp(role, "root", "u-root")).delete(`${LIST}/dc-1`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ revoked: "dc-1", appPasswordDeleted: true });
      expect(mockNcDelete).toHaveBeenCalledWith("the-secret-app-password");
      expect(mockPrisma.deviceClient.update).toHaveBeenCalledWith({
        where: { id: "dc-1" },
        data: { status: "revoked" },
      });
      expect(recordActivityMock).toHaveBeenCalledTimes(1);
      expect(recordActivityMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "auth",
          severity: "warn",
          what: "Device client revoked by an admin",
          sub: "Alice's MacBook · alice",
          actor: { type: "user", id: "u-root" },
          refs: expect.objectContaining({
            clientId: "dc-1",
            targetUsername: "alice",
            actor: "root",
            kind: "app_pairing",
            appPasswordDeleted: true,
            via: "admin",
          }),
        }),
      );
    },
  );

  it("reports an app password Nextcloud did not confirm deleting: marked revoked, flagged, audited as an error", async () => {
    mockNcDelete.mockResolvedValue(false);
    mockPrisma.deviceClient.findUnique.mockResolvedValue(clientRow());

    const res = await request(makeApp("admin")).delete(`${LIST}/dc-1`);

    expect(res.status).toBe(200);
    expect(res.body.revoked).toBe("dc-1");
    expect(res.body.appPasswordDeleted).toBe(false);
    expect(res.body.warning).toMatch(/may still be able to sync/);
    expect(mockPrisma.deviceClient.update).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "err",
        what: "Device client revoked by an admin, but its app password may still work",
        refs: expect.objectContaining({ appPasswordDeleted: false, targetUsername: "alice" }),
      }),
    );
  });

  it("does not hide a Nextcloud delete that throws", async () => {
    mockNcDelete.mockRejectedValue(new Error("nextcloud down"));
    mockPrisma.deviceClient.findUnique.mockResolvedValue(clientRow());

    const res = await request(makeApp("admin")).delete(`${LIST}/dc-1`);

    expect(res.status).toBe(200);
    expect(res.body.appPasswordDeleted).toBe(false);
  });

  it("is idempotent: an already-revoked client reports null and writes no audit row", async () => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(clientRow({ status: "revoked" }));

    const res = await request(makeApp("admin")).delete(`${LIST}/dc-1`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: "dc-1", appPasswordDeleted: null });
    expect(mockNcDelete).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("404s an unknown id", async () => {
    const res = await request(makeApp("owner")).delete(`${LIST}/nope`);
    expect(res.status).toBe(404);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it.each(["family", "guest", "service"])("refuses %s with 403 and revokes nothing", async (role) => {
    mockPrisma.deviceClient.findUnique.mockResolvedValue(clientRow());

    const res = await request(makeApp(role)).delete(`${LIST}/dc-1`);

    expect(res.status).toBe(403);
    expect(mockPrisma.deviceClient.findUnique).not.toHaveBeenCalled();
    expect(mockNcDelete).not.toHaveBeenCalled();
    expect(mockPrisma.deviceClient.update).not.toHaveBeenCalled();
    // The role guard audits the denial itself; no revoke row is written.
    expect(recordActivityMock.mock.calls.map((c) => c[0].what)).toEqual(["Access denied"]);
  });
});

describe("GET /api/devices/clients (the caller's own list)", () => {
  it("is additive: `kind` is present, and the shape is otherwise unchanged", async () => {
    mockPrisma.deviceClient.findMany.mockResolvedValue([
      clientRow({ id: "dc-app", userId: "alice", kind: "app_pairing" }),
      clientRow({ id: "dc-drive", userId: "alice", kind: "personal_drive", deviceName: "Finder on My Mac" }),
    ]);

    const res = await request(makeApp("family", "alice", "u-alice")).get("/api/devices/clients");

    expect(res.status).toBe(200);
    expect(mockPrisma.deviceClient.findMany).toHaveBeenCalledWith({
      where: { userId: "alice" },
      orderBy: { createdAt: "desc" },
    });
    expect(res.body.clients.map((c: any) => c.kind)).toEqual(["app_pairing", "personal_drive"]);
    expect(Object.keys(res.body.clients[0]).sort()).toEqual([
      "appVersion",
      "createdAt",
      "deviceName",
      "deviceType",
      "id",
      "kind",
      "lastSeen",
      "platform",
      "status",
    ]);
    expect(JSON.stringify(res.body)).not.toContain("the-secret-app-password");
  });
});
