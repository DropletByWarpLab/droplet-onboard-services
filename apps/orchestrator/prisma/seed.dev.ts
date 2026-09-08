/**
 * Dev seed — populates a fresh Droplet DB so the dashboard renders
 * realistic data on first boot of the Docker dev stack.
 *
 * Stefan 2026-05-18: "2 users, 5 fake cameras, 3 Matter devices, 10
 * files, 3 conversations".
 *
 * What lives where:
 *   - Cameras + groups + pins         → orchestrator Prisma (this script)
 *   - Chat sessions + messages        → orchestrator Prisma (this script)
 *   - NetworkDevices (Matter stand-in)→ orchestrator Prisma (this script)
 *   - Users                           → Nextcloud (created by the
 *     nextcloud container's initial admin; additional users + the
 *     "10 files" land via the WebDAV bootstrap script in
 *     docker/dev/nextcloud-bootstrap.sh — run separately)
 *
 * Idempotent: every insert uses upsert keyed on a stable unique column,
 * so re-running this against a populated DB is safe + cheap.
 *
 * Invoked by docker/dev/entrypoint-orchestrator.sh when
 * DROPLET_DEV_SEED=1.
 */

import { PrismaClient } from "@prisma/client";
// WARP-992: canonical box name — never os.hostname(), which is the docker
// container id inside the dev stack and leaks onto the dashboard identity chip.
import { boxDisplayName } from "../src/lib/box-identity.js";
// WARP-2844: the guards around minting an owner live in their own tested
// module — this script's only job is to gather the inputs and obey.
import { decideDevOwnerSeed } from "../src/services/dev-owner-seed.policy.js";
import { hashPassword } from "../src/services/password.service.js";
import { emailWriteData } from "../src/services/user-directory.service.js";
import { setModuleEnabled, ModuleToggleError } from "../src/services/modules.service.js";
import { MODULES } from "../src/modules/module-registry.js";
import { config } from "../src/config.js";

const prisma = new PrismaClient();

// ─── helpers ─────────────────────────────────────────────────────

async function seedSelfDevice() {
  const hostname = boxDisplayName();
  const deviceId = `droplet-dev-${hostname}`;
  await prisma.device.upsert({
    where: { deviceId },
    update: { hostname, lastSeen: new Date() },
    create: {
      deviceId,
      hostname,
      hardwareRev: "dev/docker",
      networkMode: "dhcp",
      ip: "127.0.0.1",
    },
  });
  console.log(`[seed] self device upserted (${deviceId})`);
}

// ─── cameras ─────────────────────────────────────────────────────

const CAMERAS = [
  {
    name: "front-door",
    displayName: "Front door",
    manufacturer: "Hikvision",
    model: "DS-2CD2143G2",
    ipAddress: "192.168.10.40",
    macAddress: "44:19:b6:00:00:40",
  },
  {
    name: "reception",
    displayName: "Reception",
    manufacturer: "Reolink",
    model: "RLC-820A",
    ipAddress: "192.168.10.41",
    macAddress: "ec:71:db:00:00:41",
  },
  {
    name: "garage",
    displayName: "Garage",
    manufacturer: "Amcrest",
    model: "IP5M-1190EB",
    ipAddress: "192.168.10.42",
    macAddress: "9c:8e:cd:00:00:42",
  },
  {
    name: "loading-bay",
    displayName: "Loading bay",
    manufacturer: "Reolink",
    model: "RLC-1212A",
    ipAddress: "192.168.10.43",
    macAddress: "ec:71:db:00:00:43",
  },
  {
    name: "back-lot",
    displayName: "Back lot",
    manufacturer: "Hikvision",
    model: "DS-2DE4A425IW-DE",
    ipAddress: "192.168.10.44",
    macAddress: "44:19:b6:00:00:44",
    enabled: false, // demonstrates the "offline" pill in the grid
  },
];

