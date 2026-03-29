import { PrismaClient } from "@prisma/client";
import { cacheGet, cacheSet } from "./cache.service.js";
import type { DeviceInfo } from "../types/index.js";

const CACHE_KEY = "devices:list";
const CACHE_TTL = 60; // seconds

let prisma: PrismaClient;

export function initDeviceService(prismaClient: PrismaClient): void {
  prisma = prismaClient;
}

export async function listDevices(): Promise<DeviceInfo[]> {
  // Try cache first
  const cached = await cacheGet<DeviceInfo[]>(CACHE_KEY);
  if (cached) return cached;

  const devices = await prisma.device.findMany({
    orderBy: { lastSeen: "desc" },
  });

  const result: DeviceInfo[] = devices.map((d) => ({
    id: d.id,
    deviceId: d.deviceId,
    hostname: d.hostname,
    hardwareRev: d.hardwareRev,
    networkMode: d.networkMode,
    ip: d.ip,
    lastSeen: d.lastSeen.toISOString(),
  }));

  await cacheSet(CACHE_KEY, result, CACHE_TTL);
  return result;
}

export async function updateLastSeen(deviceId: string): Promise<void> {
  await prisma.device.update({
    where: { deviceId },
    data: { lastSeen: new Date() },
  });
}
