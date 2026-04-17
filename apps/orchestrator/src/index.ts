import { createServer } from "node:http";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { connectRedis } from "./services/cache.service.js";
import { connectMqtt } from "./services/mqtt.service.js";
import { initDeviceService } from "./services/device.service.js";
import { initSmartHomeService } from "./services/smart-home.service.js";
import { initNetworkService } from "./services/network.service.js";
import { initCameraService, shutdownCameraService } from "./services/camera.service.js";
import { attachWsBridge } from "./services/ws-bridge.service.js";
import {
  initMatterService,
  shutdownMatterService,
} from "./services/matter.service.js";
import {
  initDeviceRegistration,
  shutdownDeviceRegistration,
} from "./services/device-registration.service.js";
import {
  startHealthMonitor,
  stopHealthMonitor,
} from "./services/health-monitor.service.js";
import { createOuiLookup } from "./services/oui-lookup.service.js";
import { createDeviceRegistry } from "./services/device-registry.service.js";
import * as openwrt from "./services/openwrt.client.js";
import { createCronRuntime } from "./services/cron-runtime.service.js";
import {
  createScheduleTicker,
  type FirewallClient,
} from "./services/schedule-ticker.js";
import {
  purgeScheduleEvents,
  purgeExpiredOverrides,
} from "./services/schedule-purge.js";

const logger = pino({ name: "api-server" });

async function main() {
  // Initialize Prisma
  const prisma = new PrismaClient();
  await prisma.$connect();
  logger.info("Connected to PostgreSQL");

  // Initialize services
  initDeviceService(prisma);

  // Start periodic device self-registration (detects hostname, IP, hardware)
  await initDeviceRegistration(prisma);

  // Connect Redis (non-fatal if unavailable)
  try {
    await connectRedis();
    logger.info("Connected to Redis");
  } catch (err) {
    logger.warn("Redis unavailable, running without cache");
  }

  // Connect MQTT (non-fatal if unavailable)
  try {
    await connectMqtt();
  } catch (err) {
    logger.warn("MQTT broker unavailable");
  }

  // Initialize Matter controller (non-fatal if unavailable)
  try {
    await initMatterService();
    logger.info("Matter controller initialized");
  } catch (err) {
    logger.warn("Matter controller unavailable: %s", (err as Error).message);
  }

  // Legacy: Home Assistant integration (kept for non-Matter protocols)
  try {
    await initSmartHomeService();
    logger.info("Home Assistant connected (legacy fallback)");
  } catch {
    // Expected when HA is not deployed — Matter is the primary path
  }

  // Connect OpenWrt router (non-fatal if unavailable)
  try {
    await initNetworkService();
    logger.info("Connected to OpenWrt router");
  } catch (err) {
    logger.warn("OpenWrt router unavailable, network features disabled");
  }

  // Connect Frigate NVR (non-fatal if unavailable)
  try {
    await initCameraService(prisma);
    logger.info("Connected to Frigate NVR");
  } catch (err) {
    logger.warn("Frigate NVR unavailable, camera features disabled");
  }

  // WARP-43: begin background polling of component health. Non-blocking —
  // the first snapshot is seeded immediately and the poller keeps running.
  startHealthMonitor(prisma);

  // WARP-81: device-intelligence reconciler. Loads the bundled OUI CSV once
  // at startup (best-effort — missing file is logged, lookups degrade to
  // null) and constructs the registry that drives NetworkDevice /
  // DevicePresenceDay from DHCP + wireless + firewall snapshots.
  const ouiCsvPath =
    process.env.OUI_CSV_PATH ?? path.resolve(process.cwd(), "data/oui.csv");
  const ouiLookup = createOuiLookup(ouiCsvPath);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const deviceRegistry = createDeviceRegistry(prisma, ouiLookup);
  // TODO(WARP-82): hook `deviceRegistry.reconcile(...)` into the routing
  // poller once the orchestrator owns one. Today network.service.ts is
  // request-driven (cached fetches on demand); wiring a background poll
  // cadence + piping `{ leases, wirelessClients, firewallRules }` through
  // lives in WARP-82.
  // TODO(WARP-82): schedule `deviceRegistry.purgePresenceRows(30)` at 03:00
  // local once a cron runtime is added (no scheduler dep in orchestrator
  // today). Manual purge still works via the exposed method.
  void deviceRegistry;

  // WARP-93: Phase 2 scheduling runtime. Every 30s the ticker diffs
  // the desired blocked state (from computeDesiredBlocked) against the
  // live firewall state and dispatches block/unblock via the openwrt
  // client. A daily 03:00 cron purges old schedule events (>7d) and
  // long-expired overrides (>24h past endAt).
  const firewall: FirewallClient = {
    async block(mac) {
      await openwrt.blockDevice(mac);
    },
    async unblock(mac) {
      await openwrt.unblockDevice(mac);
    },
  };
  const cronRuntime = createCronRuntime();
  const scheduleTicker = createScheduleTicker(prisma, firewall);
  const tickMs = Number(process.env.SCHEDULE_TICK_MS ?? 30_000);
  cronRuntime.scheduleInterval(tickMs, () => scheduleTicker.tickOnce());
  cronRuntime.scheduleCron("0 3 * * *", async () => {
    const eventsDeleted = await purgeScheduleEvents(prisma, 7);
    const overridesDeleted = await purgeExpiredOverrides(prisma, 24);
    logger.info(
      { eventsDeleted, overridesDeleted },
      "schedule purge complete",
    );
  });

  // Start Express on top of a raw http.Server so we can attach the
  // WebSocket bridge (MQTT → browser) to the same listen socket.
  const app = createApp(prisma);
  const server = createServer(app);
  attachWsBridge(server);
  server.listen(config.PORT, () => {
    logger.info("API server listening on port %d", config.PORT);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    cronRuntime.stop();
    stopHealthMonitor();
    shutdownDeviceRegistration();
    await shutdownMatterService();
    await shutdownCameraService();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start API server");
  process.exit(1);
});
