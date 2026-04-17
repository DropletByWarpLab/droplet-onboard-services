/**
 * WARP-81: device-registry reconciler.
 *
 * Drives the `NetworkDevice` / `DevicePresenceDay` tables from DHCP +
 * wireless + firewall snapshots pulled by the orchestrator's routing
 * poller (~10s cadence per spec §6.2). Core responsibilities:
 *
 *   1. Upsert every observed MAC — set `lastSeen = now()`, `lastIp`, and
 *      `hostname`, preserving `firstSeen` across updates.
 *   2. Resolve `vendor` on first sight via the injected OUI lookup, then
 *      leave it alone (no repeated lookups, no overwrites — user-curated
 *      displayName/icon/groups live on the same row).
 *   3. Cross-reference the firewall: if the device's MAC has an active
 *      REJECT rule, flip `isBlocked = true`. IMPORTANT: if the firewall
 *      fetch failed (caller passes a `RouterError` instead of an array),
 *      we MUST preserve the last-persisted `isBlocked` — silently
 *      clearing it would unblock devices the user intentionally blocked
 *      just because the router hiccupped.
 *   4. Roll up presence into `DevicePresenceDay` — one row per
 *      (mac, calendar-day) incremented by `pollIntervalMs / 60_000`.
 *   5. 30-day retention on presence rows (`purgePresenceRows`) — wire to
 *      an external cron; WARP-81 ships the helper only.
 *   6. `forgetDevice(mac)` — explicit delete (presence cascades).
 *
 * NOTE: the reconciler currently filters out multicast/broadcast MACs
 * (low bit of the first octet set). Beyond that it accepts any MAC that
 * passes `normalizeMac`. Richer filtering (link-local IPv6 multicast
 * edge cases, VM hypervisor prefixes, randomized-MAC clustering, etc.)
 * is a follow-up.
 */

import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import type { OuiLookup } from "./oui-lookup.service.js";
import { RouterError } from "../types/router-error.js";
import { normalizeMac } from "../lib/mac.js";

const log = pino({ name: "device-registry" });

export interface DhcpLease {
  mac: string;
  ip: string;
  hostname?: string;
}

export interface WirelessClient {
  mac: string;
  signal?: number;
}

/**
 * Minimal shape the reconciler needs from the firewall config —
 * any rule whose source matches a device MAC and whose action is REJECT/DROP
 * gets flattened to `{ srcMac }` by the caller.
 */
export interface FirewallRejectRule {
  srcMac: string;
}

export interface ReconcileInput {
  leases: DhcpLease[];
  wirelessClients: WirelessClient[];
  /**
   * Array of active reject rules when the firewall fetch succeeded.
   * A `RouterError` instance when it failed — in that case the
   * reconciler preserves each row's existing `isBlocked` value rather
   * than clearing it (spec §6.2).
   */
  firewallRules: FirewallRejectRule[] | RouterError;
  pollIntervalMs: number;
}

/**
 * Spec §6.2: skip multicast/broadcast MACs. The low bit of the first
 * octet is the I/G (individual/group) flag — 1 = multicast, which also
 * covers the all-ones broadcast address FF:FF:FF:FF:FF:FF.
 */
function isUnicastMac(mac: string): boolean {
  const firstOctet = parseInt(mac.slice(0, 2), 16);
  if (Number.isNaN(firstOctet)) return false;
  return (firstOctet & 0x01) === 0;
}

function safeNormalize(mac: string): string | null {
  try {
    return normalizeMac(mac);
  } catch {
    return null;
  }
}

export function createDeviceRegistry(prisma: PrismaClient, ouiLookup: OuiLookup) {
  return {
    /**
     * Ingest a DHCP/wireless/firewall snapshot. Safe to call repeatedly —
     * this is the only write path into the device-intelligence tables.
     */
    async reconcile(input: ReconcileInput): Promise<void> {
      const firewallOk = !(input.firewallRules instanceof RouterError);
      const blockedMacs = firewallOk
        ? new Set(
            (input.firewallRules as FirewallRejectRule[])
              .map((r) => safeNormalize(r.srcMac))
              .filter((m): m is string => m !== null),
          )
        : null;

      // Dedupe observations: a MAC can appear in both the DHCP lease table
      // and the wireless client list. DHCP wins (it carries hostname/IP),
      // wireless fills in any MACs that don't have a lease yet.
      const observed = new Map<string, { ip?: string; hostname?: string }>();
      for (const l of input.leases) {
        const mac = safeNormalize(l.mac);
        if (!mac || !isUnicastMac(mac)) continue;
        observed.set(mac, { ip: l.ip, hostname: l.hostname });
      }
      for (const w of input.wirelessClients) {
        const mac = safeNormalize(w.mac);
        if (!mac || !isUnicastMac(mac)) continue;
        if (!observed.has(mac)) observed.set(mac, {});
      }

      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const pollMinutes = Math.max(0, Math.round(input.pollIntervalMs / 60_000));

      for (const [mac, { ip, hostname }] of observed) {
        const existing = await prisma.networkDevice.findUnique({ where: { mac } });

        // Resolve vendor once, on first sight. Never overwrite.
        const vendor = existing?.vendor ?? ouiLookup.lookup(mac);

        // Firewall state: cascade from the rules on success, preserve on failure.
        const isBlocked = firewallOk
          ? blockedMacs!.has(mac)
          : existing?.isBlocked ?? false;

        await prisma.networkDevice.upsert({
          where: { mac },
          create: {
            mac,
            vendor: vendor ?? undefined,
            hostname: hostname ?? undefined,
            lastIp: ip ?? undefined,
            isBlocked,
            firstSeen: now,
            lastSeen: now,
          },
          update: {
            // Only update mutable fields — leave firstSeen alone.
            hostname: hostname ?? undefined,
            lastIp: ip ?? undefined,
            isBlocked,
            lastSeen: now,
          },
        });

        if (pollMinutes > 0) {
          await prisma.devicePresenceDay.upsert({
            where: { mac_date: { mac, date: today } },
            create: { mac, date: today, seenMinutes: pollMinutes },
            update: { seenMinutes: { increment: pollMinutes } },
          });
        }
      }

      log.debug(
        { observed: observed.size, firewallOk },
        "reconcile complete",
      );
    },

    /**
     * Spec §5.4 retention: drop presence rows older than `olderThanDays`.
     * Wire into an external cron at 03:00 local. Returns Prisma's
     * `{ count }` so the caller can log it.
     */
    async purgePresenceRows(olderThanDays = 30): Promise<{ count: number }> {
      const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
      return prisma.devicePresenceDay.deleteMany({
        where: { date: { lt: cutoff } },
      });
    },

    /**
     * Explicit "forget this device" — deletes the NetworkDevice row; the
     * DevicePresenceDay rows cascade via the FK in the schema.
     */
    async forgetDevice(mac: string) {
      return prisma.networkDevice.delete({ where: { mac: normalizeMac(mac) } });
    },
  };
}

export type DeviceRegistry = ReturnType<typeof createDeviceRegistry>;
