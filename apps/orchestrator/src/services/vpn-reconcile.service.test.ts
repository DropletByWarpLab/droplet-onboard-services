/**
 * WARP-2694 — the wg0 reconciler.
 *
 * What it must never do is as important as what it does: a box with no linked
 * devices must not acquire a WAN listener because a timer fired; a router that
 * says "no WireGuard" must not have peers pushed into a device that is not
 * there; and — the WARP-2686 review finding — a peer whose revoke is staged
 * must NEVER be re-installed, or the reconciler silently reverses the owner's
 * revoke of, say, a stolen phone. Re-install happens ONLY when the interface
 * was genuinely recreated this tick.
 */
import { describe, it, expect, vi } from "vitest";
import { reconcileVpnInterface, type VpnReconcileDeps } from "./vpn-reconcile.service.js";

const KEY_A = "A".repeat(43) + "=";
const KEY_B = "B".repeat(43) + "=";

function deps(overrides: {
  rows?: Array<{ publicKey: string; assignedIp: string; deviceLabel: string | null }>;
  setup?: { created: boolean; interface_live?: boolean | null };
  held?: string[];
  isStillActive?: (publicKey: string) => Promise<boolean>;
} = {}) {
  const logs: string[] = [];
  const d: VpnReconcileDeps = {
    prisma: {
      vpnPeer: {
        findMany: vi.fn(async () => overrides.rows ?? []),
      },
    },
    router: {
      setup: vi.fn(async () => overrides.setup ?? { created: false, interface_live: true }),
      listPeers: vi.fn(async () => (overrides.held ?? []).map((public_key) => ({ public_key }))),
      installPeer: vi.fn(async () => ({})),
    },
    isStillActive: overrides.isStillActive,
    config: {
      vpnInterface: "wg0",
      listenPort: 51820,
      serverAddress: "10.13.13.1/24",
      keepaliveSeconds: 25,
    },
    logger: {
      info: (_o, m) => logs.push(`info:${m}`),
      warn: (_o, m) => logs.push(`warn:${m}`),
      error: (_o, m) => logs.push(`error:${m}`),
    },
  };
  return { d, logs };
}

const rowA = { publicKey: KEY_A, assignedIp: "10.13.13.2", deviceLabel: "phone" };
const rowB = { publicKey: KEY_B, assignedIp: "10.13.13.3", deviceLabel: null };

