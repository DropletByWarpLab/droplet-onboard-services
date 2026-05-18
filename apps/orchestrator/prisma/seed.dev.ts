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

import os from "os";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// ─── helpers ─────────────────────────────────────────────────────

async function seedSelfDevice() {
  const hostname = os.hostname();
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
    // Prisma's compound-unique argument follows the order in the
    // @@unique declaration. CameraGroupMember declares
    // @@unique([groupId, cameraId]) so the key is groupId_cameraId
    // (groupId FIRST). There's also no `cameraName` column — it
    // lived on an older schema revision; the relation handles joins.
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

// ─── main ────────────────────────────────────────────────────────

async function main() {
  console.log("[seed] starting dev seed");
  await seedSelfDevice();
  await seedCameras();
  await seedMatterDevices();
  await seedConversations();
  console.log("[seed] dev seed complete");
  console.log("[seed] ──────────────────────────────────────────────");
  console.log("[seed] Note: users + the 10 dev files live in Nextcloud.");
  console.log("[seed] Run docker/dev/nextcloud-bootstrap.sh after the");
  console.log("[seed] stack is up to create the second user + sample");
  console.log("[seed] files via WebDAV.");
  console.log("[seed] ──────────────────────────────────────────────");
}

main()
  .catch((e) => {
    console.error("[seed] failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
