import { describe, it, expect, vi } from "vitest";
import { retryPendingLegacyOverlayRevokes } from "./vpn-legacy-revoke.service.js";

describe("legacy fleet revoke debt sweep", () => {
  it("does no fleet work when no revoked legacy grant is outstanding", async () => {
    const revoke = vi.fn();
    const prisma = { vpnPeer: { findMany: vi.fn(async () => []), updateMany: vi.fn() } };
    expect(await retryPendingLegacyOverlayRevokes(prisma, revoke)).toEqual({ completed: 0, failed: 0 });
    expect(prisma.vpnPeer.findMany).toHaveBeenCalledWith({
      where: { kind: "overlay", status: "revoked", hqRevokePending: true },
      select: { id: true, publicKey: true }, take: 100,
    });
    expect(revoke).not.toHaveBeenCalled();
  });

  it("clears only successfully revoked grants and continues after a refusal", async () => {
    const revoke = vi.fn().mockRejectedValueOnce(new Error("HQ offline")).mockResolvedValueOnce(undefined);
    const prisma = { vpnPeer: {
      findMany: vi.fn(async () => [{ id: "a", publicKey: "key-a" }, { id: "b", publicKey: "key-b" }]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    } };
    expect(await retryPendingLegacyOverlayRevokes(prisma, revoke)).toEqual({ completed: 1, failed: 1 });
    expect(revoke.mock.calls).toEqual([["key-a"], ["key-b"]]);
    expect(prisma.vpnPeer.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.vpnPeer.updateMany).toHaveBeenCalledWith({
      where: { id: "b", status: "revoked", hqRevokePending: true }, data: { hqRevokePending: false },
    });
  });
});
