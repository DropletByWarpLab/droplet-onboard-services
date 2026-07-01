import os from "os";
import fs from "fs";
import { PrismaClient } from "@prisma/client";
// WARP-992: canonical box name — never os.hostname(), which is the docker
// container id inside the container and leaks onto the dashboard identity chip.
import { boxDisplayName } from "../src/lib/box-identity.js";
// WARP-457: workspace settings seeder. Idempotent — re-running is a
// no-op once the canonical defaults are in place, and operator-edited
// values are never overwritten.
import { seedWorkspaceSettings } from "../src/services/workspace-settings.service.js";

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
  const hostname = boxDisplayName();
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

  // WARP-457: populate the WorkspaceSetting table from canonical
  // defaults on first run. Idempotent — a re-run inserts zero rows
  // and the row count stays stable; operator-edited values are
  // never overwritten.
  const settingsResult = await seedWorkspaceSettings(prisma);
  console.log(
    "Workspace settings: %d inserted (steady-state = 0 after first boot)",
    settingsResult.inserted,
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
