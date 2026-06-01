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
import { registerWifiRoutes } from "./network-wifi.routes.js";
import { registerFirewallRoutes } from "./network-firewall.routes.js";
import { registerVlanRoutes } from "./network-vlan.routes.js";
import { registerDeviceRoutes } from "./network-devices.routes.js";
import { registerScheduleRoutes } from "./network-schedules.routes.js";
import { registerPhoneHomeRoutes } from "./network-phone-home.routes.js";

export function createNetworkRouter(prisma: PrismaClient): Router {
  const router = Router();

  // WARP-82: device-registry service. Fed a live routing-service
  // snapshot (DHCP + wireless) so listDevices can enrich NetworkDevice
  // rows with current signal strength. If the router is unreachable we
  // fail soft to an empty snapshot — the dashboard still renders
  // last-known state, just without signal bars.
  const networkDeviceService = createNetworkDeviceService(prisma, async () => {
    try {
      const [leases, wirelessClients] = await Promise.all([
        openwrt.fetchDhcpLeases().catch(() => []),
        openwrt.fetchWirelessClients().catch(() => []),
      ]);
      return {
        leases: leases.map((l) => ({
          mac: l.macaddr,
          ip: l.ipaddr,
          hostname: l.hostname,
        })),
        wirelessClients: wirelessClients.map((w) => ({
          mac: w.mac,
          signal: w.signal,
        })),
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
  registerWifiRoutes(router, { prisma });
  registerFirewallRoutes(router, { prisma });
  registerVlanRoutes(router, {});
  registerDeviceRoutes(router, { networkDeviceService });
  registerScheduleRoutes(router, { scheduleApi });
  registerPhoneHomeRoutes(router, { prisma });

  return router;
}
