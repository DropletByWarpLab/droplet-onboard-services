/** ADR-070 §7: storage mutations must not remove the recordings allocation. */
import { getRecordingsAllocator } from "./recordings-allocator.singleton.js";
import { posix } from "node:path";
import type { NvrHostStatus } from "./recordings.types.js";

export interface RecordingsDriveRefusal {
  status: 409 | 503;
  code: "recordings_drive_active" | "recordings_status_unavailable" | "storage_busy";
  error: string;
}

/** Fixed copy and status for the bridge's recordings and topology guard codes. */
export function recordingsGuardRefusal(code: unknown): RecordingsDriveRefusal | null {
  if (code === "recordings_drive_active") return {
    status: 409,
    code,
    error: "This drive holds your camera recordings and cannot be ejected or changed.",
  };
  if (code === "recordings_status_unavailable") return {
    status: 503,
    code,
    error: "Recording storage could not be verified. Nothing was changed; try again when storage is available.",
  };
  if (code === "storage_busy") return {
    status: 409,
    code,
    error: "Another storage operation is running. Nothing was changed; try again when it finishes.",
  };
  return null;
}

function deviceName(value: unknown): string {
  if (typeof value !== "string") return "";
  const name = value.trim().replace(/^\/dev\//, "").replace(/^mapper\//, "");
  return validDeviceName(name) ? name : "";
}

const validDeviceName = (value: unknown): value is string => typeof value === "string" &&
  /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/.test(value) && !/[\r\n]/.test(value);
const validUuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9A-Fa-f][0-9A-Fa-f-]{6,35}$/.test(value) && !/[\r\n]/.test(value);
const validPath = (value: unknown): value is string => typeof value === "string" &&
  value.startsWith("/") && value !== "/" && !/[\x00-\x1f\x7f]/.test(value) && posix.normalize(value) === value;

/** Mirrors the host writer's normalized POSIX path, UUID and kernel-name contract. */
function verifiedPath(host: NvrHostStatus): boolean {
  if (host.mounted !== true || !validPath(host.source) || !validPath(host.mountPath) ||
    !(host.source === host.mountPath || host.source.startsWith(`${host.mountPath}/`)) ||
    !validUuid(host.fsUuid) || !Array.isArray(host.backingDevices) || !host.backingDevices.length ||
    !host.backingDevices.every(validDeviceName) || new Set(host.backingDevices).size !== host.backingDevices.length ||
    typeof host.physicalDisk !== "string") return false;
  const physical = host.physicalDisk.split(",");
  return physical.length > 0 && physical.every((name) => validDeviceName(name) && host.backingDevices.includes(name));
}

/** Fresh host facts and DB allocations: unknown status never authorizes a write. */
export async function guardRecordingsDrive(
  kind: "eject" | "pool",
  resourceId: string,
  params: Record<string, unknown> = {},
): Promise<RecordingsDriveRefusal | null> {
  const unavailable = recordingsGuardRefusal("recordings_status_unavailable")!;
  const active = recordingsGuardRefusal("recordings_drive_active")!;
  const allocator = getRecordingsAllocator();
  if (!allocator) return unavailable;
  try {
    const facts = await allocator.getFacts();
    const host = facts.host;
    if (!host || !host.source || (host.kind !== "volume" && host.kind !== "path")) return unavailable;
    if (host.kind === "path" && !verifiedPath(host)) return unavailable;
    if (host.kind === "volume" && (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host.source) || /[\r\n]/.test(host.source))) return unavailable;

    if (facts.allocations.some((row) => !validUuid(row.fsUuid))) return unavailable;
    const allocated = new Set(facts.allocations.map((row) => row.fsUuid.toLowerCase()));
    if (host.kind === "path") allocated.add(host.fsUuid!.toLowerCase());
    if (kind === "eject") return allocated.has(resourceId.toLowerCase()) ? active : null;

    const names = new Set([resourceId, params.device, params.member, params.md,
      ...(Array.isArray(params.members) ? params.members : [params.members]),
    ].map(deviceName).filter(Boolean));
    if (!names.size) return unavailable;
    const protectedNames = new Set(host.kind === "path" ? host.backingDevices.map(deviceName) : []);
    if (allocated.size && facts.drivesError) return unavailable;
    for (const uuid of allocated) {
      const drive = facts.drives.find((candidate) => candidate.fsUuid.toLowerCase() === uuid);
      if (!drive?.parentDisk) {
        // The live host's full device chain identifies its current drive;
        // every other allocation must be resolvable from the fresh inventory.
        if (host.kind === "path" && host.fsUuid!.toLowerCase() === uuid) continue;
        return unavailable;
      }
      const parents = drive.parentDisk.split(",");
      if (!parents.every(validDeviceName)) return unavailable;
      for (const name of parents) protectedNames.add(name);
    }
    return [...names].some((name) => protectedNames.has(name)) ? active : null;
  } catch {
    return unavailable;
  }
}