async function seedCameras() {
  for (const cam of CAMERAS) {
    await prisma.camera.upsert({
      where: { name: cam.name },
      update: {
        displayName: cam.displayName,
        manufacturer: cam.manufacturer,
        model: cam.model,
        ipAddress: cam.ipAddress,
        macAddress: cam.macAddress,
        enabled: cam.enabled ?? true,
        lastSeen: new Date(),
      },
      create: {
        name: cam.name,
        displayName: cam.displayName,
        manufacturer: cam.manufacturer,
        model: cam.model,
        ipAddress: cam.ipAddress,
        macAddress: cam.macAddress,
        enabled: cam.enabled ?? true,
        autoDiscovered: false,
      },
    });
  }

  // Group: "Entries" — front-door + reception + loading-bay
  const entries = await prisma.cameraGroup.upsert({
    where: { name: "Entries" },
    update: {},
    create: { name: "Entries" },
  });
  for (const camName of ["front-door", "reception", "loading-bay"]) {
    const cam = await prisma.camera.findUnique({ where: { name: camName } });
    if (!cam) continue;
    await prisma.cameraGroupMember.upsert({
      where: {
        groupId_cameraId: { groupId: entries.id, cameraId: cam.id },
      },
      update: {},
      create: { groupId: entries.id, cameraId: cam.id },
    });
  }

  // Pin front-door + reception so the dashboard's pinned rail isn't empty
  for (const [name, sortOrder] of [["front-door", 0], ["reception", 1]] as const) {
    await prisma.cameraPin.upsert({
      where: { userId_cameraName: { userId: "admin", cameraName: name } },
      update: { sortOrder },
      create: { userId: "admin", cameraName: name, sortOrder },
    });
  }

  console.log(`[seed] cameras upserted (${CAMERAS.length} + 1 group + 2 pins)`);
}

// ─── matter devices (stored as NetworkDevice rows with vendor=matter
//      for dev — real Matter state lives in matter-storage JSON files
//      written by the Matter controller, which we don't run in dev). ──

const MATTER_DEVICES = [
  {
    mac: "matter:0000:0001",
    displayName: "Living room lights",
    vendor: "Matter",
    hostname: "matter-light-01",
    lastIp: "192.168.10.101",
    icon: "lightbulb",
  },
  {
    mac: "matter:0000:0002",
    displayName: "Office thermostat",
    vendor: "Matter",
    hostname: "matter-therm-01",
    lastIp: "192.168.10.102",
    icon: "thermometer",
  },
  {
    mac: "matter:0000:0003",
    displayName: "Front door lock",
    vendor: "Matter",
    hostname: "matter-lock-01",
    lastIp: "192.168.10.103",
    icon: "lock",
  },
];

async function seedMatterDevices() {
  for (const dev of MATTER_DEVICES) {
    await prisma.networkDevice.upsert({
      where: { mac: dev.mac },
      update: {
        displayName: dev.displayName,
        vendor: dev.vendor,
        hostname: dev.hostname,
        lastIp: dev.lastIp,
        icon: dev.icon,
        lastSeen: new Date(),
      },
      create: {
        mac: dev.mac,
        displayName: dev.displayName,
        vendor: dev.vendor,
        hostname: dev.hostname,
        lastIp: dev.lastIp,
        icon: dev.icon,
      },
    });
  }
  console.log(`[seed] matter device stand-ins upserted (${MATTER_DEVICES.length})`);
}

// ─── chat conversations ──────────────────────────────────────────

const CONVERSATIONS: Array<{
  title: string;
  userId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
}> = [
  {
    title: "Loading-bay camera triage",
    userId: "admin",
    messages: [
      { role: "user", content: "Has the back-lot camera been offline before this?" },
      {
        role: "assistant",
        content:
          "The back-lot camera has dropped offline twice in the last 30 days — 2026-04-22 (14m) and 2026-05-11 (8m). Both recovered without intervention. Today it's been offline for 14m.",
      },
      { role: "user", content: "Show me the last clip it captured." },
      {
        role: "assistant",
        content:
          "Last clip from back-lot was 2026-05-18 13:48:02 — 28 sec, motion in the right-hand parking row. Want me to open it in the Cameras tab?",
      },
    ],
  },
  {
    title: "Weekly storage trend",
    userId: "admin",
    messages: [
      { role: "user", content: "How fast am I filling storage?" },
      {
        role: "assistant",
        content:
          "Storage has grown 2.1% week-over-week (35% → 36.4% of 4 TB). At this rate the drive fills in ~92 days. The dominant new bytes are camera clips (1.6 GB/day) and Nextcloud uploads (0.4 GB/day).",
      },
    ],
  },
  {
    title: "Draft NDA reply",
    userId: "stefan",
    messages: [
      {
        role: "user",
        content:
          "Draft a one-paragraph reply to a supplier asking for our standard NDA template.",
      },
      {
        role: "assistant",
        content:
          "Here's a draft:\n\n> Thanks for reaching out. Attached is our standard mutual NDA — please review and sign at your convenience. Happy to discuss any redlines before we counter-sign on our end. — Stefan",
      },
    ],
  },
];

