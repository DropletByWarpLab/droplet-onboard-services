/**
 * Network API routes — thin composition layer.
 *
 * WARP-91: the per-concern handlers live in sibling
 * `network-*.routes.ts` files. This module just wires shared service
 * deps (NetworkDeviceService, ScheduleApiService) and mounts each
 * sub-router onto a single Express Router.
 *
 * Commands are still evaluated through the network safety tier
 * framework inside the sub-routers:
 * - Tier 1: Auto-execute (reads, SSID, channel, DNS, static lease)
 * - Tier 2: Requires user confirmation (firewall, password, WAN config)
 * - Tier 3: Blocked for AI, web UI only (reboot, VPN)
 */

import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { createNetworkDeviceService } from "../services/network-device.service.js";
import { createScheduleApiService } from "../services/schedule-api.service.js";
import * as openwrt from "../services/openwrt.client.js";
import { registerStatusRoutes } from "./network-status.routes.js";
import { registerInterfaceRoutes } from "./network-interface.routes.js";
import { registerWifiRoutes } from "./network-wifi.routes.js";
import { registerFirewallRoutes } from "./network-firewall.routes.js";
import { registerVlanRoutes } from "./network-vlan.routes.js";
import { registerDeviceRoutes } from "./network-devices.routes.js";
import { registerScheduleRoutes } from "./network-schedules.routes.js";
import { registerPhoneHomeRoutes } from "./network-phone-home.routes.js";
import { registerFabricRoutes } from "./network-fabric.routes.js";

export function createNetworkRouter(prisma: PrismaClient): Router {
  const router = Router();

  // WARP-82: device-registry service. Fed a live routing-service
  // snapshot (DHCP + wireless) so listDevices can enrich NetworkDevice
  // rows with current signal strength. If the router is unreachable we
  // fail soft to an empty snapshot — the dashboard still renders
  // last-known state, just without signal bars.
  const networkDeviceService = createNetworkDeviceService(prisma, async () => {
    try {
      // WARP-1715: the router's assoclist only covers the ROUTER's radios. On
      // the edge-router shape the household Wi-Fi is served by standalone APs,
      // so a device joined through one holds a router DHCP lease but appears in
      // no router assoclist — it rendered as wired, with no signal and no way
      // to tell which AP it was on. Ask each approved AP for its own stations
      // and merge them in, tagged with the AP they came from.
      const [leases, routerClients, apRows] = await Promise.all([
        openwrt.fetchDhcpLeases().catch(() => []),
        openwrt.fetchWirelessClients().catch(() => []),
        prisma.apDevice
          .findMany({ where: { status: "ONLINE" }, select: { mac: true } })
          .catch(() => [] as Array<{ mac: string }>),
      ]);

      const wirelessClients = routerClients.map((w) => ({
        mac: w.mac,
        signal: w.signal,
        viaApMac: undefined as string | undefined,
      }));

      // One unreachable AP must not cost us the whole device list, so each leg
      // settles independently and a failure contributes nothing.
      const apResults = await Promise.all(
        apRows.map((ap) =>
          openwrt
            .fetchApClients(ap.mac)
            .then((res) => ({ mac: ap.mac, clients: res.clients }))
            .catch(() => ({ mac: ap.mac, clients: [] })),
        ),
      );

      // The router's own radios win on a duplicate MAC: a station the router
      // can see directly is on the router's radio, whatever an AP also reports.
      const seen = new Set(wirelessClients.map((w) => w.mac.toUpperCase()));
      for (const { mac: apMac, clients } of apResults) {
        for (const client of clients) {
          const key = client.mac?.toUpperCase();
          if (!key || seen.has(key)) continue;
          seen.add(key);
          wirelessClients.push({
            mac: client.mac,
            signal: client.signal,
            viaApMac: apMac,
          });
        }
      }

      return {
        leases: leases.map((l) => ({
          mac: l.macaddr,
          ip: l.ipaddr,
          hostname: l.hostname,
        })),
        wirelessClients,
      };
    } catch {
      return { leases: [], wirelessClients: [] };
    }
  });

  // WARP-94: schedule + override + manualBlock REST surface. Thin wrapper
  // over Prisma; enforces subject/window/range invariants and translates
  // P2025 to typed DeviceRegistryError.
  const scheduleApi = createScheduleApiService(prisma);

  registerStatusRoutes(router, { prisma, networkDeviceService });
  registerInterfaceRoutes(router, { prisma });
  registerWifiRoutes(router, { prisma });
  registerFirewallRoutes(router, { prisma });
  registerVlanRoutes(router, {});
  registerDeviceRoutes(router, { networkDeviceService });
  registerScheduleRoutes(router, { scheduleApi });
  registerPhoneHomeRoutes(router, { prisma });
  // WARP-1732 (ADR-035 §5): read-only fabric inventory. Serves FabricMember
  // rows straight from Postgres — no routing-service call, no device write.
  registerFabricRoutes(router, { prisma });

  return router;
}
