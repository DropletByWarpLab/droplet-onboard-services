/**
 * WARP-3160 — a deactivated or deleted person loses their VPN devices.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { HQ_ISSUANCE_URL: "https://hq.test", DROPLET_DEVICE_ID: "d" },
}));
const deleteVpnPeerMock = vi.fn();
vi.mock("./openwrt.client.js", async () => {
  const actual = await vi.importActual<typeof import("./openwrt.client.js")>("./openwrt.client.js");
  return { ...actual, deleteVpnPeer: (...a: unknown[]) => deleteVpnPeerMock(...a) };
});
const recordActivityMock = vi.fn();
vi.mock("./activity.singleton.js", () => ({
  recordActivity: (...a: unknown[]) => recordActivityMock(...a),
}));

import { revokeUserVpnDevices } from "./vpn-peer-revoke.service.js";

function prismaWith(peers: any[], pendings: any[] = []) {
  const match = (r: any, where: any) =>
    Object.entries(where).every(([k, v]) => r[k] === v);
  return {
    peers,
    pendings,
    vpnPeer: {
      findMany: vi.fn(async ({ where }: any) => peers.filter((r) => match(r, where))),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hits = peers.filter((r) => match(r, where));
        hits.forEach((r) => Object.assign(r, data));
        return { count: hits.length };
      }),
    },
    pendingOverlayEnrollment: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hits = pendings.filter((r) => match(r, where));
        hits.forEach((r) => Object.assign(r, data));
        return { count: hits.length };
      }),
    },
  };
}

const ADMIN = { type: "user" as const, id: "admin-1" };

beforeEach(() => {
  vi.clearAllMocks();
  deleteVpnPeerMock.mockResolvedValue({ removed: 1, applied: true });
});

describe("revokeUserVpnDevices (WARP-3160)", () => {
  it("revokes every active device the person owns, audits each, and denies their pending ones", async () => {
    const prisma = prismaWith(
      [
        { id: "p1", userId: "bob", kind: "overlay", status: "active", publicKey: "K1", deviceLabel: "Laptop" },
        { id: "p2", userId: "bob", kind: "static", status: "active", publicKey: "K2", deviceLabel: "Phone" },
        { id: "p3", userId: "alice", kind: "overlay", status: "active", publicKey: "K3" },
      ],
      [
        { id: "e1", requestedBy: "bob", state: "pending" },
        { id: "e2", requestedBy: "alice", state: "pending" },
      ],
    );
    const overlayRevoke = vi.fn(async () => {});

    const summary = await revokeUserVpnDevices(prisma, {
      username: "bob",
      actor: ADMIN,
      reason: "deactivation",
      overlayRevoke,
    });

    expect(summary).toEqual({ revoked: 2, failed: 0, pendingDenied: 1 });
    // HQ first, and only for the overlay device.
    expect(overlayRevoke).toHaveBeenCalledTimes(1);
    expect(overlayRevoke).toHaveBeenCalledWith("K1");
    expect(prisma.peers.map((p) => p.status)).toEqual(["revoked", "revoked", "active"]);
    expect(prisma.pendings.map((p) => p.state)).toEqual(["denied", "pending"]);
    expect(recordActivityMock).toHaveBeenCalledTimes(2);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: ADMIN,
        refs: expect.objectContaining({
          event: "overlay_revoke",
          reason: "deactivation",
          outcome: "revoked",
          peer_id: "p1",
          device_owner: "bob",
        }),
      }),
    );
  });

  it("an HQ outage does not throw: the device stays active and the failure is audited", async () => {
    const prisma = prismaWith([
      { id: "p1", userId: "bob", kind: "overlay", status: "active", publicKey: "K1" },
    ]);
    const summary = await revokeUserVpnDevices(prisma, {
      username: "bob",
      actor: ADMIN,
      reason: "removal",
      overlayRevoke: vi.fn(async () => {
        throw new Error("hq down");
      }),
    });
    expect(summary).toEqual({ revoked: 0, failed: 1, pendingDenied: 0 });
    expect(prisma.peers[0].status).toBe("active");
    expect(deleteVpnPeerMock).not.toHaveBeenCalled();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: expect.objectContaining({ outcome: "HQ_REVOKE_FAILED", reason: "removal" }),
      }),
    );
  });

  it("never sweeps the synthetic `overlay` owner of QR-linked devices", async () => {
    const prisma = prismaWith([
      { id: "p1", userId: "overlay", kind: "overlay", status: "active", publicKey: "K1" },
    ]);
    await revokeUserVpnDevices(prisma, { username: "overlay", actor: ADMIN, reason: "deactivation" });
    expect(prisma.vpnPeer.findMany).not.toHaveBeenCalled();
    expect(prisma.peers[0].status).toBe("active");
  });
});
