/**
 * WARP-89: reconciler poller.
 *
 * Wraps the pure `deviceRegistry.reconcile(...)` call (WARP-81) behind a
 * `pollOnce()` that fetches a fresh DHCP + wireless + firewall snapshot
 * from the routing service and feeds it through. Designed to be wired
 * into the cron runtime (WARP-93) at ~10s cadence.
 *
 * Two deliberate behaviors here:
 *
 *   1. DHCP / wireless fetch failures degrade to empty lists + a warn
 *      log. Presence tracking is best-effort; missing one 10s window
 *      shouldn't crash the poller.
 *   2. Firewall fetch failures are passed through to the reconciler as
 *      a `RouterError` — NOT caught and replaced with an empty list.
 *      This is load-bearing: `device-registry.reconcile` preserves each
 *      row's existing `isBlocked` when it sees a RouterError, rather
 *      than clearing it. Silently substituting `[]` would unblock every
 *      device the user intentionally blocked, just because the router
 *      hiccupped.
 *
 * The openwrt client exposes module-level functions (`fetchDhcpLeases`,
 * `fetchWirelessClients`, `fetchFirewallRules`) rather than a class. We
 * take a narrow `OpenwrtClient` surface here so tests can inject mocks
 * without pulling the whole module.
 */
import pino from "pino";
import type { DeviceRegistry, FirewallRejectRule } from "./device-registry.service.js";
import type {
  DhcpLease as OpenwrtDhcpLease,
  WirelessClient as OpenwrtWirelessClient,
  FirewallRules,
  FirewallRule,
} from "../types/network.js";
import { RouterError } from "../types/router-error.js";

const log = pino({ name: "device-reconcile-poller" });

/**
 * Narrow surface of the openwrt client the poller needs. Lets tests
 * inject in-memory mocks without stubbing the full module.
 */
export interface OpenwrtClient {
  fetchDhcpLeases(): Promise<OpenwrtDhcpLease[]>;
  fetchWirelessClients(device?: string): Promise<OpenwrtWirelessClient[]>;
  fetchFirewallRules(): Promise<FirewallRules>;
}

export interface DeviceReconcilePoller {
  pollOnce(): Promise<void>;
}

/**
 * Flatten the firewall wire shape (`{ values: Record<string, FirewallRule> }`)
 * down to the `{ srcMac }[]` slice the reconciler needs, keeping only
 * rules with REJECT/DROP target and a non-empty `src_mac`.
 */
function toRejectRules(rules: FirewallRules): FirewallRejectRule[] {
  const out: FirewallRejectRule[] = [];
  for (const rule of Object.values(rules.values) as FirewallRule[]) {
    const target = rule.target?.toUpperCase();
    if (target !== "REJECT" && target !== "DROP") continue;
    // `enabled` comes back as the string "0" / "1" from UCI.
    if (rule.enabled === "0") continue;
    if (!rule.src_mac) continue;
    out.push({ srcMac: rule.src_mac });
  }
  return out;
}

export function createDeviceReconcilePoller(
  registry: DeviceRegistry,
  openwrt: OpenwrtClient,
  pollIntervalMs: number,
): DeviceReconcilePoller {
  return {
    async pollOnce() {
      // DHCP + wireless: degrade to empty list on failure. Presence
      // counts for this 10s window will be off by one tick, which is
      // fine — the next poll recovers.
      const [leases, wireless, firewallRules] = await Promise.all([
        openwrt.fetchDhcpLeases().catch((err: unknown) => {
          log.warn({ err }, "fetchDhcpLeases failed; using empty list");
          return [] as OpenwrtDhcpLease[];
        }),
        openwrt.fetchWirelessClients().catch((err: unknown) => {
          log.warn({ err }, "fetchWirelessClients failed; using empty list");
          return [] as OpenwrtWirelessClient[];
        }),
        // Firewall: pass the RouterError through to the reconciler so
        // `isBlocked` is preserved. See device-registry.service.ts §3.
        openwrt
          .fetchFirewallRules()
          .then((rules) => toRejectRules(rules))
          .catch((err: unknown): FirewallRejectRule[] | RouterError => {
            log.warn({ err }, "fetchFirewallRules failed; preserving last isBlocked");
            if (err instanceof RouterError) return err;
            return RouterError.unknown("fetchFirewallRules failed", {
              label: "Firewall rules",
              cause: err,
            });
          }),
      ]);

      // Adapt openwrt's DHCP/wireless shapes to the registry's shape.
      const adaptedLeases = leases.map((l) => ({
        mac: l.macaddr,
        ip: l.ipaddr,
        hostname: l.hostname,
      }));
      const adaptedWireless = wireless.map((w) => ({
        mac: w.mac,
        signal: w.signal,
      }));

      await registry.reconcile({
        leases: adaptedLeases,
        wirelessClients: adaptedWireless,
        firewallRules,
        pollIntervalMs,
      });
    },
  };
}
