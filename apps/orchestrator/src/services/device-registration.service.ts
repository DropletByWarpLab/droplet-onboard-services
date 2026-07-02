import os from "os";
import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { cacheDel } from "./cache.service.js";
import { publish } from "./mqtt.service.js";
import { boxDisplayName } from "../lib/box-identity.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("device-registration");

const REFRESH_INTERVAL_MS = 30_000; // 30 seconds
const CACHE_KEY = "devices:list";

let prisma: PrismaClient;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Detect the primary non-internal IPv4 address.
 */
function detectIp(): string | null {
  const nets = os.networkInterfaces();
  for (const addresses of Object.values(nets)) {
    const found = addresses?.find(
      (a) => a.family === "IPv4" && !a.internal
    );
    if (found) return found.address;
  }
  return null;
}

/**
 * Detect hardware revision.
 * - ARM hosts: read /proc/device-tree/model
 * - Fallback: platform/arch (e.g. "linux/arm64", "darwin/arm64")
 */
function detectHardwareRev(): string {
  try {
    return fs
      .readFileSync("/proc/device-tree/model", "utf-8")
      .replace(/\0/g, "")
      .trim();
  } catch {
    return `${os.platform()}/${os.arch()}`;
  }
}

/**
 * Refresh the local device's state in the database.
 * Runs on a periodic interval to track network changes (DHCP, interface changes).
 */
async function refreshDeviceState(): Promise<void> {
  try {
    // WARP-992: the canonical box name, never `os.hostname()` — inside the
    // container that is the docker container id, and this row's `hostname`
    // is what the dashboard identity chip + Settings → Device information
    // display. Deriving `deviceId` from it also makes the row stable across
    // container recreations (the container id changed on every recreate,
    // leaving a trail of stale self-registrations).
    const hostname = boxDisplayName();
    const deviceId = `droplet-${hostname}`;
    const ip = detectIp();
    const hardwareRev = detectHardwareRev();

    await prisma.device.upsert({
      where: { deviceId },
      update: {
        hostname,
        ip,
        hardwareRev,
        lastSeen: new Date(),
      },
      create: {
        deviceId,
        hostname,
        ip,
        hardwareRev,
        networkMode: "dhcp",
      },
    });

    // Invalidate the device list cache so the dashboard sees fresh data
    await cacheDel(CACHE_KEY);

    // Publish state to MQTT for other services
    publish("droplet/device/state", {
      deviceId,
      hostname,
      ip,
      hardwareRev,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    // Non-fatal — log and continue. The next tick will retry.
    logger.warn({ err }, "Failed to refresh device state");
  }
}

/**
 * Start periodic device self-registration.
 * Runs immediately, then every REFRESH_INTERVAL_MS.
 */
export async function initDeviceRegistration(
  prismaClient: PrismaClient
): Promise<void> {
  prisma = prismaClient;

  // Run immediately on startup
  await refreshDeviceState();

  // Then refresh periodically to track network changes
  refreshTimer = setInterval(refreshDeviceState, REFRESH_INTERVAL_MS);
  logger.info(
    "Device self-registration started (every %ds)",
    REFRESH_INTERVAL_MS / 1000
  );
}

/**
 * Stop the periodic refresh (for graceful shutdown).
 */
export function shutdownDeviceRegistration(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
