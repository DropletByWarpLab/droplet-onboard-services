import os from "os";
import fs from "fs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

async function main() {
  const hostname = os.hostname();
  const deviceId = `droplet-${hostname}`;
  const ip = detectIp();
  const hardwareRev = detectHardwareRev();

  await prisma.device.upsert({
    where: { deviceId },
    update: { hostname, ip, hardwareRev, lastSeen: new Date() },
    create: { deviceId, hostname, ip, hardwareRev, networkMode: "dhcp" },
  });

  console.log(
    "Seed data created: %s (hostname=%s, ip=%s, hw=%s)",
    deviceId,
    hostname,
    ip ?? "none",
    hardwareRev
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
