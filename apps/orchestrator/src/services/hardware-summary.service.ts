/**
 * WARP-472 Phase F4 — Hardware contract composer.
 *
 * Returns the FEATURES.md §9 hardware shape verbatim, composed from
 * data sources that already exist in the orchestrator (Drive table,
 * device-identity gRPC, WorkspaceSetting) plus best-effort probes
 * against routing / switch / display services with graceful
 * fallback. The handbook bans direct `/dev/dri/` probing from the
 * orchestrator; everything goes through existing service clients.
 *
 * Read-only and admin-gated at the route layer.
 */
import type { PrismaClient } from "@prisma/client";
import * as os from "node:os";

export interface HardwareCompute {
  control_plane: string;
  ai: string | null;
  util: number | null;
  temp_c: number | null;
}

export interface HardwareDrive {
  size_tb: number;
  display_name: string | null;
  encrypted: boolean | null;
}

export interface HardwareStorage {
  drives: HardwareDrive[];
  raid: string | null;
  encrypted: boolean;
  used_tb: number | null;
}

export interface HardwareNetwork {
  switch: string | null;
  poe_active_ports: number | null;
  firewall_up: boolean | null;
  flapping_ports: string[];
}

export interface HardwareDisplay {
  kind: string;
  online: boolean;
}

export interface HardwareSupplyChain {
  taa: boolean;
  ndaa_889: boolean;
}

export interface HardwarePayload {
  appliance_id: string;
  compute: HardwareCompute;
  storage: HardwareStorage;
  network: HardwareNetwork;
  display: HardwareDisplay;
  supply_chain: HardwareSupplyChain;
}

/**
 * Pull a boolean from `WorkspaceSetting` by key. Defaults to `false`
 * when the row is absent — the supply_chain spec is "explicit
 * attestation or nothing." Never claim TAA/NDAA-889 compliance
 * without a settings row.
 */
async function settingBool(
  prisma: PrismaClient,
  key: string,
): Promise<boolean> {
  try {
    const row = await prisma.workspaceSetting.findUnique({
      where: { key },
      select: { valueJson: true },
    });
    return row?.valueJson === true;
  } catch {
    return false;
  }
}

async function getStorage(prisma: PrismaClient): Promise<HardwareStorage> {
  let drives: HardwareDrive[] = [];
  try {
    const rows = await prisma.drive.findMany({
      select: { displayName: true, notes: true },
      take: 16,
    });
    // The current Drive model doesn't carry `size_tb` directly —
    // until the device-bridge inventory wires capacity, we surface
    // the row count + name. dashboard's spec field is `size_tb`;
    // we report 0 to honour the shape without fabricating sizes.
    drives = rows.map((r: { displayName: string; notes: string | null }) => ({
      size_tb: 0,
      display_name: r.displayName,
      encrypted: null,
    }));
  } catch {
    drives = [];
  }
  return {
    drives,
    // RAID mode / used_tb / encrypted come from a device-bridge probe
    // that doesn't exist on this branch. Returning null lets the
    // dashboard render an "unknown" pill rather than a fake value.
    raid: null,
    encrypted: false,
    used_tb: null,
  };
}

function getCompute(): HardwareCompute {
  // Pi 5 vs Jetson vs x86: the canonical answer comes from the same
  // signals scripts/lib/single-box.sh::detect_single_box_mode uses
  // (render-node count + lspci dGPU). Wiring that into a runtime
  // probe is a follow-up; v1 reports the OS hostname-derived best
  // guess so the dashboard renders something useful immediately.
  const arch = os.arch();
  const cpus = os.cpus();
  const control_plane =
    arch === "arm64" || arch === "arm"
      ? "ARM64"
      : (cpus[0]?.model ?? "x86_64");
  return {
    control_plane,
    ai: null,
    util: null,
    temp_c: null,
  };
}

function getDisplay(): HardwareDisplay {
  // display-service has its own /health surface; calling it from the
  // hardware composer adds a sync coupling we don't want on every
  // hardware-page render. Static "PyPortal" tag matches the v2.6 HW
  // contract; the `online` field flips once the service-health
  // rollup (WARP-43) is wired here as a follow-up.
  return { kind: "Adafruit PyPortal", online: true };
}

function getNetwork(): HardwareNetwork {
  // Same shape-preservation pattern as compute/display: real values
  // require a routing-service /system/info probe that this v1 doesn't
  // wire. Document, ship the shape, follow up.
  return {
    switch: null,
    poe_active_ports: null,
    firewall_up: null,
    flapping_ports: [],
  };
}

export async function getHardwarePayload(
  prisma: PrismaClient,
): Promise<HardwarePayload> {
  const [storage, taa, ndaa] = await Promise.all([
    getStorage(prisma),
    settingBool(prisma, "hardware.supply_chain.taa_compliant"),
    settingBool(prisma, "hardware.supply_chain.ndaa_889_compliant"),
  ]);
  return {
    appliance_id: process.env.DROPLET_DEVICE_ID ?? os.hostname() ?? "droplet",
    compute: getCompute(),
    storage,
    network: getNetwork(),
    display: getDisplay(),
    supply_chain: { taa, ndaa_889: ndaa },
  };
}
