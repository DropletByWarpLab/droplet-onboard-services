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
import { boxDisplayName } from "../lib/box-identity.js";
import { fetchGpuTelemetry } from "../lib/gpu-telemetry.js";

export interface HardwareCompute {
  control_plane: string;
  ai: string | null;
  util: number | null;
  temp_c: number | null;
}

export interface HardwareDrive {
  // size_tb is nullable until the device-bridge inventory wires capacity.
  // `0` would be indistinguishable from a real 0 TB drive; null says
  // "unknown" and lets the dashboard render an "unknown" pill.
  size_tb: number | null;
  display_name: string | null;
  encrypted: boolean | null;
}

export interface HardwareStorage {
  drives: HardwareDrive[];
  raid: string | null;
  // encrypted is nullable: the device-bridge probe that decides this
  // doesn't exist on this branch. `false` would falsely assert "not
  // encrypted" when the truth is unknown. Matches raid / used_tb.
  encrypted: boolean | null;
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
  // online is nullable until the service-health rollup (WARP-43) is
  // wired into the hardware composer. Hardcoding `true` falsely
  // claims the display is up on every host, including those with no
  // display hardware.
  online: boolean | null;
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
    // until the device-bridge inventory wires capacity, surface null.
    // `0` would be indistinguishable from a real 0 TB drive (CLAUDE.md
    // "no guessing" rule).
    drives = rows.map((r: { displayName: string; notes: string | null }) => ({
      size_tb: null,
      display_name: r.displayName,
      encrypted: null,
    }));
  } catch {
    drives = [];
  }
  return {
    drives,
    // RAID mode / used_tb / encrypted all come from a device-bridge
    // probe that doesn't exist on this branch. Returning null lets the
    // dashboard render an "unknown" pill rather than a fake value.
    raid: null,
    encrypted: null,
    used_tb: null,
  };
}

async function getCompute(): Promise<HardwareCompute> {
  // Across host types: the canonical answer comes from the same
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
  // WARP-1861 — util and temp_c now come from the host device-bridge's
  // read-only /gpu, which is the sanctioned path: this file's own header
  // records that the handbook bans direct /dev/dri probing from the
  // orchestrator, and the bridge already runs host-side behind a token.
  //
  // Both stay NULLABLE. The bridge returns null for a counter it cannot
  // read, and on an idle appliance that is the norm rather than an edge
  // case: with nothing holding the card amdgpu runtime-SUSPENDS it and the
  // sysfs reads return EBUSY. Reporting 0% there would claim a measurement
  // nobody took.
  const telemetry = await fetchGpuTelemetry();
  return {
    control_plane,
    // The resolved DRM node is the most useful thing we can name for the
    // AI accelerator, and it is what BRIDGE_GPU_CARD pins.
    ai: telemetry?.available ? telemetry.card : null,
    util: telemetry?.busyPercent ?? null,
    temp_c: telemetry?.tempC ?? null,
  };
}

function getDisplay(): HardwareDisplay {
  // display-service has its own /health surface; calling it from the
  // hardware composer adds a sync coupling we don't want on every
  // hardware-page render. Static tag matches the v2.6 HW contract;
  // `online: null` says "unknown" until the service-health rollup
  // (WARP-43) is wired. Hardcoding `true` would falsely claim the
  // display is up on every host, including those with no display
  // hardware. Matches every other unresolved field in this service.
  return { kind: "status display", online: null };
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
    // WARP-992: never `os.hostname()` — inside the container that is the
    // docker container id, and this field renders on the dashboard hardware
    // surface. HQ registry id when provisioned, else the canonical box name.
    appliance_id: (process.env.DROPLET_DEVICE_ID || "").trim() || boxDisplayName(),
    compute: await getCompute(),
    storage,
    network: getNetwork(),
    display: getDisplay(),
    supply_chain: { taa, ndaa_889: ndaa },
  };
}
