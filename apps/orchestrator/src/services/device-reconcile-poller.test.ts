import { describe, it, expect, vi } from "vitest";
import { createDeviceReconcilePoller, type OpenwrtClient } from "./device-reconcile-poller.js";
import { RouterError } from "../types/router-error.js";
import type { FirewallRules } from "../types/network.js";

function makeRegistry() {
  return {
    reconcile: vi.fn(async (_input: unknown) => {}),
    purgePresenceRows: vi.fn(async () => ({ count: 0 })),
    forgetDevice: vi.fn(async () => ({} as any)),
  };
}

function fwRules(values: Record<string, any> = {}): FirewallRules {
  return { values };
}

function makeOpenwrt(overrides: Partial<OpenwrtClient> = {}): OpenwrtClient {
  return {
    fetchDhcpLeases: overrides.fetchDhcpLeases ?? (async () => []),
    fetchWirelessClients: overrides.fetchWirelessClients ?? (async () => []),
    fetchFirewallRules: overrides.fetchFirewallRules ?? (async () => fwRules()),
  };
}

describe("device-reconcile-poller", () => {
  it("happy path: feeds leases, wireless, reject rules through to reconcile", async () => {
    const registry = makeRegistry();
    const openwrt = makeOpenwrt({
      fetchDhcpLeases: async () => [
        { expire: 0, hostname: "laptop", ipaddr: "192.168.1.10", macaddr: "AA:BB:CC:DD:EE:01" },
      ],
      fetchWirelessClients: async () => [
        { mac: "AA:BB:CC:DD:EE:02", signal: -40, noise: -90, rx_rate: 0, tx_rate: 0, connected_time: 0 },
      ],
      fetchFirewallRules: async () =>
        fwRules({
          r1: { target: "REJECT", enabled: "1", src_mac: "AA:BB:CC:DD:EE:01" },
          r2: { target: "ACCEPT", enabled: "1", src_mac: "AA:BB:CC:DD:EE:02" }, // filtered out
          r3: { target: "DROP", enabled: "0", src_mac: "AA:BB:CC:DD:EE:03" }, // disabled
          r4: { target: "DROP", enabled: "1", src_mac: "AA:BB:CC:DD:EE:04" },
        }),
    });

    const poller = createDeviceReconcilePoller(registry as any, openwrt, 10_000);
    await poller.pollOnce();

    expect(registry.reconcile).toHaveBeenCalledTimes(1);
    const arg = registry.reconcile.mock.calls[0][0] as any;
    expect(arg.leases).toEqual([
      { mac: "AA:BB:CC:DD:EE:01", ip: "192.168.1.10", hostname: "laptop" },
    ]);
    expect(arg.wirelessClients).toEqual([{ mac: "AA:BB:CC:DD:EE:02", signal: -40 }]);
    expect(arg.firewallRules).toEqual([
      { srcMac: "AA:BB:CC:DD:EE:01" },
      { srcMac: "AA:BB:CC:DD:EE:04" },
    ]);
    expect(arg.pollIntervalMs).toBe(10_000);
  });

  it("dhcp fetch failure degrades to empty leases but still reconciles", async () => {
    const registry = makeRegistry();
    const openwrt = makeOpenwrt({
      fetchDhcpLeases: async () => {
        throw RouterError.unreachable("router down");
      },
      fetchWirelessClients: async () => [
        { mac: "AA:BB:CC:DD:EE:02", signal: -40, noise: -90, rx_rate: 0, tx_rate: 0, connected_time: 0 },
      ],
      fetchFirewallRules: async () => fwRules(),
    });

    const poller = createDeviceReconcilePoller(registry as any, openwrt, 10_000);
    await poller.pollOnce();

    expect(registry.reconcile).toHaveBeenCalledTimes(1);
    const arg = registry.reconcile.mock.calls[0][0] as any;
    expect(arg.leases).toEqual([]);
    expect(arg.wirelessClients).toHaveLength(1);
    expect(arg.firewallRules).toEqual([]); // empty fwRules → empty reject array
  });

  it("firewall fetch failure passes RouterError through (preserves isBlocked)", async () => {
    const registry = makeRegistry();
    const err = RouterError.unreachable("firewall unreachable");
    const openwrt = makeOpenwrt({
      fetchFirewallRules: async () => {
        throw err;
      },
    });

    const poller = createDeviceReconcilePoller(registry as any, openwrt, 10_000);
    await poller.pollOnce();

    expect(registry.reconcile).toHaveBeenCalledTimes(1);
    const arg = registry.reconcile.mock.calls[0][0] as any;
    expect(arg.firewallRules).toBeInstanceOf(RouterError);
    expect((arg.firewallRules as RouterError).code).toBe("UNREACHABLE");
  });

  it("non-RouterError firewall failure is wrapped as RouterError.unknown", async () => {
    const registry = makeRegistry();
    const openwrt = makeOpenwrt({
      fetchFirewallRules: async () => {
        throw new Error("schema parse failed");
      },
    });

    const poller = createDeviceReconcilePoller(registry as any, openwrt, 10_000);
    await poller.pollOnce();

    const arg = registry.reconcile.mock.calls[0][0] as any;
    expect(arg.firewallRules).toBeInstanceOf(RouterError);
    expect((arg.firewallRules as RouterError).code).toBe("UNKNOWN");
  });

  it("threads pollIntervalMs through to the reconciler", async () => {
    const registry = makeRegistry();
    const openwrt = makeOpenwrt();

    const poller = createDeviceReconcilePoller(registry as any, openwrt, 5_000);
    await poller.pollOnce();

    const arg = registry.reconcile.mock.calls[0][0] as any;
    expect(arg.pollIntervalMs).toBe(5_000);
  });
});
