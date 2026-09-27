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

import {
  initVpnDeviceRevoke,
  revokeOverlayDevicesForUser,
  revokeUserVpnDevices,
} from "./vpn-peer-revoke.service.js";

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

    expect(summary).toEqual({ revoked: 2, failed: 0, hqPending: 0, pendingDenied: 1 });
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

  // WARP-3172: the account is already gone, so a live router peer is the worse
  // outcome. The router peer goes anyway and the row owes HQ a retry (the
  // connect tick refuses the device and retries).
  it("an HQ outage still removes the router peer, revokes the row and flags the HQ retry", async () => {
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
    expect(summary).toEqual({ revoked: 1, failed: 0, hqPending: 1, pendingDenied: 0 });
    expect(deleteVpnPeerMock).toHaveBeenCalledWith({ publicKey: "K1" });
    expect(prisma.peers[0]).toMatchObject({ status: "revoked", hqRevokePending: true });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: expect.objectContaining({ outcome: "REVOKED_HQ_PENDING", reason: "removal" }),
      }),
    );
  });

  it("a router that only STAGES the removal leaves the row active and counts a failure", async () => {
    deleteVpnPeerMock.mockResolvedValueOnce({ removed: 1, applied: false });
    const prisma = prismaWith([
      { id: "p1", userId: "bob", kind: "static", status: "active", publicKey: "K1" },
    ]);
    const summary = await revokeUserVpnDevices(prisma, { username: "bob", actor: ADMIN, reason: "deactivation" });
    expect(summary.failed).toBe(1);
    expect(prisma.peers[0].status).toBe("active");
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

describe("revokeOverlayDevicesForUser — the process-wide entry point (WARP-3160)", () => {
  it("uses the boot-wired client", async () => {
    const prisma = prismaWith([
      { id: "p1", userId: "bob", kind: "static", status: "active", publicKey: "K1" },
    ]);
    initVpnDeviceRevoke(prisma);
    const summary = await revokeOverlayDevicesForUser("bob", ADMIN, "role_change");
    expect(summary?.revoked).toBe(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ refs: expect.objectContaining({ reason: "role_change" }) }),
    );
  });
});
