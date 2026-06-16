import { describe, it, expect, vi, beforeEach } from "vitest";
import { createDeviceReconcilePoller, type OpenwrtClient } from "./device-reconcile-poller.js";
import { RouterError } from "../types/router-error.js";
import type { FirewallRules } from "../types/network.js";

// Spy on the shared cold-start-aware log helper so we can assert the poller
// delegates EACH failure to it (level decision is unit-tested in
// openwrt.client.test.ts). Partial mock — every other export stays real.
const { logRouterError } = vi.hoisted(() => ({ logRouterError: vi.fn() }));
vi.mock("./openwrt.client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./openwrt.client.js")>();
  return { ...actual, logRouterError };
});

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
  beforeEach(() => {
    logRouterError.mockClear();
  });

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

  // Cold-start log hygiene: each of the 3 catch sites must route its failure
  // through the shared cold-start-aware helper (which decides debug vs warn)
  // rather than logging at a hardcoded `warn`.
  it("routes a DHCP fetch failure through the cold-start-aware log helper", async () => {
    const registry = makeRegistry();
    const err = RouterError.unreachable("dhcp unreachable");
    const openwrt = makeOpenwrt({
      fetchDhcpLeases: async () => {
        throw err;
      },
    });

    const poller = createDeviceReconcilePoller(registry as any, openwrt, 10_000);
    await poller.pollOnce();

    expect(logRouterError).toHaveBeenCalledWith(
      expect.anything(),
      err,
      expect.stringContaining("fetchDhcpLeases"),
    );
  });

  it("routes a wireless fetch failure through the cold-start-aware log helper", async () => {
    const registry = makeRegistry();
    const err = RouterError.unreachable("wireless unreachable");
    const openwrt = makeOpenwrt({
      fetchWirelessClients: async () => {
        throw err;
      },
    });

    const poller = createDeviceReconcilePoller(registry as any, openwrt, 10_000);
    await poller.pollOnce();

    expect(logRouterError).toHaveBeenCalledWith(
      expect.anything(),
      err,
      expect.stringContaining("fetchWirelessClients"),
    );
  });

  it("routes a firewall fetch failure through the cold-start-aware log helper", async () => {
    const registry = makeRegistry();
    const err = RouterError.unreachable("firewall unreachable");
    const openwrt = makeOpenwrt({
      fetchFirewallRules: async () => {
        throw err;
      },
    });

    const poller = createDeviceReconcilePoller(registry as any, openwrt, 10_000);
    await poller.pollOnce();

    expect(logRouterError).toHaveBeenCalledWith(
      expect.anything(),
      err,
      expect.stringContaining("fetchFirewallRules"),
    );
  });

  // AC #6(e): even when ALL three calls fail, the poller never throws and still
  // reconciles with degraded values (empty lists + RouterError passthrough for
  // firewall so isBlocked is preserved). Behavior is unchanged by the log work.
  it("never throws and still reconciles when all three routing calls fail", async () => {
    const registry = makeRegistry();
    const openwrt = makeOpenwrt({
      fetchDhcpLeases: async () => {
        throw RouterError.unreachable("dhcp down");
      },
      fetchWirelessClients: async () => {
        throw RouterError.unreachable("wireless down");
      },
      fetchFirewallRules: async () => {
        throw RouterError.unreachable("firewall down");
      },
    });

    const poller = createDeviceReconcilePoller(registry as any, openwrt, 10_000);
    await expect(poller.pollOnce()).resolves.toBeUndefined();

    expect(registry.reconcile).toHaveBeenCalledTimes(1);
    const arg = registry.reconcile.mock.calls[0][0] as any;
    expect(arg.leases).toEqual([]);
    expect(arg.wirelessClients).toEqual([]);
    expect(arg.firewallRules).toBeInstanceOf(RouterError);
    expect((arg.firewallRules as RouterError).code).toBe("UNREACHABLE");
  });
});
