import { createServer } from "node:http";
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
