/**
 * WARP-2694 — the wg0 reconciler.
 *
 * What it must never do is as important as what it does: a box with no linked
 * devices must not acquire a WAN listener because a timer fired, and a router
 * that says "no WireGuard" must not have peers pushed into a device that is
 * not there.
 */
import { describe, it, expect, vi } from "vitest";
import { reconcileVpnInterface, type VpnReconcileDeps } from "./vpn-reconcile.service.js";

const KEY_A = "A".repeat(43) + "=";
const KEY_B = "B".repeat(43) + "=";

function deps(overrides: {
  rows?: Array<{ publicKey: string; assignedIp: string; deviceLabel: string | null }>;
  setup?: { created: boolean; interface_live?: boolean | null };
  held?: string[];
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

  it("re-runs the idempotent setup and reports when the interface had to be recreated", async () => {
    const { d, logs } = deps({ rows: [rowA], setup: { created: true, interface_live: true }, held: [KEY_A] });
    const out = await reconcileVpnInterface(d);
    expect(d.router.setup).toHaveBeenCalledWith({ listenPort: 51820, address: "10.13.13.1/24" });
    expect(out.interfaceCreated).toBe(true);
    expect(logs.some((l) => l.includes("recreated"))).toBe(true);
  });

  it("re-installs every active row the router no longer holds, from its own key + address", async () => {
    const { d } = deps({ rows: [rowA, rowB], held: [KEY_A] });
    const out = await reconcileVpnInterface(d);
    expect(out.reinstalled).toEqual([KEY_B]);
    expect(d.router.installPeer).toHaveBeenCalledTimes(1);
    expect(d.router.installPeer).toHaveBeenCalledWith({
      interface: "wg0",
      publicKey: KEY_B,
      allowedIps: ["10.13.13.3/32"],
      persistentKeepalive: 25,
      description: "",
    });
  });

  it("is a no-op when the router already holds every linked device", async () => {
    const { d } = deps({ rows: [rowA, rowB], held: [KEY_A, KEY_B] });
    const out = await reconcileVpnInterface(d);
    expect(out.reinstalled).toEqual([]);
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

  it("treats an unknown interface_live as no information and still reconciles peers", async () => {
    // Routers flashed without rpcd-mod-wireguard cannot report kernel state.
    // That is the common field case and must not disable the reconcile.
    const { d } = deps({ rows: [rowA], setup: { created: false, interface_live: null }, held: [] });
    const out = await reconcileVpnInterface(d);
    expect(out.routerUnsupported).toBe(false);
    expect(out.reinstalled).toEqual([KEY_A]);
  });

  it("swallows a router fault and leaves it to the next tick", async () => {
    const { d, logs } = deps({ rows: [rowA] });
    (d.router.setup as any).mockRejectedValueOnce(new Error("routing down"));
    await expect(reconcileVpnInterface(d)).resolves.toMatchObject({ reinstalled: [] });
    expect(logs.some((l) => l.includes("retry next tick"))).toBe(true);
  });
});
