import os from "os";
import fs from "fs";
import { PrismaClient } from "@prisma/client";
// WARP-457: workspace settings seeder. Idempotent — re-running is a
// no-op once the canonical defaults are in place, and operator-edited
// values are never overwritten.
import { seedWorkspaceSettings } from "../src/services/workspace-settings.service.js";
// WARP-637: claim-code seeder. Idempotent — seeds the HASH of the code
// only when CLAIM_CODE is set; re-running is a no-op if the hash already
// exists. The plaintext never touches the DB.
import { seedClaimCode } from "../src/services/setup-claim.service.js";

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

  // WARP-457: populate the WorkspaceSetting table from canonical
  // defaults on first run. Idempotent — a re-run inserts zero rows
  // and the row count stays stable; operator-edited values are
  // never overwritten.
  const settingsResult = await seedWorkspaceSettings(prisma);
  console.log(
    "Workspace settings: %d inserted (steady-state = 0 after first boot)",
    settingsResult.inserted,
  );

  // WARP-637: seed a first-run claim code from the CLAIM_CODE env var.
  // This is the opt-in provisioning path for headless/no-PyPortal devices:
  // set CLAIM_CODE in .env (or the environment) and the hash is seeded here
  // so POST /api/setup/claim can verify it out-of-box. When unset, behavior
  // is unchanged — the orchestrator's ensureClaimCode() mints a code at
  // runtime once the display service requests it (WARP-632 / ADR-017).
  // The plaintext is never logged or persisted; only its HMAC-SHA256 hash
  // (keyed by DEVICE_SECRET) reaches the DB.
  const claimCode = (process.env.CLAIM_CODE ?? "").trim();
  if (claimCode) {
    const seeded = await seedClaimCode(prisma, claimCode);
    console.log("Claim code seeded from CLAIM_CODE (new=%s)", seeded);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