async function seedConversations() {
  for (const conv of CONVERSATIONS) {
    // Upsert by deterministic id derived from title + userId so re-runs
    // don't pile up duplicate sessions.
    const id = `dev-${conv.userId}-${conv.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")}`;

    const session = await prisma.chatSession.upsert({
      where: { id },
      update: { title: conv.title, userId: conv.userId, updatedAt: new Date() },
      create: {
        id,
        title: conv.title,
        userId: conv.userId,
        model: "llama3.1:70b",
        provider: "ollama",
      },
    });

    // Wipe + reseed messages so re-running matches the latest seed
    // script content.
    await prisma.chatMessage.deleteMany({ where: { sessionId: session.id } });
    let order = 0;
    for (const msg of conv.messages) {
      await prisma.chatMessage.create({
        data: {
          sessionId: session.id,
          role: msg.role,
          content: msg.content,
          status: "completed",
          completedAt: new Date(Date.now() - (conv.messages.length - order) * 1000),
        },
      });
      order += 1;
    }
  }
  console.log(`[seed] chat conversations upserted (${CONVERSATIONS.length})`);
}

// ─── dev owner account (WARP-2844) ───────────────────────────────
//
// Before this, a fresh dev stack had NO way in: nothing seeded a local `User`
// row, and the dashboard authenticates against that row and nothing else
// (ADR-013 — Nextcloud stopped authenticating anyone). The setup wizard was
// the only door, and on this stack it could not be walked either, because
// compose never passed DEVICE_SECRET_KEY and `emailWriteData` throws without
// it. Both halves are fixed here and in docker-compose.dev.yml.
//
// Every guard around minting an owner lives in `dev-owner-seed.policy.ts`,
// tested separately and mutation-verified. Read that file before changing
// anything here — the refusals are the feature.

const DEV_OWNER_EMAIL = process.env.DROPLET_DEV_OWNER_EMAIL?.trim() || "dev@warp-lab.ai";
const DEV_OWNER_DISPLAY_NAME = "Droplet Dev";

/**
 * Nextcloud group name for the household space.
 *
 * Deliberately duplicated from `routes/auth-groups.ts:householdGroupName`
 * rather than imported: that module reaches into the department provisioner,
 * and a seed script that drags in the service graph fails for reasons that
 * have nothing to do with seeding. Same rationale auth-groups.ts itself gives
 * for inlining its role check instead of importing ADMIN_TIER_ROLES.
 */
