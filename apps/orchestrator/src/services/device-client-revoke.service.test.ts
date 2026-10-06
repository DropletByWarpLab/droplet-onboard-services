/**
 * WARP-3384 — revoking a person's paired devices when they are deactivated or
 * deleted, and the honest outcome of the Nextcloud app-password delete
 * (WARP-3383: never report a revoke as clean when the credential may still work).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { ncDeleteMock, recordActivityMock, publishMock } = vi.hoisted(() => ({
  ncDeleteMock: vi.fn(),
  recordActivityMock: vi.fn().mockResolvedValue(null),
  publishMock: vi.fn(),
}));
vi.mock("./nextcloud.client.js", () => ({ ncDeleteAppPassword: ncDeleteMock }));
vi.mock("./encryption.service.js", () => ({
  decryptSecret: vi.fn((s: string) => s.replace(/^enc:/, "")),
}));
vi.mock("./mqtt.service.js", () => ({ publish: publishMock }));
vi.mock("./activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import {
  initDeviceClientRevoke,
  revokeDeviceClient,
  revokeDeviceClientsForUser,
} from "./device-client-revoke.service.js";

const ADMIN = { type: "user" as const, id: "admin-1" };

interface Row {
  id: string;
  userId: string;
  kind: "app_pairing" | "personal_drive";
  status: "active" | "revoked";
  ncAppPassword: string;
}

function row(over: Partial<Row> & { id: string }): Row {
  return {
    userId: "alice",
    kind: "app_pairing",
    status: "active",
    ncAppPassword: `enc:pw-${over.id}`,
    ...over,
  };
}

function makePrisma(rows: Row[], opts: { failUpdateFor?: string; failFind?: boolean } = {}) {
  return {
    deviceClient: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; status: string } }) => {
        if (opts.failFind) throw new Error("db down");
        return rows.filter((r) => r.userId === where.userId && r.status === where.status);
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { status: "revoked" } }) => {
        if (where.id === opts.failUpdateFor) throw new Error("db write failed");
        const r = rows.find((x) => x.id === where.id)!;
        r.status = data.status;
        return r;
      }),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ncDeleteMock.mockResolvedValue(true);
});

describe("revokeDeviceClient — the outcome is explicit", () => {
  it("deleted: Nextcloud confirmed, the row is marked revoked", async () => {
    const prisma = makePrisma([row({ id: "a" })]);
    const outcome = await revokeDeviceClient(prisma as never, row({ id: "a" }));
    expect(outcome).toBe("deleted");
    expect(ncDeleteMock).toHaveBeenCalledWith("pw-a");
    expect(prisma.deviceClient.update).toHaveBeenCalledWith({
      where: { id: "a" },
      data: { status: "revoked" },
    });
    expect(publishMock).toHaveBeenCalledWith("droplet/devices/alice/revoked", { deviceId: "a" });
  });

  it("not_deleted: Nextcloud did not confirm, the row is still marked revoked", async () => {
    ncDeleteMock.mockResolvedValue(false);
    const prisma = makePrisma([row({ id: "a" })]);
    expect(await revokeDeviceClient(prisma as never, row({ id: "a" }))).toBe("not_deleted");
    expect(prisma.deviceClient.update).toHaveBeenCalledTimes(1);
  });

  it("not_deleted: an app-password delete that throws is not hidden either", async () => {
    ncDeleteMock.mockRejectedValue(new Error("nextcloud down"));
    const prisma = makePrisma([row({ id: "a" })]);
    expect(await revokeDeviceClient(prisma as never, row({ id: "a" }))).toBe("not_deleted");
  });

  it("already_revoked: touches nothing", async () => {
    const prisma = makePrisma([]);
    const outcome = await revokeDeviceClient(prisma as never, row({ id: "a", status: "revoked" }));
    expect(outcome).toBe("already_revoked");
    expect(ncDeleteMock).not.toHaveBeenCalled();
    expect(prisma.deviceClient.update).not.toHaveBeenCalled();
  });
});

describe("revokeDeviceClientsForUser — a leaver's devices (WARP-3384)", () => {
  it("revokes every active client of the person, both kinds, and audits actor + person + count", async () => {
    const rows = [
      row({ id: "app", kind: "app_pairing" }),
      row({ id: "drive", kind: "personal_drive" }),
      row({ id: "old", status: "revoked" }),
      row({ id: "bobs", userId: "bob" }),
    ];
    const prisma = makePrisma(rows);
    initDeviceClientRevoke(prisma as never);

    const summary = await revokeDeviceClientsForUser("alice", ADMIN, "deactivation");

    expect(summary).toEqual({ revoked: 2, appPasswordsNotDeleted: 0, failed: 0 });
    expect(rows.find((r) => r.id === "app")!.status).toBe("revoked");
    expect(rows.find((r) => r.id === "drive")!.status).toBe("revoked");
    // Someone else's client and an already-revoked one are never touched.
    expect(rows.find((r) => r.id === "bobs")!.status).toBe("active");
    expect(ncDeleteMock.mock.calls.map((c) => c[0]).sort()).toEqual(["pw-app", "pw-drive"]);

    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth",
        severity: "warn",
        what: "Paired devices revoked",
        sub: "alice: deactivation",
        actor: ADMIN,
        refs: expect.objectContaining({
          reason: "deactivation",
          targetUsername: "alice",
          revoked: 2,
          appPasswordsNotDeleted: 0,
          failed: 0,
        }),
      }),
    );
  });

  it("a removal records its own reason", async () => {
    const prisma = makePrisma([row({ id: "a" })]);
    initDeviceClientRevoke(prisma as never);
    await revokeDeviceClientsForUser("alice", { type: "system" }, "removal");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sub: "alice: removal",
        actor: { type: "system" },
        refs: expect.objectContaining({ reason: "removal" }),
      }),
    );
  });

  it("an app-password delete Nextcloud did not confirm is RECORDED, and the row is still revoked", async () => {
    ncDeleteMock.mockImplementation(async (pw: string) => pw !== "pw-stuck");
    const rows = [row({ id: "ok" }), row({ id: "stuck" })];
    const prisma = makePrisma(rows);
    initDeviceClientRevoke(prisma as never);

    const summary = await revokeDeviceClientsForUser("alice", ADMIN, "deactivation");

    expect(summary).toEqual({ revoked: 2, appPasswordsNotDeleted: 1, failed: 0 });
    expect(rows.every((r) => r.status === "revoked")).toBe(true);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: expect.objectContaining({ revoked: 2, appPasswordsNotDeleted: 1 }),
      }),
    );
  });

  it("a delete that throws counts as not deleted, never as success, and never aborts the sweep", async () => {
    ncDeleteMock.mockRejectedValue(new Error("nextcloud down"));
    const rows = [row({ id: "a" }), row({ id: "b" })];
    initDeviceClientRevoke(makePrisma(rows) as never);

    const summary = await revokeDeviceClientsForUser("alice", ADMIN, "deactivation");

    expect(summary).toEqual({ revoked: 2, appPasswordsNotDeleted: 2, failed: 0 });
  });

  it("a row that cannot be marked revoked is counted failed, left active, and the audit row is an error", async () => {
    const rows = [row({ id: "good" }), row({ id: "bad" })];
    initDeviceClientRevoke(makePrisma(rows, { failUpdateFor: "bad" }) as never);

    const summary = await revokeDeviceClientsForUser("alice", ADMIN, "deactivation");

    expect(summary).toEqual({ revoked: 1, appPasswordsNotDeleted: 0, failed: 1 });
    expect(rows.find((r) => r.id === "good")!.status).toBe("revoked");
    expect(rows.find((r) => r.id === "bad")!.status).toBe("active");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "err",
        what: "Some paired devices could not be revoked",
        refs: expect.objectContaining({ revoked: 1, failed: 1 }),
      }),
    );
  });

  it("a person with no active client gets a zero summary and no audit row", async () => {
    initDeviceClientRevoke(makePrisma([row({ id: "old", status: "revoked" })]) as never);
    expect(await revokeDeviceClientsForUser("alice", ADMIN, "deactivation")).toEqual({
      revoked: 0,
      appPasswordsNotDeleted: 0,
      failed: 0,
    });
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("a second sweep after the first finds nothing (idempotent)", async () => {
    initDeviceClientRevoke(makePrisma([row({ id: "a" })]) as never);
    await revokeDeviceClientsForUser("alice", ADMIN, "deactivation");
    recordActivityMock.mockClear();
    ncDeleteMock.mockClear();
    const again = await revokeDeviceClientsForUser("alice", ADMIN, "removal");
    expect(again).toEqual({ revoked: 0, appPasswordsNotDeleted: 0, failed: 0 });
    expect(ncDeleteMock).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("a sweep that itself fails returns null and says so on an audit row, never throws", async () => {
    initDeviceClientRevoke(makePrisma([], { failFind: true }) as never);
    expect(await revokeDeviceClientsForUser("alice", ADMIN, "deactivation")).toBeNull();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "err",
        what: "Paired devices could not be revoked",
        refs: expect.objectContaining({ sweepFailed: true, targetUsername: "alice" }),
      }),
    );
  });

  it("not wired: returns null, touches nothing", async () => {
    initDeviceClientRevoke(null as never);
    expect(await revokeDeviceClientsForUser("alice", ADMIN, "deactivation")).toBeNull();
    expect(ncDeleteMock).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});