describe("reconcileVpnInterface", () => {
  it("does not touch the router when no linked devices exist", async () => {
    // Creating wg0 opens udp/51820 on the WAN edge. Nobody asked for that.
    const { d } = deps({ rows: [] });
    const out = await reconcileVpnInterface(d);
    expect(out.skipped).toBe(true);
    expect(d.router.setup).not.toHaveBeenCalled();
    expect(d.router.installPeer).not.toHaveBeenCalled();
  });

  it("re-installs the active rows only when the interface was recreated this tick", async () => {
    const { d, logs } = deps({ rows: [rowA, rowB], setup: { created: true, interface_live: true }, held: [] });
    const out = await reconcileVpnInterface(d);
    expect(d.router.setup).toHaveBeenCalledWith({ listenPort: 51820, address: "10.13.13.1/24" });
    expect(out.interfaceCreated).toBe(true);
    expect(out.reinstalled.sort()).toEqual([KEY_A, KEY_B].sort());
    expect(d.router.installPeer).toHaveBeenCalledWith({
      interface: "wg0",
      publicKey: KEY_B,
      allowedIps: ["10.13.13.3/32"],
      persistentKeepalive: 25,
      description: "",
    });
    expect(logs.some((l) => l.includes("recreated"))).toBe(true);
  });

  it("flags relinkRequired on a recreate — the new server key means clients must re-add", async () => {
    const { d, logs } = deps({ rows: [rowA], setup: { created: true, interface_live: true }, held: [] });
    const out = await reconcileVpnInterface(d);
    expect(out.relinkRequired).toBe(true);
    expect(logs.some((l) => l.startsWith("error:") && l.includes("re-added"))).toBe(true);
  });

  it("NEVER re-installs a peer missing from an interface that was NOT recreated (staged revoke)", async () => {
    // The revoke-reversal finding: owner revokes rowA, its uci section is gone
    // (so it is not in `held`) but the row is still active pending the reload,
    // and the interface was not recreated. Re-installing would resurrect the
    // revoked device. rowB is still held, proving a partial state.
    const { d, logs } = deps({ rows: [rowA, rowB], setup: { created: false, interface_live: true }, held: [KEY_B] });
    const out = await reconcileVpnInterface(d);
    expect(d.router.installPeer).not.toHaveBeenCalled();
    expect(out.reinstalled).toEqual([]);
    expect(out.unreconciledMissing).toBe(1);
    expect(logs.some((l) => l.includes("in-flight revoke"))).toBe(true);
  });

  it("does not re-install even when ALL peers are missing if the interface was not recreated", async () => {
    // The single-peer staged revoke: held is empty, but the interface is up
    // (created:false). Indistinguishable from a wipe via uci alone, so the
    // safe reading is "revoke in flight" — do nothing.
    const { d } = deps({ rows: [rowA], setup: { created: false, interface_live: true }, held: [] });
    const out = await reconcileVpnInterface(d);
    expect(d.router.installPeer).not.toHaveBeenCalled();
    expect(out.unreconciledMissing).toBe(1);
  });

  it("is a no-op when the router already holds every linked device", async () => {
    const { d } = deps({ rows: [rowA, rowB], setup: { created: false, interface_live: true }, held: [KEY_A, KEY_B] });
    const out = await reconcileVpnInterface(d);
    expect(out.reinstalled).toEqual([]);
    expect(out.unreconciledMissing).toBe(0);
    expect(d.router.installPeer).not.toHaveBeenCalled();
  });

  it("stops before installing anything when the router has no WireGuard (interface_live=false)", async () => {
    const { d, logs } = deps({ rows: [rowA], setup: { created: true, interface_live: false }, held: [] });
    const out = await reconcileVpnInterface(d);
    expect(out.routerUnsupported).toBe(true);
    expect(d.router.listPeers).not.toHaveBeenCalled();
    expect(d.router.installPeer).not.toHaveBeenCalled();
    expect(logs.some((l) => l.startsWith("error:") && l.includes("no WireGuard"))).toBe(true);
  });

  it("treats an unknown interface_live as no information and still reconciles on a recreate", async () => {
    // Routers flashed without rpcd-mod-wireguard cannot report kernel state.
    const { d } = deps({ rows: [rowA], setup: { created: true, interface_live: null }, held: [] });
    const out = await reconcileVpnInterface(d);
    expect(out.routerUnsupported).toBe(false);
    expect(out.reinstalled).toEqual([KEY_A]);
  });

  it("skips a row a concurrent revoke retired between findMany and install (isStillActive)", async () => {
    // Even in the recreate path, a revoke that lands mid-tick must win.
    const { d } = deps({
      rows: [rowA, rowB],
      setup: { created: true, interface_live: true },
      held: [],
      isStillActive: async (k) => k !== KEY_A, // A was revoked concurrently
    });
    const out = await reconcileVpnInterface(d);
    expect(out.reinstalled).toEqual([KEY_B]);
    expect(d.router.installPeer).toHaveBeenCalledTimes(1);
  });

  it("swallows a router fault and leaves it to the next tick", async () => {
    const { d, logs } = deps({ rows: [rowA], setup: { created: true, interface_live: true } });
    (d.router.setup as any).mockRejectedValueOnce(new Error("routing down"));
    await expect(reconcileVpnInterface(d)).resolves.toMatchObject({ reinstalled: [] });
    expect(logs.some((l) => l.includes("retry next tick"))).toBe(true);
  });
});