function householdGroupSlug(sharedFolderName: string | undefined): string {
  return (
    String(sharedFolderName ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "household"
  );
}

/**
 * Give the seeded owner a Nextcloud account so the Files surface has an
 * identity to talk to. BEST-EFFORT on purpose: the dashboard login does not
 * depend on it, so a Nextcloud that is slow to install must not fail the seed
 * — it must say what it could not do and move on.
 */
async function provisionNextcloudAccount(username: string, password: string): Promise<void> {
  const base = (process.env.NEXTCLOUD_URL ?? "").replace(/\/+$/, "");
  const admin = process.env.NEXTCLOUD_ADMIN_USER ?? "";
  const adminPassword = process.env.NEXTCLOUD_ADMIN_PASSWORD ?? "";
  if (!base || !admin || !adminPassword) {
    console.log("[seed] Nextcloud account skipped — NEXTCLOUD_URL/ADMIN_USER/ADMIN_PASSWORD unset");
    return;
  }

  const headers = {
    Authorization: `Basic ${Buffer.from(`${admin}:${adminPassword}`).toString("base64")}`,
    "OCS-APIRequest": "true",
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };

  // An owner's groups, per buildNcGroups(). `droplet-admins` is created lazily
  // by the department provisioner and the household group by the occ init
  // script, so on a fresh dev stack neither exists yet — and OCS REFUSES a
  // create-user naming a group that does not exist (the WARP-990 trigger).
  // Ensure them first, exactly as POST /auth/setup does.
  const groups = ["admin", "droplet-admins", householdGroupSlug(process.env.DROPLET_SHARED_FOLDER_NAME)];

  try {
    for (const groupid of groups) {
      await fetch(`${base}/ocs/v1.php/cloud/groups`, {
        method: "POST",
        headers,
        body: new URLSearchParams({ groupid }),
      }).catch(() => undefined); // already-exists is the common case
    }

    const params: Array<[string, string]> = [
      ["userid", username],
      ["password", password],
      ["displayName", DEV_OWNER_DISPLAY_NAME],
    ];
    for (const g of groups) params.push(["groups[]", g]);

    const resp = await fetch(`${base}/ocs/v1.php/cloud/users`, {
      method: "POST",
      headers,
      body: new URLSearchParams(params),
    });
    if (!resp.ok) {
      console.log(`[seed] Nextcloud account not created (HTTP ${resp.status}) — /files will 401 for this user`);
      return;
    }
    console.log(`[seed] Nextcloud account provisioned for '${username}' in ${groups.join(", ")}`);
  } catch (err) {
    console.log(`[seed] Nextcloud account not created (${(err as Error).message}) — /files will 401 for this user`);
  }
}

async function seedDevOwner(): Promise<void> {
  // Not a safety guard — an environment precondition, and the one that made
  // the setup wizard 500 on this stack. Named explicitly so the failure is
  // actionable rather than an argon2/HKDF stack trace.
  if (!config.DEVICE_SECRET_KEY) {
    console.log("[seed] dev owner not seeded — DEVICE_SECRET_KEY is unset, so the email column cannot be encrypted");
    return;
  }

  const [existingOwnerCount, rows] = await Promise.all([
    prisma.user.count({ where: { role: "owner" } }),
    prisma.user.findMany({ select: { username: true, nextcloudUsername: true } }),
  ]);
  const takenUserIds = new Set<string>();
  for (const r of rows) {
    if (r.username) takenUserIds.add(r.username);
    if (r.nextcloudUsername) takenUserIds.add(r.nextcloudUsername);
  }

  const password = process.env.DROPLET_DEV_OWNER_PASSWORD;
  const decision = decideDevOwnerSeed({
    nodeEnv: process.env.NODE_ENV,
    email: DEV_OWNER_EMAIL,
    password,
    existingOwnerCount,
    takenUserIds,
  });

  if (decision.action === "skip") {
    console.log(`[seed] dev owner not seeded — ${decision.reason}`);
    return;
  }

  const { username } = decision;
  await prisma.user.create({
    data: {
      username,
      displayName: DEV_OWNER_DISPLAY_NAME,
      ...emailWriteData(DEV_OWNER_EMAIL),
      nextcloudUsername: username,
      passwordHash: await hashPassword(password as string),
      role: "owner",
      // accessRoleId stays NULL on purpose: the full feature catalog is
      // resolved only on the null branch of effective-access, so ANY custom
      // role would narrow this account rather than widen it.
    },
  });
  console.log(`[seed] dev owner created — sign in as ${DEV_OWNER_EMAIL} (username '${username}')`);

  await provisionNextcloudAccount(username, password as string);
}

// ─── module visibility (WARP-2844) ───────────────────────────────

/**
 * The availability key behind each module whose config default is the EMPTY
 * string. Every other module gates on a URL that config defaults to something
 * non-empty, so it reads as available on a box with no hardware at all —
 * availability is a config read, not a health probe (module-registry.ts:92-98).
 */
const AVAILABILITY_KEY: Partial<Record<string, string>> = {
  docs: "DOCS_ENABLED=1 and DOCS_INTERNAL_URL",
  email: "SERVICE_TOKEN_EMAIL",
  voice: "SERVICE_TOKEN_VOICE",
};

/**
 * Turn on every non-core module.
 *
 * 10 of the 15 ship `defaultEnabled: false`, and layer 1 (`requireModuleEnabled`)
 * 404s the whole route prefix without ever inspecting `req.user` — there is no
 * owner bypass. So an owner on a stock box still cannot reach two thirds of the
 * app until these rows exist.
 *
 * Explicitly NOT done by applying a business-type preset: that upserts an
 * `enabled:false` row for every non-core module OUTSIDE the preset, and no
 * preset contains team_chat, crm, money or contacts. Presets remove surfaces.
 */
async function seedAllModulesOn(): Promise<void> {
  const enabled: string[] = [];
  const unavailable: string[] = [];

  for (const m of MODULES) {
    if (m.core) continue; // core modules are always on and refuse the toggle
    try {
      await setModuleEnabled(prisma, config, m.id, true, "dev-seed");
      enabled.push(m.id);
    } catch (err) {
      if (err instanceof ModuleToggleError && err.code === "module_unavailable") {
        const key = AVAILABILITY_KEY[m.id];
        unavailable.push(key ? `${m.id} (needs ${key})` : m.id);
        continue;
      }
      throw err;
    }
  }

  console.log(`[seed] modules enabled (${enabled.length}): ${enabled.join(", ")}`);
  if (unavailable.length > 0) {
    // Never silent: a module that could not be enabled is a surface the
    // developer will find missing, and they should learn it here.
    console.log(`[seed] modules NOT available on this stack (${unavailable.length}): ${unavailable.join(", ")}`);
  }
}

// ─── main ────────────────────────────────────────────────────────

async function main() {
  console.log("[seed] starting dev seed");
  await seedSelfDevice();
  await seedCameras();
  await seedMatterDevices();
  await seedConversations();
  await seedDevOwner();
  await seedAllModulesOn();
  console.log("[seed] dev seed complete");
  console.log("[seed] ──────────────────────────────────────────────");
  console.log("[seed] Sample files still live in Nextcloud — run");
  console.log("[seed] docker/dev/nextcloud-bootstrap.sh once the stack");
  console.log("[seed] is up to upload them via WebDAV.");
  console.log("[seed] ──────────────────────────────────────────────");
}

main()
  .catch((e) => {
    console.error("[seed] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
