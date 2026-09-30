/**
 * `/api/settings/workspace` route tests (business-only build, WARP-1341).
 *
 * WARP-1014 key-shape audit: `Workspace.setBy` stores the username (the
 * schema documents the column as "Nextcloud username from the auth
 * middleware", and every existing row was written through a helper that
 * always resolved to `req.user.username`). These tests pin that the
 * route writes the username EXPLICITLY — with an identity where
 * id ≠ username (the production shape), `setBy` must never flip to the
 * User.id UUID, or the attribution shape of existing rows would fork.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import request from "supertest";
import { WorkspaceType } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

// The global setup.ts prisma mock doesn't export the WorkspaceType enum
// the route imports as a value — mirror the generated const-object here
// (same pattern as files-brain.test.ts's BrainMemoryItemStatus).
vi.mock("@prisma/client", () => ({
  PrismaClient: vi.fn(),
  WorkspaceType: { HOME: "HOME", BUSINESS: "BUSINESS" },
  Prisma: { PrismaClientKnownRequestError: class extends Error {} },
}));

// "Personal drives off" revokes DeviceClient rows through the shared revoke
// helper; Nextcloud, crypto, MQTT and the activity log are stubbed like
// device-clients.personal-drive.test.ts.
vi.mock("../services/nextcloud.client.js", () => ({
  ncDeleteAppPassword: vi.fn(),
}));
vi.mock("../services/encryption.service.js", () => ({
  decryptSecret: vi.fn((s: string) => s.replace(/^enc:/, "")),
}));
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createSettingsWorkspaceRouter } from "../routes/settings-workspace.js";
import { ncDeleteAppPassword } from "../services/nextcloud.client.js";
import { publish } from "../services/mqtt.service.js";

const UUID = "6f0f5a3e-2f4b-4a4e-9d7e-0a1b2c3d4e5f";

const findUniqueMock = vi.fn();
const upsertMock = vi.fn();
const deviceClientFindMany = vi.fn();
const deviceClientUpdate = vi.fn();
const prisma = {
  workspace: { findUnique: findUniqueMock, upsert: upsertMock },
  deviceClient: { findMany: deviceClientFindMany, update: deviceClientUpdate },
} as unknown as PrismaClient;

let app: import("express").Express;
let identity: { id: string; username: string; role: string } | null;

beforeAll(async () => {
  const express = (await import("express")).default;
  const _app = express();
  _app.use(express.json());
  _app.use((req, _res, next) => {
    if (identity) {
      (
        req as { user?: { id: string; username: string; role: string } }
      ).user = identity;
    }
    next();
  });
  _app.use("/api", createSettingsWorkspaceRouter(prisma));
  app = _app;
});

beforeEach(() => {
  findUniqueMock.mockReset();
  upsertMock.mockReset();
  deviceClientFindMany.mockReset().mockResolvedValue([]);
  deviceClientUpdate.mockReset().mockResolvedValue({});
  recordActivityMock.mockClear();
  vi.mocked(ncDeleteAppPassword).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(publish).mockClear();
  identity = { id: UUID, username: "romain", role: "owner" };
});

describe("GET /api/settings/workspace", () => {
  it("returns 401 when unauthenticated", async () => {
    identity = null;
    const res = await request(app).get("/api/settings/workspace");
    expect(res.status).toBe(401);
  });

  it("returns the BUSINESS default when the singleton row doesn't exist (WARP-1341)", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const res = await request(app).get("/api/settings/workspace");
    expect(res.status).toBe(200);
    expect(res.body.workspaceType).toBe("business");
    expect(res.body.setBy).toBeNull();
    // Personal drives are off until the owner turns them on.
    expect(res.body.personalDriveEnabled).toBe(false);
  });

  it.each(["family", "guest"])(
    "reports personalDriveEnabled to a %s session (the dialog needs it)",
    async (role) => {
      identity = { id: UUID, username: "sam", role };
      findUniqueMock.mockResolvedValueOnce({
        type: WorkspaceType.BUSINESS,
        displayName: null,
        setBy: "romain",
        setAt: new Date("2026-07-11T00:00:00Z"),
        personalDriveEnabled: true,
      });
      const res = await request(app).get("/api/settings/workspace");
      expect(res.status).toBe(200);
      expect(res.body.personalDriveEnabled).toBe(true);
    },
  );

  it("reports a stale pre-migration HOME row as business (WARP-1341)", async () => {
    findUniqueMock.mockResolvedValueOnce({
      type: WorkspaceType.HOME,
      displayName: null,
      setBy: "romain",
      setAt: new Date("2026-07-11T00:00:00Z"),
    });
    const res = await request(app).get("/api/settings/workspace");
    expect(res.status).toBe(200);
    expect(res.body.workspaceType).toBe("business");
  });
});

describe("POST /api/settings/workspace", () => {
  it("stamps setBy with the username, never the User.id UUID (WARP-1014 audit)", async () => {
    upsertMock.mockResolvedValueOnce({
      type: WorkspaceType.BUSINESS,
      displayName: null,
      setBy: "romain",
      setAt: new Date("2026-07-11T00:00:00Z"),
    });

    const res = await request(app)
      .post("/api/settings/workspace")
      .send({ workspaceType: "business" });
    expect(res.status).toBe(200);
    expect(res.body.workspaceType).toBe("business");

    expect(upsertMock).toHaveBeenCalledTimes(1);
    const args = upsertMock.mock.calls[0][0];
    expect(args.update.setBy).toBe("romain");
    expect(args.create.setBy).toBe("romain");
  });

  it("rejects non-owners with 403", async () => {
    identity = { id: UUID, username: "romain", role: "admin" };
    const res = await request(app)
      .post("/api/settings/workspace")
      .send({ workspaceType: "business" });
    expect(res.status).toBe(403);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it("rejects the retired 'home' wire value with 400 (WARP-1341)", async () => {
    const res = await request(app)
      .post("/api/settings/workspace")
      .send({ workspaceType: "home" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("PUT /api/settings/workspace/personal-drive", () => {
  const URL_PATH = "/api/settings/workspace/personal-drive";

  it("lets the owner turn personal drives on, on the singleton row", async () => {
    upsertMock.mockResolvedValueOnce({ personalDriveEnabled: true });
    const res = await request(app).put(URL_PATH).send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ personalDriveEnabled: true });
    expect(upsertMock).toHaveBeenCalledWith({
      where: { id: 1 },
      update: { personalDriveEnabled: true },
      create: { id: 1, personalDriveEnabled: true },
    });
  });

  it("lets the owner turn them off again (nothing to revoke: revokedDriveLogins 0)", async () => {
    upsertMock.mockResolvedValueOnce({ personalDriveEnabled: false });
    const res = await request(app).put(URL_PATH).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ personalDriveEnabled: false, revokedDriveLogins: 0 });
    expect(upsertMock.mock.calls[0][0].update).toEqual({ personalDriveEnabled: false });
  });

  describe("turning off signs out the personal drives", () => {
    type Row = {
      id: string;
      userId: string;
      ncAppPassword: string;
      status: string;
      kind: "app_pairing" | "personal_drive";
    };
    let rows: Row[];

    beforeEach(() => {
      // A tiny DeviceClient table that honours findMany's `where`, so the test
      // shows which rows the route actually reaches rather than asserting a mock.
      rows = [
        { id: "drive-a", userId: "alice", ncAppPassword: "enc:pw-a", status: "active", kind: "personal_drive" },
        { id: "drive-b", userId: "bob", ncAppPassword: "enc:pw-b", status: "active", kind: "personal_drive" },
        { id: "drive-old", userId: "carol", ncAppPassword: "enc:pw-old", status: "revoked", kind: "personal_drive" },
        { id: "app-mac", userId: "alice", ncAppPassword: "enc:pw-app", status: "active", kind: "app_pairing" },
      ];
      deviceClientFindMany.mockImplementation(
        async ({ where }: { where: { kind: string; status: string } }) =>
          rows.filter((r) => r.kind === where.kind && r.status === where.status),
      );
      deviceClientUpdate.mockImplementation(
        async ({ where, data }: { where: { id: string }; data: Partial<Row> }) =>
          Object.assign(rows.find((r) => r.id === where.id)!, data),
      );
      upsertMock.mockResolvedValue({ personalDriveEnabled: false });
    });

    it("revokes every ACTIVE personal_drive login, leaves app pairings alone, and reports the count", async () => {
      const res = await request(app).put(URL_PATH).send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ personalDriveEnabled: false, revokedDriveLogins: 2 });

      expect(deviceClientFindMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { kind: "personal_drive", status: "active" } }),
      );
      const byId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
      expect(byId).toEqual({
        "drive-a": "revoked",
        "drive-b": "revoked",
        "drive-old": "revoked",
        "app-mac": "active",
      });
      // The Nextcloud app passwords of the two live drive logins were revoked upstream;
      // the pairing's and the already-revoked row's were not touched.
      expect(vi.mocked(ncDeleteAppPassword).mock.calls.map((c) => c[0]).sort()).toEqual(["pw-a", "pw-b"]);
      expect(vi.mocked(publish)).toHaveBeenCalledWith("droplet/devices/alice/revoked", { deviceId: "drive-a" });
      expect(vi.mocked(publish)).toHaveBeenCalledWith("droplet/devices/bob/revoked", { deviceId: "drive-b" });
    });

    it("writes the flag first, then revokes", async () => {
      await request(app).put(URL_PATH).send({ enabled: false });
      expect(upsertMock.mock.invocationCallOrder[0]).toBeLessThan(
        deviceClientFindMany.mock.invocationCallOrder[0],
      );
    });

    it("records the count in the Activity row", async () => {
      await request(app).put(URL_PATH).send({ enabled: false });
      expect(recordActivityMock).toHaveBeenCalledTimes(1);
      expect(recordActivityMock).toHaveBeenCalledWith(
        expect.objectContaining({
          what: "Personal drives turned off",
          sub: "2 personal drive logins signed out",
          refs: { setting: "personalDriveEnabled", enabled: false, revokedDriveLogins: 2 },
        }),
      );
    });

    it("still marks a row revoked (and counts it) when Nextcloud refuses the upstream revoke", async () => {
      vi.mocked(ncDeleteAppPassword).mockRejectedValueOnce(new Error("nextcloud down"));
      const res = await request(app).put(URL_PATH).send({ enabled: false });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ personalDriveEnabled: false, revokedDriveLogins: 2 });
      expect(rows.filter((r) => r.kind === "personal_drive").map((r) => r.status)).toEqual([
        "revoked",
        "revoked",
        "revoked",
      ]);
    });

    it("is a no-op on a repeat: already-revoked rows are not selected again", async () => {
      await request(app).put(URL_PATH).send({ enabled: false });
      vi.mocked(ncDeleteAppPassword).mockClear();
      const res = await request(app).put(URL_PATH).send({ enabled: false });
      expect(res.body).toEqual({ personalDriveEnabled: false, revokedDriveLogins: 0 });
      expect(ncDeleteAppPassword).not.toHaveBeenCalled();
    });

    it("turning personal drives ON revokes nothing and keeps the response shape", async () => {
      upsertMock.mockResolvedValue({ personalDriveEnabled: true });
      const res = await request(app).put(URL_PATH).send({ enabled: true });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ personalDriveEnabled: true });
      expect(deviceClientFindMany).not.toHaveBeenCalled();
      expect(deviceClientUpdate).not.toHaveBeenCalled();
      expect(ncDeleteAppPassword).not.toHaveBeenCalled();
      expect(recordActivityMock).toHaveBeenCalledWith(
        expect.objectContaining({
          what: "Personal drives turned on",
          refs: { setting: "personalDriveEnabled", enabled: true },
        }),
      );
    });
  });

  it.each(["admin", "family", "guest"])(
    "refuses %s with 403 owner_required and writes nothing",
    async (role) => {
      identity = { id: UUID, username: "sam", role };
      const res = await request(app).put(URL_PATH).send({ enabled: true });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe("owner_required");
      expect(upsertMock).not.toHaveBeenCalled();
      expect(deviceClientFindMany).not.toHaveBeenCalled();
    },
  );

  it("returns 401 when unauthenticated", async () => {
    identity = null;
    const res = await request(app).put(URL_PATH).send({ enabled: true });
    expect(res.status).toBe(401);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it.each([{}, { enabled: "yes" }, { enabled: 1 }])(
    "rejects a non-boolean body %j with 400",
    async (body) => {
      const res = await request(app).put(URL_PATH).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
      expect(upsertMock).not.toHaveBeenCalled();
    },
  );
});
