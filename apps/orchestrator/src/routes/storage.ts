import { Router, Request } from "express";
import { z } from "zod";
import type { PrismaClient, $Enums } from "@prisma/client";
import { ncGetUserQuota } from "../services/nextcloud.client.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import type { StorageStats } from "../types/index.js";
import { requireRole, recordAccessDenied } from "../middleware/auth.js";
import { sensitiveRateLimit, standardRateLimit } from "../middleware/rate-limit.js";
import {
  evaluateStorageCommand,
  confirmStorageCommand,
} from "../services/storage-safety.service.js";
import { config } from "../config.js";
import { isBridgeConnectionError } from "../lib/bridge-errors.js";
import { createLogger } from "../lib/logger.js";

// Rescan / eject are owner+admin device-control actions. Family users can
// still see drives via the existing GET routes; they just can't poke the
// hardware. (WARP-1141: the rename PATCHes now use the canonical
// requireRole("owner", "admin") middleware instead of this ad-hoc check, so
// denials there get the WARP-237 mandatory-emit ACL audit row — an on-box
// blocked rename is diagnosable from the activity log instead of vanishing.)
function isAdmin(req: Request): boolean {
  const role = req.user?.role;
  return role === "owner" || role === "admin";
}

const logger = createLogger("storage-route");

/**
 * The device-bridge runs on the host and exposes auto-mounted USB drives at
 * /drives. The orchestrator reads through so the dashboard doesn't need to
 * know about host-side plumbing.
 *
 * URL comes from the shared `config.DEVICE_BRIDGE_URL` (default
 * `http://host.docker.internal:9090`) — the SAME value screen-qr.service.ts
 * uses. The previous hardcoded `172.17.0.1` (docker0 gateway) default could
 * not reach the bridge on the single-box, whose orchestrator container is on
 * the `droplet_default` bridge network (gateway 172.18.0.1) with docker0 down.
 * `host.docker.internal` resolves via the orchestrator's
 * `extra_hosts: host-gateway` mapping. `BRIDGE_URL` is still honored as a
 * legacy env alias (see config.ts).
 */
const BRIDGE_URL = config.DEVICE_BRIDGE_URL;

// WARP-612: shared secret the device-bridge requires on mutating routes
// (eject). Mirrors the bridge's own env precedence. Read per-request (see the
// eject handler) so a deployment that injects the secret after boot — and the
// tests — see the current value rather than a boot-time snapshot.
function bridgeAuthToken(): string {
  return (
    process.env.BRIDGE_AUTH_TOKEN ||
    process.env.SERVICE_TOKEN_DISPLAY ||
    ""
  ).trim();
}

interface BridgeDrive {
  device: string;
  /** WARP-827: whole-disk kernel name backing `device` (e.g. nvme0n1), set by
   *  the bridge so the orchestrator can drop partitions that live on the OS
   *  disk. Optional — an older bridge omits it. */
  parent_disk?: string;
  mount: string;
  label: string;
  uuid: string;
  size_bytes: number;
  used_bytes: number;
  free_bytes: number;
  mounted: boolean;
  /** WARP-612: read-only enrichment from the device-bridge. Optional so an
   *  older bridge that predates the enrichment still type-checks; `bus` is
   *  re-derived server-side (deriveBus) when the bridge omits it. */
  fs?: string;
  bus?: string;
  readonly?: boolean;
  /** WARP-612: SMART health ("PASSED"/"FAILED") + temperature °C. Present
   *  only when the bridge has DRIVE_SMART_ENABLED and smartctl can read the
   *  device; null/absent otherwise. The dashboard hides the chips when null. */
  smart?: string | null;
  temp_c?: number | null;
  /** WARP-612: hot-plug auto-mounted (ejectable) vs installed/fstab — the
   *  bus-agnostic ejectability signal (ADR-011). The UI shows Eject on this,
   *  not on bus. */
  removable?: boolean;
}

/** Fallback bus class for the icon when the bridge omits `bus` (older bridge).
 *  The bridge sends the *real* transport (it reads lsblk on the host); the
 *  orchestrator runs in a container without the host's block devices, so it
 *  can only name-guess. Stay neutral for sd* rather than guessing 'usb' — a
 *  /dev/sd* drive is just as likely SATA/SAS (ADR-011). Presentation-only. */
function deriveBus(device: string): string {
  const base = (device || "").split("/").pop() || "";
  if (base.startsWith("nvme")) return "nvme";
  if (base.startsWith("mmcblk")) return "mmc";
  return "disk";
}

// ── WARP-827: data-drive inclusion filter ──
//
// What may appear in the `drives` LIST is ONLY real, user-relevant data
// drives. Firmware/boot/swap/loop pseudo-devices and the OS/system disk must
// NEVER appear here dressed up as "your drive".
//
// WARP-2098 SCOPE NOTE — read this before relaxing anything below. This
// predicate governs `drives[]`, and the sibling filter further down governs
// `disks[]`. Both are unchanged, and both must stay: every destructive picker
// in the product iterates one of those two arrays (drive rename/eject, the
// Settings reformat list, the setup wizard's poolable and reclaimable lists,
// Erase & adopt), and their only OS-disk protection is this filter. What
// WARP-2098 added is a THIRD, separate key — `system_disk` — so the install
// disk can be DISPLAYED without ever being an element of a list something acts
// on. "The owner may not see it" was never the rule; "it may not be offered as
// storage they can spend or erase" is. Hiding it entirely had a real cost: the
// docker data-root (and so Nextcloud's uploaded files) lives on that disk, so
// it is the disk that fills first, and the owner had no way to see it.
//
// The ADR-002 home-user persona this block used to cite as its authority was
// retired wholesale by WARP-1341; the rule stands on its own merits.
//
// Layered rule (defense in depth):
//   • The device-bridge (services/oled-display/device-bridge.py) is the FIRST
//     layer: it already scopes enumeration to /mnt/* mounts, restricts to a
//     data-fstype allow-list (ext*/xfs/btrfs/f2fs/vfat/exfat/ntfs/zfs — no
//     tmpfs/swap/squashfs/overlay/proc/sys), excludes the /mnt/droplet OS-root
//     bind, skips zombie mounts, and drops trivially small (<100 MB) volumes.
//   • This predicate is the SECOND layer at the orchestrator boundary — the
//     CI-testable one (the bridge is host-side Python). It re-applies the same
//     intent so an older bridge (predating that scoping), a future bridge, a
//     mis-scoped/dev bridge, or a tampered snapshot can never leak junk to a
//     customer. It is purposely conservative: it only EXCLUDES things that are
//     unambiguously not user data, and never fabricates or mutates a drive.
//
// A drive is included iff ALL hold:
//   1. it is mounted (an unmounted entry has no browsable contents);
//   2. its mount path is a real user-storage location — under /mnt/ AND not
//      the /mnt/droplet OS-root bind itself (children /mnt/droplet/<x> are
//      fine). Pseudo mounts (/, /boot/efi, [SWAP], /snap/*, /proc, …) are out;
//   3. its filesystem (when the bridge reports one) is a data fstype, never
//      swap/squashfs/overlay/tmpfs/devtmpfs/proc/sysfs/cgroup.
// `fs`/`mount` are presentation/host facts from the bridge — this is a
// read-only display gate, never a security or eject gate (those stay in the
// bridge + storage-safety framework). The empty-list degradation below is
// preserved: a fully-junk snapshot yields [] honestly, not an error.

/** Filesystem types we treat as browsable user storage. Mirrors the bridge's
 *  `_DATA_FSTYPES`. An entry whose `fs` is set but absent from this set (swap,
 *  squashfs, overlay, tmpfs, …) is excluded. An entry with no `fs` is allowed
 *  to pass the fs check (an older bridge omits it) and is still gated by the
 *  mount-path rule. */
const DATA_FSTYPES = new Set([
  "ext4", "ext3", "ext2", "xfs", "btrfs", "f2fs",
  "vfat", "exfat", "ntfs", "ntfs3", "zfs",
]);

/** The OS-root shared-mount bind the automounter creates. Backed by the OS
 *  disk, so surfacing it would show the install as a "drive". Children
 *  (/mnt/droplet/<label-uuid>) are real hot-plug drives and ARE included. */
const OS_ROOT_BIND_MOUNT = "/mnt/droplet";

/** Predicate: is this bridge drive a real, user-relevant DATA drive worth
 *  showing on the home-user storage page? See the rule block above. */
function isUserDataDrive(d: BridgeDrive, osDisk?: string): boolean {
  if (!d.mounted) return false;
  const mount = (d.mount || "").replace(/\/+$/, "") || d.mount;
  // Rule 2: must be a real user-storage location under /mnt/, excluding the
  // OS-root bind itself. This rejects /, /boot/efi, [SWAP], /snap/*, etc.
  if (!mount.startsWith("/mnt/")) return false;
  if (mount === OS_ROOT_BIND_MOUNT) return false;
  // Rule 3: data fstype only (when the bridge reports one).
  if (d.fs && !DATA_FSTYPES.has(d.fs.toLowerCase())) return false;
  // Rule 4 (WARP-827): never a partition that lives on the OS/root disk. The
  // automounter can mount the install disk's EFI/boot partitions under /mnt/,
  // where rules 2-3 would pass them. The bridge already drops these (primary
  // gate); this is the defense-in-depth boundary check, exercised when the
  // bridge tags drives (parent_disk) + reports os_disk. Fails open: with no
  // os_disk we hide nothing, so a real data drive is never lost.
  if (osDisk && d.parent_disk && d.parent_disk === osDisk) return false;
  return true;
}

// The device-bridge only runs with the OLED/display compose profile. On a host
// without it, the fetch fails with ECONNREFUSED ("fetch failed" + a
// `cause.code` of ECONNREFUSED/ENOTFOUND/etc.). That's an EXPECTED condition —
// not an error — so we degrade cleanly (200 + `reason: "bridge_unavailable"`)
// and log at info level rather than warn/error. Real failures (a reachable
// bridge that times out or returns garbage) still log louder.
// (Classifier shared with hostapd-bridge.service.ts — see lib/bridge-errors.ts.)

/** WARP-936: one WHOLE physical disk from the bridge's lsblk inventory —
 *  including present-but-unmounted disks the mounted-only `drives` list is
 *  blind to. `state` is an explicit enum the bridge classified (the dashboard
 *  branches on it, never guesses):
 *    in_use      — the disk, a partition, or an md it backs is mounted
 *    pool_member — carries a linux_raid_member signature (`md` names the array)
 *    foreign     — has some fs/RAID/LVM signature but nothing mounted
 *    available   — no signature at all
 *  Read-only inventory — every destructive action stays behind the existing
 *  tier-3 confirm-token + typed-phrase flow. */
interface BridgeDisk {
  name: string;
  size_bytes: number;
  state: "in_use" | "pool_member" | "foreign" | "available";
  fstype?: string;
  bus?: string;
  model?: string;
  serial?: string;
  /** md array name (e.g. "md127") when state is pool_member. */
  md?: string;
}

interface BridgeDrivesSnapshot {
  drives: BridgeDrive[];
  count: number;
  /** WARP-827: whole-disk kernel name backing root "/" (e.g. nvme0n1); lets the
   *  orchestrator exclude any drive whose parent_disk matches. Absent when the
   *  bridge can't resolve it (then we hide nothing — fail open). */
  os_disk?: string;
  /** WARP-936: whole-disk inventory with explicit states. Absent on an older
   *  bridge — the route then forwards an empty list, never an error. */
  disks?: BridgeDisk[];
  /** WARP-2098: the appliance's OWN install disk, reported by the bridge in a
   *  key of its own. Absent on an older bridge, and absent when the bridge
   *  could not measure the root filesystem — never null, never zeroed, so
   *  "nothing to say" stays distinguishable from "empty". */
  system_disk?: BridgeSystemDisk;
  snapshot_at: string;
}

/**
 * WARP-2098 — the box's own system/install disk.
 *
 * This is NOT a member of `drives` or `disks`, and must never become one.
 * Those two lists feed every destructive picker in the product (adopt,
 * reclaim, pool-create, the Settings reformat list), and the WARP-827 rules
 * that keep the OS disk out of them are unchanged by this ticket. What
 * changes is only that the disk is now *reportable* — the owner can see the
 * Droplet's own disk and how full it is, which matters here because
 * Nextcloud's data directory lives on it while the storage pool is attached
 * to Nextcloud only as external storage.
 *
 * `used_bytes`/`free_bytes` are `null` when the bridge identified the disk but
 * could not measure anything on it. Rendering that as 0 would claim a pristine
 * empty disk, so the UI shows capacity with no meter instead.
 */
interface BridgeSystemDisk {
  /** Whole-disk kernel name, e.g. "nvme0n1". The bridge omits the whole object
   *  rather than sending an unresolved or partition-shaped name. */
  name: string;
  /** The PHYSICAL disk. `used_bytes` is the sum across `filesystems`, so
   *  unallocated LVM extents correctly land in `free_bytes`. */
  size_bytes: number;
  used_bytes: number | null;
  free_bytes: number | null;
  model: string;
  serial: string;
  bus: string;
  /** Every mounted filesystem on this disk, one per backing device. On a
   *  provisioned box that is root, /boot/efi and /data — and /data is the one
   *  that matters, since the docker data-root (and so Nextcloud's files) lives
   *  there. `role` is assigned by the bridge so no client pattern-matches host
   *  paths. */
  filesystems: Array<{
    mount: string;
    role: "root" | "boot" | "data";
    fs: string;
    size_bytes: number;
    used_bytes: number;
    free_bytes: number;
  }>;
}

/**
 * WARP-2098 — the box's real data-storage figure.
 *
 * Summed over the SAME post-filter `drives` array this route returns, so the
 * OS-disk exclusion that already governs that array governs the total for
 * free. Summing anything earlier (`snap.drives`) would silently re-admit every
 * OS partition; summing `disks` would double-count a pool, whose members
 * appear there as `pool_member` while the pool's real capacity is the one
 * mounted md filesystem already in `drives`.
 *
 * This is NOT pool capacity and must never be labelled as such — ADR-019
 * deleted a client-side "Total pooled storage" byte-sum for exactly that
 * reason, and drives-panel.pools.test.tsx still guards the phrase.
 */
interface DataStorageTotals {
  size_bytes: number;
  used_bytes: number;
  free_bytes: number;
  drive_count: number;
  /** Explicit provenance so a reader of the payload (or the LLM, via
   *  list_drives) can never mistake this for pool or box-wide capacity. */
  source: "data_drives";
}

// ── BUG-3 / ADR-019: storage pools ──

/** One md array as the device-bridge reports it (read-only, from /proc/mdstat).
 *  `status` / `level` are the ADR-019 enum *values* the bridge already mapped —
 *  the orchestrator never re-parses mdstat. */
interface BridgePool {
  device: string;
  level: string;
  status: string;
  members: string[];
}

interface BridgePoolsSnapshot {
  pools: BridgePool[];
  count: number;
  snapshot_at?: string;
}

/** Destructive storage operations, mapped to the bridge `/pools/command`
 *  `operation` field. Keep in lock-step with STORAGE_TIER_3_OPERATIONS and the
 *  host script's allow-list. */
const STORAGE_OPS = [
  "pool_create",
  "pool_destroy",
  "pool_format",
  "pool_set_level",
  "pool_add_spare",
  "pool_remove_disk",
  "drive_adopt", // WARP-662: wipe + reformat + mount a previously-used disk
  "drive_reclaim", // WARP-1048: detach a pool member from its md array, then adopt it
] as const;
type StorageOp = (typeof STORAGE_OPS)[number];

/**
 * Forward an owner-confirmed destructive op to the device-bridge's auth-gated
 * POST /pools/command. Mirrors the eject path's auth + connection-error
 * handling. Returns the bridge's parsed body; throws on a non-ok bridge reply
 * so the route can surface it.
 */
async function bridgePoolCommand(
  operation: StorageOp,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  const bridgeToken = bridgeAuthToken();
  if (!bridgeToken) {
    // Fail closed: with no bridge auth token we cannot safely invoke a
    // data-destroying host action.
    const err = new Error("bridge_auth_unconfigured");
    (err as { code?: string }).code = "BRIDGE_AUTH_UNCONFIGURED";
    throw err;
  }
  const ctrl = new AbortController();
  // The host script runs mdadm/mkfs which can take minutes on a large array.
  const timer = setTimeout(() => ctrl.abort(), 600_000);
  try {
    const r = await fetch(`${BRIDGE_URL}/pools/command`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Droplet-Auth": bridgeToken,
      },
      body: JSON.stringify({ operation, params }),
      signal: ctrl.signal,
    });
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: r.ok, body };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * WARP-2098 — totals over an ALREADY-FILTERED data-drive list.
 *
 * Takes the filtered array as its argument rather than the raw snapshot, on
 * purpose: the only way this figure can be wrong is by being computed one step
 * too early, so the function is given no way to reach the unfiltered list. Both
 * GET /storage and GET /storage/drives call it with the output of
 * isUserDataDrive, which is what keeps the two endpoints agreeing.
 *
 * Returns null for an empty list — "there is nothing to total", which a client
 * renders as an empty state. A zeroed object would read as "you have drives and
 * they are empty", which is a different and false claim.
 */
function computeDataTotals(dataDrives: readonly BridgeDrive[]): DataStorageTotals | null {
  if (dataDrives.length === 0) return null;
  return {
    size_bytes: dataDrives.reduce((n, d) => n + (d.size_bytes || 0), 0),
    used_bytes: dataDrives.reduce((n, d) => n + (d.used_bytes || 0), 0),
    free_bytes: dataDrives.reduce((n, d) => n + (d.free_bytes || 0), 0),
    drive_count: dataDrives.length,
    source: "data_drives",
  };
}

/**
 * Read the device-bridge's /drives snapshot. Shared by GET /storage and
 * GET /storage/drives so there is ONE definition of the request (auth header,
 * timeout, non-ok handling). Throws on a non-ok reply; connection failures
 * propagate as-is for isBridgeConnectionError to classify.
 */
async function fetchBridgeDrives(): Promise<BridgeDrivesSnapshot> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    // WARP-659: /drives is token-gated on the bridge (it is LAN-reachable via
    // BRIDGE_BIND=0.0.0.0). Send the same shared secret the eject path uses.
    const token = bridgeAuthToken();
    const r = await fetch(`${BRIDGE_URL}/drives`, {
      signal: ctrl.signal,
      ...(token ? { headers: { "X-Droplet-Auth": token } } : {}),
    });
    if (!r.ok) {
      const err = new Error(`bridge returned ${r.status}`);
      (err as { status?: number }).status = r.status;
      throw err;
    }
    return (await r.json()) as BridgeDrivesSnapshot;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bridge drive enriched with the customer-chosen Drive row (WARP-174).
 * `displayName` is the friendly name the customer typed in the setup
 * wizard's Storage step (or in /storage later); `null` when no Drive
 * row exists yet for this UUID.
 */
interface DriveWithLabel extends BridgeDrive {
  displayName: string | null;
  icon: string | null;
  notes: string | null;
  /** WARP-1339: bare md array name (e.g. "md127" — the exact join key the
   *  /storage/pools payload's `device` field carries, WITHOUT the /dev/
   *  prefix this drive's own `device` has) when this mounted filesystem
   *  lives on an md node or a partition of one. The dashboard joins on it
   *  to render ONE pooled entry instead of pool card + anonymous GUID
   *  drive tile. `null` (explicit — clients branch on the field, never on
   *  its absence) for a standalone drive. The drive is NEVER dropped
   *  server-side: it is the pool's only fs-level capacity/browse source,
   *  and tools-core's list_drives stays an honest annotated list. */
  pool: string | null;
}

/** WARP-1339: md node (/dev/md127) or a partition of one (/dev/md127p1).
 *  Capture group 1 is the bare array name — a PARTITION is tagged with its
 *  ARRAY's name, since /storage/pools only ever names the array. Anchored so
 *  /dev/md127p1 can never tag as md12 (same pitfall the dashboard's
 *  poolHasMountedFs matcher guards). */
const MD_DEVICE_RE = /^\/dev\/(md\d+)(?:p\d+)?$/;

const updateDriveSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  icon: z.string().trim().min(1).max(48).nullable().optional(),
  notes: z.string().trim().max(512).nullable().optional(),
});

/** WARP-1048: rename / annotate a storage pool. Same shape as the Drive label
 *  upsert (no icon — a pool has no per-device icon). */
const updatePoolSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
  notes: z.string().trim().max(512).nullable().optional(),
});

/** WARP-1337: optional customer-facing name accepted at pool CREATE time, so a
 *  new pool is born named instead of waiting for a later PATCH rename. Same
 *  constraint as the rename schema. Zod-parsed BEFORE any prisma call (pre-DB
 *  gate); the name rides in the confirm-token params and is seeded into the
 *  StoragePool row only after the bridge reports the create succeeded — it is
 *  never forwarded to the host script (which has no such parameter). */
const createPoolNameSchema = z.object({
  displayName: z.string().trim().min(1).max(64).optional(),
});

/**
 * GET /api/storage — return the authenticated user's Nextcloud storage quota.
 *
 * Nextcloud enforces per-user quotas via OCS `/cloud/user`. We proxy that
 * call so the dashboard sees one consistent storage view regardless of
 * which user is logged in.
 */
export function createStorageRouter(prisma: PrismaClient): Router {
  const router = Router();

  /**
   * WARP-1048: resolve a pool's live RAID level from the device-bridge GET
   * /pools inventory. Used when a first-time rename must create the StoragePool
   * row (whose `level` is a required explicit enum — never a host default).
   * Returns the level string when the array is present + its level is a known
   * ArrayLevel, else undefined (caller refuses rather than fabricating a row).
   */
  async function resolveBridgePoolLevel(
    device: string,
  ): Promise<$Enums.ArrayLevel | undefined> {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${BRIDGE_URL}/pools`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) return undefined;
      const snap = (await r.json()) as BridgePoolsSnapshot;
      const match = (snap.pools ?? []).find((p) => p.device === device);
      // Only a level that is a real ArrayLevel enum value is accepted; the
      // StoragePool row's `level` column is that enum (never a free string).
      if (match && VALID_LEVELS.has(match.level)) {
        return match.level as $Enums.ArrayLevel;
      }
      return undefined;
    } catch {
      // Bridge unreachable / bad JSON — the caller refuses the create. Reads are
      // best-effort; never throw here.
      return undefined;
    }
  }

  /**
   * GET /api/storage — the box's storage at a glance.
   *
   * WARP-2098 changed what the four headline numbers MEAN, and the reason is
   * the whole point of the ticket.
   *
   * They used to be the signed-in user's Nextcloud quota. On this appliance
   * that is not a description of the owner's storage: nothing sets a quota, so
   * Nextcloud reports free space of the filesystem holding its data directory —
   * and that directory is a plain named volume under the docker data-root on
   * `/data`, an LV on the OS/boot disk (docs/security/at-rest-encryption.md).
   * The storage pool is attached to Nextcloud only as `files_external`, which
   * OCS quota does not count. So the one box-level storage figure the API
   * produced described the INSTALL DISK while being labelled "your storage" —
   * the boot disk and the pool lumped into a single wrong number.
   *
   * They are now the sum over the same os_disk-filtered data-drive list
   * GET /storage/drives returns (computeDataTotals). The install disk is
   * reported separately as `system`, and the Nextcloud figure is still
   * available, honestly named, as `cloud`.
   *
   * The four scalars keep their names and types. That is deliberate: the iOS
   * client decodes them as non-optional (`StorageOverview`), and it already
   * presents them as the appliance's storage rather than as a cloud quota — so
   * it gets a correct number without a release, and adding sibling objects
   * cannot break its decoder.
   */
  // standardRateLimit joins the other bridge-proxied readers: as of WARP-2098
  // this handler fetches the device-bridge, so it falls under the same CodeQL
  // js/missing-rate-limiting ceiling /storage/drives already carries.
  router.get("/storage", standardRateLimit, async (req, res, next) => {
    try {
      // The Nextcloud quota is still worth reporting — it is what the user's
      // own cloud account can hold — it just is not the box's storage. Failing
      // to read it must not fail the whole response, so it degrades to null.
      let cloud: StorageStats | null = null;
      try {
        const token = await resolveNcToken(req);
        // No resolvable credential is the orphan-session case (a session that
        // pre-dates the NC-session store), not an error.
        const quota = token ? await ncGetUserQuota(token) : null;
        if (quota) {
          const total = quota.total ?? 0;
          const used = quota.used ?? 0;
          const available = quota.free ?? Math.max(0, total - used);
          cloud = {
            used,
            total,
            available,
            percentage: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
          };
        }
      } catch (err) {
        logger.warn({ err }, "Failed to fetch Nextcloud quota");
      }

      let totals: DataStorageTotals | null = null;
      let system: BridgeSystemDisk | undefined;
      try {
        const snap = await fetchBridgeDrives();
        // SAME filter as GET /storage/drives — the OS disk is excluded here by
        // construction, not by a second rule that could drift from the first.
        totals = computeDataTotals(
          (snap.drives ?? []).filter((d) => isUserDataDrive(d, snap.os_disk)),
        );
        system = snap.system_disk;
      } catch (err) {
        // The bridge is optional (OLED/display profile) and host-side. Without
        // it we have no honest drive figures — so report zeroes and say why,
        // rather than falling back to the Nextcloud number, which is the exact
        // boot-disk figure this ticket removed.
        if (isBridgeConnectionError(err)) {
          logger.info({ bridgeUrl: BRIDGE_URL }, "device-bridge not reachable; no storage totals");
        } else {
          logger.warn({ err }, "Failed to fetch drives from device-bridge");
        }
      }

      res.json({
        // Headline = the owner's DATA drives. Zeroes when there are none, which
        // clients already treat as "no capacity to show" (iOS: hasCapacity).
        used: totals?.used_bytes ?? 0,
        total: totals?.size_bytes ?? 0,
        available: totals?.free_bytes ?? 0,
        percentage:
          totals && totals.size_bytes > 0
            ? Math.round((totals.used_bytes / totals.size_bytes) * 1000) / 10
            : 0,
        // Provenance for the four numbers above, so no future reader has to
        // guess which disks they cover. null when the bridge said nothing.
        totals,
        // The install disk, never folded into the numbers above.
        ...(system !== undefined ? { system_disk: system } : {}),
        // The Nextcloud account quota, under a name that says what it is.
        cloud,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /api/storage/network-drive — connection info for the SMB "Droplet"
   * share (the compose `samba` service), rendered by the dashboard's
   * "Connect network drive" dialog: host names, the Windows UNC path, the
   * macOS smb:// URL, and the device-wide credential.
   *
   * Owner/admin only via requireRole: the credential is DEVICE-WIDE — it
   * opens the whole share regardless of who types it — so handing it to
   * family/guest sessions would bypass the per-user file permissions every
   * other files surface enforces. Per-user SMB accounts are the follow-up
   * that relaxes this (see docs/network-drive.md).
   *
   * `enabled` mirrors config.SMB_ENABLED (the explicit switch setup.sh
   * writes); `password` is null when the share is disabled or the credential
   * was never generated, so the dialog renders honest "not available" copy
   * instead of an empty string that looks like a blank password.
   */
  router.get(
    "/storage/network-drive",
    requireRole("owner", "admin"),
    (_req, res) => {
      const enabled = config.SMB_ENABLED;
      const hasCredential = config.SMB_PASSWORD !== "";
      const mdnsHost = `${config.DROPLET_MDNS_HOSTNAME}.local`;
      const lanHost = config.DROPLET_LAN_HOSTNAME;
      res.json({
        enabled,
        share: "Droplet",
        username: "droplet",
        password: enabled && hasCredential ? config.SMB_PASSWORD : null,
        hosts: { mdns: mdnsHost, lan: lanHost },
        // Router DNS for Windows (resolves on every client via dnsmasq);
        // mDNS for macOS (always on, no router dependency).
        windowsPath: `\\\\${lanHost}\\Droplet`,
        macosUrl: `smb://${mdnsHost}/Droplet`,
      });
    },
  );

  /**
   * GET /api/storage/drives — USB drives auto-mounted on the appliance host.
   *
   * Reads from the device-bridge (services/oled-display/device-bridge.py)
   * running on the host at :9090. Bridge reads from the automount
   * state file, so the mount set here matches what the on-screen UI
   * and Nextcloud show.
   *
   * WARP-174: each drive is enriched with the customer-chosen
   * `displayName` / `icon` / `notes` from the `Drive` table when one
   * exists. Fields are `null` for drives the customer hasn't named yet.
   */
  // CodeQL js/missing-rate-limiting — inline per-IP ceilings on the bridge-
  // proxied drive handlers. /drives is a plain read the dashboard fetches on
  // page load (no polling), so the standard preset; rescan and eject drive
  // udev/unmount work on the host, so they get the tighter sensitive preset.
  router.get("/storage/drives", standardRateLimit, async (_req, res) => {
    try {
      // WARP-2098: shared with GET /storage so both endpoints ask the bridge
      // the same question the same way.
      let snap: BridgeDrivesSnapshot;
      try {
        snap = await fetchBridgeDrives();
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === undefined) throw err; // connection failure — outer catch
        // WARP-2098: totals is explicitly null on every degraded path — the
        // client branches on null to render "no data drives" rather than a 0 B
        // meter, and a missing key would be indistinguishable from an older
        // orchestrator that never sends totals at all.
        res.status(502).json({ drives: [], count: 0, totals: null,
          error: `bridge returned ${status}` });
        return;
      }

      // WARP-827: drop firmware/boot/swap/loop pseudo-devices and the OS disk
      // at the orchestrator boundary so the home-user only ever sees real data
      // drives. See isUserDataDrive() for the documented rule. Done BEFORE the
      // Drive-table join so we never query labels for junk.
      const dataDrives = (snap.drives ?? []).filter((d) => isUserDataDrive(d, snap.os_disk));

      // Single batched lookup — Drive table is tiny (one row per
      // physical drive the customer has named), so an unfiltered
      // findMany is fine. The Map keeps the join O(n) total.
      const uuids = dataDrives.map((d) => d.uuid).filter(Boolean);
      const labels = uuids.length
        ? await prisma.drive.findMany({ where: { uuid: { in: uuids } } })
        : [];
      const byUuid = new Map(labels.map((l) => [l.uuid, l]));

      const drives: DriveWithLabel[] = dataDrives.map((d) => {
        const label = byUuid.get(d.uuid);
        return {
          ...d,
          // Guarantee a bus class for the dashboard even if the bridge is
          // older than the WARP-612 enrichment.
          bus: d.bus ?? deriveBus(d.device),
          displayName: label?.displayName ?? null,
          icon: label?.icon ?? null,
          notes: label?.notes ?? null,
          // WARP-1339: annotate (never drop) the mounted md filesystem with
          // its bare array name so the dashboard can merge it into the pool
          // card instead of rendering it twice.
          pool: MD_DEVICE_RE.exec(d.device)?.[1] ?? null,
        };
      });

      // WARP-936: forward the whole-disk inventory so the dashboard can
      // surface present-but-unmounted disks (adopt/pool flows). Same
      // defense-in-depth as the mounted list: anything matching os_disk is
      // dropped here too, even though the bridge already excludes it. An
      // older bridge without the field yields an ABSENT key — never `[]`,
      // never an error: host-side bridges only update on reflash while this
      // container updates independently, and the setup wizard discriminates
      // on `disks ?? null` to fall back to the mounted-drives reclaim list
      // (WARP-662). An empty array would read as an authoritative "no disks"
      // and silently drop that fallback.
      const disks =
        snap.disks !== undefined
          ? snap.disks.filter((d) => !snap.os_disk || d.name !== snap.os_disk)
          : undefined;

      // WARP-2098: the box's data-storage total, summed over the post-filter
      // list — never snap.drives, never disks. Same helper GET /storage uses.
      const totals = computeDataTotals(dataDrives);

      // WARP-2098: forward the install disk VERBATIM in its own key. It is
      // deliberately not spread into `drives`, not counted in `count`, and not
      // added into `totals` — see BridgeSystemDisk. Absent (not null) on an
      // older bridge, matching how `disks` degrades, so the dashboard hides
      // the card rather than rendering an empty one.
      const systemDisk = snap.system_disk;

      // count reflects the FILTERED set the dashboard renders, not the raw
      // bridge count (which may include the junk we just dropped).
      res.json({
        drives,
        count: drives.length,
        totals,
        ...(disks !== undefined ? { disks } : {}),
        ...(systemDisk !== undefined ? { system_disk: systemDisk } : {}),
        snapshot_at: snap.snapshot_at,
      });
    } catch (err) {
      // The device-bridge is optional (OLED/display profile only). A
      // connection refusal means it simply isn't running on this host — an
      // expected deployment shape, not an error. Degrade cleanly: 200 with an
      // empty drive list and a typed reason the dashboard can branch on.
      if (isBridgeConnectionError(err)) {
        logger.info(
          { bridgeUrl: BRIDGE_URL },
          "device-bridge not reachable; reporting no drives (bridge_unavailable)",
        );
        res.json({ drives: [], count: 0, totals: null, reason: "bridge_unavailable" });
        return;
      }
      // A reachable-but-misbehaving bridge (timeout, bad JSON, etc.) is a real
      // problem worth a louder log; still return the 200 empty shape so the
      // dashboard renders.
      logger.warn({ err }, "Failed to fetch drives from device-bridge");
      res.json({ drives: [], count: 0, totals: null,
        error: (err as Error).message || "bridge unreachable" });
    }
  });

  /**
   * PATCH /api/storage/drives/:uuid — upsert the customer's name + icon
   * + notes for a drive (WARP-174).
   *
   * Upsert semantics: first PATCH creates the row, subsequent PATCHes
   * update it. UUID is the FS UUID from the bridge; we don't verify the
   * drive is currently mounted because the customer may want to rename
   * a drive that's currently unplugged.
   *
   * Mirrors the shape of `PATCH /network/devices/:mac` from ADR-002
   * Phase 1 device intelligence.
   *
   * Owner/admin only via the canonical requireRole guard (WARP-1141) — the
   * label is device-wide config any family account shares. requireRole (not
   * the local isAdmin helper) so a denial emits the WARP-237 ACL audit row,
   * matching every other owner-level storage action in this file.
   */
  router.patch("/storage/drives/:uuid", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { uuid } = req.params;
      // FAT/exFAT UUIDs sometimes include `:` (rare on Linux blkid output,
      // common on macOS/Windows-formatted disks); accept it alongside the
      // hyphenated EXT/NTFS-style UUIDs the original regex covered.
      // WARP-1141: the literal "undefined"/"null" pass the charset regex but
      // are a client stringifying a MISSING uuid — upserting them creates a
      // junk row no real drive ever joins, and the rename "succeeds" silently.
      if (!/^[A-Za-z0-9:-]{1,64}$/.test(uuid) || uuid === "undefined" || uuid === "null") {
        return res
          .status(400)
          .json({ error: "Invalid drive UUID" });
      }
      const parsed = updateDriveSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          details: parsed.error.flatten(),
        });
      }
      const { displayName, icon, notes } = parsed.data;
      if (
        displayName === undefined &&
        icon === undefined &&
        notes === undefined
      ) {
        return res
          .status(400)
          .json({ error: "At least one of displayName / icon / notes is required" });
      }

      // Upsert. `create` requires displayName, so first-time PATCHes
      // must include it; updates can be partial.
      const existing = await prisma.drive.findUnique({ where: { uuid } });
      if (!existing && displayName === undefined) {
        return res.status(400).json({
          error: "displayName is required when first naming a drive",
        });
      }
      const drive = await prisma.drive.upsert({
        where: { uuid },
        create: {
          uuid,
          displayName: displayName!,
          icon: icon ?? null,
          notes: notes ?? null,
        },
        update: {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(icon !== undefined ? { icon } : {}),
          ...(notes !== undefined ? { notes } : {}),
        },
      });
      res.json(drive);
    } catch (err) {
      logger.warn({ err, uuid: req.params.uuid }, "Failed to update Drive label");
      next(err);
    }
  });

  /**
   * POST /api/storage/drives/rescan — refresh the device-bridge's drive
   * snapshot (it caches ~10s). Proxies the bridge's existing
   * `/drives/changed` cache-invalidation hook — the same one the automount
   * udev rule calls on hot-plug — so this only drops a cache; it never
   * mounts or unmounts. Admin-only because it's a device-control action.
   */
  router.post("/storage/drives/rescan", sensitiveRateLimit, async (req, res) => {
    if (!isAdmin(req)) {
      // WARP-1062 (audit item B): emit the WARP-237 policy-violation row —
      // local isAdmin() denials must not be silent (requireRole parity).
      // (The two label PATCHes move to requireRole outright in PR #929 /
      // WARP-1141 — those call sites are deliberately not touched here.)
      recordAccessDenied(req, "role-not-permitted");
      return res.status(403).json({ error: "Admin access required" });
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      // /drives/changed is auth-gated on the bridge now (this PR) — without
      // the shared token every rescan 401s and the dashboard rescan dies as
      // a 502 (review blocker on this PR).
      const r = await fetch(`${BRIDGE_URL}/drives/changed`, {
        method: "POST",
        headers: { "X-Droplet-Auth": bridgeAuthToken() },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!r.ok) {
        return res.status(502).json({ ok: false, error: `bridge returned ${r.status}` });
      }
      return res.json({ ok: true });
    } catch (err) {
      // The device-bridge is optional (OLED/display profile only). A connection
      // refusal means it simply isn't running on this host — degrade cleanly
      // with a typed reason instead of leaking the raw "fetch failed" string.
      if (isBridgeConnectionError(err)) {
        logger.warn({ err }, "device-bridge not reachable (bridge_unavailable)");
        return res.status(503).json({
          ok: false,
          reason: "bridge_unavailable",
          error: "The storage service isn't reachable right now.",
        });
      }
      logger.warn({ err }, "Failed to trigger drive rescan");
      return res
        .status(502)
        .json({ ok: false, error: (err as Error).message || "bridge unreachable" });
    }
  });

  /**
   * POST /api/storage/drives/:uuid/eject — unmount + forget a hot-plug
   * auto-mounted drive (WARP-612). Admin-only. Forwards to the device-bridge's
   * auth-gated /drives/:uuid/eject, which gates on automount-state membership +
   * a /mnt/droplet/ mount (bus-agnostic per ADR-011 — USB, external NVMe, SD,
   * SATA dock, etc.), not on bus type. Requires a bridge auth token; 503 if the
   * deployment hasn't provisioned one. A 409 (drive busy) is surfaced so the
   * user can close files and retry; other bridge errors return a generic
   * message and are logged server-side.
   */
  router.post("/storage/drives/:uuid/eject", sensitiveRateLimit, async (req, res) => {
    if (!isAdmin(req)) {
      // WARP-1062 (audit item B): requireRole-parity policy-violation row.
      recordAccessDenied(req, "role-not-permitted");
      return res.status(403).json({ error: "Admin access required" });
    }
    const { uuid } = req.params;
    if (!/^[A-Za-z0-9:-]{1,64}$/.test(uuid)) {
      return res.status(400).json({ error: "Invalid drive UUID" });
    }
    const bridgeToken = bridgeAuthToken();
    if (!bridgeToken) {
      return res.status(503).json({
        ok: false,
        error: "Drive eject is unavailable — the device-bridge auth token is not configured.",
      });
    }
    try {
      const ctrl = new AbortController();
      // The bridge's eject runs sync (≤10s) + umount (≤20s) = ~30s worst case,
      // so wait longer than that: aborting at 25s would 502 an eject the bridge
      // actually completed, leaving the user retrying an already-unmounted drive.
      const timer = setTimeout(() => ctrl.abort(), 35000);
      const r = await fetch(`${BRIDGE_URL}/drives/${encodeURIComponent(uuid)}/eject`, {
        method: "POST",
        headers: { "X-Droplet-Auth": bridgeToken },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        // Log the bridge's raw message server-side; only the 409 "busy" case is
        // actionable enough to surface (and bridge errors can carry mount
        // internals, so other statuses get a generic message).
        logger.warn({ uuid, status: r.status, bridgeError: body.error }, "Drive eject rejected by bridge");
        return res.status(r.status === 409 ? 409 : 502).json({
          ok: false,
          error:
            r.status === 409
              ? body.error || "The drive is in use — close any open files and try again."
              : "The device-bridge could not complete the eject.",
        });
      }
      return res.json({ ok: true });
    } catch (err) {
      // The device-bridge is optional (OLED/display profile only). A connection
      // refusal means it simply isn't running on this host — degrade cleanly
      // with a typed reason instead of leaking the raw "fetch failed" string.
      if (isBridgeConnectionError(err)) {
        logger.warn({ err, uuid }, "device-bridge not reachable (bridge_unavailable)");
        return res.status(503).json({
          ok: false,
          reason: "bridge_unavailable",
          error: "The storage service isn't reachable right now.",
        });
      }
      logger.warn({ err, uuid }, "Failed to eject drive");
      return res
        .status(502)
        .json({ ok: false, error: (err as Error).message || "bridge unreachable" });
    }
  });

  // =====================================================================
  // BUG-3 / ADR-019 — storage pools (mdadm software RAID)
  // =====================================================================

  /**
   * GET /api/storage/pools — read-only mdadm array inventory.
   *
   * Reads from the device-bridge GET /pools (which parses /proc/mdstat
   * read-only) and joins the owner-chosen displayName / notes from the
   * StoragePool table, exactly as /storage/drives joins the Drive table.
   *
   * Returns an HONEST empty list when no array exists — never a fabricated
   * "pooled storage" sum of loose drives (ADR-019 D2). No role gate: reading
   * array health is safe and is the source for the dashboard's degraded banner.
   */
  router.get("/storage/pools", async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const r = await fetch(`${BRIDGE_URL}/pools`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!r.ok) {
        res.status(502).json({ pools: [], count: 0, error: `bridge returned ${r.status}` });
        return;
      }
      const snap = (await r.json()) as BridgePoolsSnapshot;
      const rows = await prisma.storagePool.findMany();
      const byDevice = new Map(rows.map((p) => [p.device, p]));

      const pools = (snap.pools ?? []).map((p) => {
        const row = byDevice.get(p.device);
        return {
          ...p,
          displayName: row?.displayName ?? null,
          notes: row?.notes ?? null,
        };
      });
      res.json({ pools, count: pools.length, snapshot_at: snap.snapshot_at });
    } catch (err) {
      // Same optional-bridge degradation as /storage/drives: a connection
      // refusal means the bridge simply isn't running on this host — report
      // "no pools" honestly rather than 500.
      if (isBridgeConnectionError(err)) {
        logger.info({ bridgeUrl: BRIDGE_URL }, "device-bridge not reachable; reporting no pools");
        res.json({ pools: [], count: 0, reason: "bridge_unavailable" });
        return;
      }
      logger.warn({ err }, "Failed to fetch pools from device-bridge");
      res.json({ pools: [], count: 0, error: (err as Error).message || "bridge unreachable" });
    }
  });

  /**
   * PATCH /api/storage/pools/:device — rename (+ annotate) a storage pool
   * (WARP-1048). Owner/admin only via requireRole (WARP-1141 — audited
   * denials), mirroring PATCH /storage/drives/:uuid: the pool name is
   * device-wide config any family account shares, so only owner/admin
   * may change it (family users still see it via GET). Non-destructive — this
   * only writes the owner's chosen label to the StoragePool row; it never
   * touches mdadm.
   *
   * Upsert semantics like the Drive label. `StoragePool.level` is required on
   * create, so on a first-time rename we resolve the live RAID level from the
   * device-bridge inventory (never a host-specific default — rule 12). If the
   * bridge can't confirm the array exists, we refuse rather than fabricate a
   * row for a pool that isn't there.
   */
  router.patch("/storage/pools/:device", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { device } = req.params;
      if (!validMdDevice(device)) {
        return res.status(400).json({ error: "Invalid pool device (expected md<N>)" });
      }
      const parsed = updatePoolSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error: "Invalid request",
          details: parsed.error.flatten(),
        });
      }
      const { displayName, notes } = parsed.data;
      if (displayName === undefined && notes === undefined) {
        return res
          .status(400)
          .json({ error: "At least one of displayName / notes is required" });
      }

      const existing = await prisma.storagePool.findUnique({ where: { device } });
      if (!existing && displayName === undefined) {
        return res.status(400).json({
          error: "displayName is required when first naming a pool",
        });
      }

      // First-time create needs the live RAID level (an explicit enum column,
      // never derived — rule 10/12). Resolve it from the bridge inventory.
      let level: $Enums.ArrayLevel | undefined;
      if (!existing) {
        level = await resolveBridgePoolLevel(device);
        if (!level) {
          return res.status(404).json({
            error: "That storage pool isn't visible right now — try again once it's online.",
          });
        }
      }

      const pool = await prisma.storagePool.upsert({
        where: { device },
        create: {
          device,
          displayName: displayName!,
          level: level!,
          ...(notes !== undefined ? { notes } : {}),
        },
        update: {
          ...(displayName !== undefined ? { displayName } : {}),
          ...(notes !== undefined ? { notes } : {}),
        },
      });
      res.json(pool);
    } catch (err) {
      logger.warn({ err, device: req.params.device }, "Failed to update StoragePool label");
      next(err);
    }
  });

  /**
   * Execute a confirmed destructive storage op against the bridge and surface
   * the result. Shared by the confirm route. The bridge (and the host script
   * behind it) is the real executor + last-line pre-flight; here we only
   * forward and translate the bridge's reply.
   */
  async function executeStorageOp(
    res: import("express").Response,
    service: StorageOp,
    resourceId: string,
    params: Record<string, unknown>,
  ) {
    // WARP-1337: pool_create may carry the owner's chosen displayName in its
    // confirm-token params. It is orchestrator-side seeding only — the host
    // script has no such parameter — so split it off before the bridge call.
    const { displayName, ...bridgeParams } = params as Record<string, unknown> & {
      displayName?: unknown;
    };
    try {
      const { ok, body } = await bridgePoolCommand(service, {
        ...bridgeParams,
        device: resourceId,
      });
      if (!ok) {
        // The host-script pre-flight refused (mounted / has-data / OS-disk /
        // bad confirm) — surface its message; it's owner-actionable.
        logger.warn({ service, resourceId, body }, "Storage op refused by host script");
        return res.status(422).json({
          ok: false,
          error: (body.error as string) || "The storage service refused this operation.",
        });
      }
      if (service === "pool_create" && typeof displayName === "string" && displayName.trim()) {
        // Seed the customer-facing name the moment the pool exists, keyed by
        // its md device — same row PATCH /storage/pools/:device upserts.
        // `level` was validated against VALID_LEVELS when the token was
        // minted; re-check before writing the enum column. The update branch
        // writes level too (code review): pool_delete leaves the row behind,
        // so recreating the same md device at a DIFFERENT RAID level lands
        // here — without the refresh the row keeps the deleted pool's stale
        // level. A failed seed must NOT fail the response: the pool WAS
        // created on the host, and the owner can still name it via the
        // rename flow.
        const level = bridgeParams.level;
        if (typeof level === "string" && VALID_LEVELS.has(level)) {
          try {
            await prisma.storagePool.upsert({
              where: { device: resourceId },
              create: {
                device: resourceId,
                displayName: displayName.trim(),
                level: level as $Enums.ArrayLevel,
              },
              update: {
                displayName: displayName.trim(),
                level: level as $Enums.ArrayLevel,
              },
            });
          } catch (err) {
            logger.warn(
              { err, device: resourceId },
              "Pool created but seeding its StoragePool displayName failed",
            );
          }
        }
      }
      return res.json({ ok: true, status: "ok", operation: service, device: resourceId, ...body });
    } catch (err) {
      if ((err as { code?: string }).code === "BRIDGE_AUTH_UNCONFIGURED") {
        return res.status(503).json({
          ok: false,
          error: "Storage management is unavailable — the device-bridge auth token is not configured.",
        });
      }
      if (isBridgeConnectionError(err)) {
        logger.warn({ err, service, resourceId }, "device-bridge not reachable for storage op");
        return res.status(503).json({
          ok: false,
          reason: "bridge_unavailable",
          error: "The storage service isn't reachable right now.",
        });
      }
      logger.warn({ err, service, resourceId }, "Failed to run storage op");
      return res.status(502).json({ ok: false, error: (err as Error).message || "bridge unreachable" });
    }
  }

  /**
   * POST /api/storage/command/confirm — confirm + execute a destructive
   * storage op. Owner/admin only (confirming EXECUTES, so it carries the same
   * guard as the routes that mint the token — mirrors switch.ts WARP-559).
   *
   * The caller MUST echo {service, resourceId}; a mismatch or an
   * unknown/expired token is refused and never reaches the bridge.
   */
  router.post(
    "/storage/command/confirm",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const { confirmationToken, service, resourceId } = req.body || {};
        if (!confirmationToken) {
          return res.status(400).json({ error: "Missing confirmationToken" });
        }
        const result = await confirmStorageCommand(prisma, confirmationToken, req.user?.id, {
          service,
          resourceId,
        });
        if (!result.confirmed) {
          return res.status(400).json({ error: result.reason, code: result.code });
        }
        return executeStorageOp(
          res,
          result.service as StorageOp,
          result.resourceId,
          (result.params as Record<string, unknown>) || {},
        );
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Destructive routes: each EVALUATES (mints a confirm token), never
  //    executes directly. Owner/admin only. The AI never reaches these
  //    (and the ops aren't in tools-core at all). ──

  /** md device name must look like md<N> — never a host-specific default. */
  function validMdDevice(d: unknown): d is string {
    return typeof d === "string" && /^md\d{1,3}$/.test(d);
  }
  /** Member block-device path allow-list. WARP-857 defense-in-depth: a pool
   *  member must be a WHOLE-disk kernel node (never a partition, never md<N>),
   *  mirroring validAdoptDevice's shape prefixed with /dev/. The host script
   *  wipes whole disks and its managed teardown releases every child partition
   *  via the kernel topology, so a partition member (e.g. /dev/sda1) would
   *  under-deliver the whole-disk erase the confirm phrase promises — reject it
   *  at the edge rather than half-erase. Also blocks shell metacharacters. */
  function validMember(m: unknown): m is string {
    return typeof m === "string" &&
      /^\/dev\/(sd[a-z]{1,2}|nvme\d+n\d+|mmcblk\d+|vd[a-z]{1,2})$/.test(m);
  }
  const VALID_LEVELS = new Set(["raid0", "raid1", "raid5", "raid6", "raid10", "jbod"]);
  // WARP-662 drive_adopt: a WHOLE-disk kernel name (never a partition, never
  // md<N>). The host script + bridge add the OS-disk refusal; this is just a
  // shape/allow-list guard against shell-metacharacter injection.
  function validAdoptDevice(d: unknown): d is string {
    return typeof d === "string" &&
      /^(sd[a-z]{1,2}|nvme\d+n\d+|mmcblk\d+|vd[a-z]{1,2})$/.test(d);
  }
  const VALID_FSTYPES = new Set(["ext4", "xfs", "btrfs"]);
  const VALID_WIPE = new Set(["quick", "secure"]);

  function evalAndRespond(
    res: import("express").Response,
    prismaArg: PrismaClient,
    service: StorageOp,
    resourceId: string,
    params: Record<string, unknown>,
    userId?: string,
  ) {
    return evaluateStorageCommand(prismaArg, service, resourceId, params, userId, "api").then(
      (result) => {
        // `requiresConfirmation` is the positive discriminant on the union;
        // anything else is the blocked branch (e.g. too many pending).
        if (!("requiresConfirmation" in result)) {
          return res.status(403).json({ error: result.reason, tier: result.tier, blocked: true });
        }
        // Tier 3 via dashboard → 202 + token. Caller confirms to execute.
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          service,
          resourceId,
          tier: result.tier,
          expiresIn: 60,
        });
      },
    );
  }

  // POST /api/storage/pools — create a pool (DESTRUCTIVE).
  router.post("/storage/pools", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      // WARP-1337: zod-validate the optional displayName FIRST — before the
      // evaluate step below reaches prisma (pre-DB static gate: prisma calls
      // only after zod parsing).
      const parsedName = createPoolNameSchema.safeParse(req.body ?? {});
      if (!parsedName.success) {
        return res.status(400).json({
          error: "Invalid displayName",
          details: parsedName.error.flatten(),
        });
      }
      const { displayName } = parsedName.data;
      const { device, level, members, confirmPhrase } = req.body || {};
      if (!validMdDevice(device)) {
        return res.status(400).json({ error: "Invalid pool device (expected md<N>)" });
      }
      if (typeof level !== "string" || !VALID_LEVELS.has(level)) {
        return res.status(400).json({ error: "Invalid RAID level" });
      }
      if (!Array.isArray(members) || members.length < 1 || !members.every(validMember)) {
        return res.status(400).json({ error: "Invalid members — expected whole-disk /dev/* paths" });
      }
      // WARP-857 defense-in-depth: every member must be a DISTINCT physical
      // disk. Members are validated as whole-disk nodes above, so a disk is its
      // own parent — uniqueness of the device names is uniqueness of parent
      // disks. Reject a repeated disk before it reaches the destructive host
      // script (which would otherwise wipe + add the same spindle twice).
      if (new Set(members).size !== members.length) {
        return res.status(400).json({ error: "Invalid members — each must be a distinct whole disk" });
      }
      return evalAndRespond(
        res,
        prisma,
        "pool_create",
        device,
        {
          level,
          members,
          confirm_phrase: confirmPhrase ?? "",
          // WARP-1337: carried through the confirm token for the post-create
          // StoragePool seed; stripped before the bridge call (executeStorageOp).
          ...(displayName ? { displayName } : {}),
        },
        req.user?.id,
      );
    } catch (err) {
      next(err);
    }
  });

  // POST /api/storage/drives/adopt — wipe + reformat + mount a previously-used
  // disk into the Droplet (DESTRUCTIVE, WARP-662). Owner/admin only; mints a
  // confirm token. The OS/boot disk is refused server-side by the host script —
  // this route never trusts the client's device choice for that guard.
  router.post("/storage/drives/adopt", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { device, fstype, wipeMethod, label, confirmPhrase } = req.body || {};
      if (!validAdoptDevice(device)) {
        return res.status(400).json({
          error: "Invalid drive (expected a whole-disk name like sdb or nvme0n1)",
        });
      }
      const fs = typeof fstype === "string" && fstype ? fstype : "ext4";
      if (!VALID_FSTYPES.has(fs)) {
        return res.status(400).json({ error: "Invalid filesystem type" });
      }
      const wipe = typeof wipeMethod === "string" && wipeMethod ? wipeMethod : "quick";
      if (!VALID_WIPE.has(wipe)) {
        return res.status(400).json({ error: "Invalid wipe method (expected quick or secure)" });
      }
      if (label != null && !/^[A-Za-z0-9_-]{1,16}$/.test(String(label))) {
        return res.status(400).json({ error: "Invalid label (1-16 chars: letters, digits, _ or -)" });
      }
      return evalAndRespond(
        res,
        prisma,
        "drive_adopt",
        device,
        {
          fstype: fs,
          wipe_method: wipe,
          ...(label != null ? { label: String(label) } : {}),
          confirm_phrase: confirmPhrase ?? "",
        },
        req.user?.id,
      );
    } catch (err) {
      next(err);
    }
  });

  // POST /api/storage/drives/reclaim — reclaim a pool-MEMBER disk into
  // standalone use (DESTRUCTIVE, WARP-1048). The disk is held by an md array,
  // so a plain drive_adopt would EBUSY on wipefs; reclaim carries the owning
  // `md` so the host script detaches it (mdadm --fail/--remove +
  // --zero-superblock) BEFORE the wipe+reformat+mount adopt flow. Owner/admin
  // only; mints a confirm token. The OS disk is refused server-side by the
  // host script — this route never trusts the client's device choice for that
  // guard. `md` must look like md<N>; the disk must be a whole-disk name.
  router.post("/storage/drives/reclaim", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { device, md, fstype, wipeMethod, label, confirmPhrase } = req.body || {};
      if (!validAdoptDevice(device)) {
        return res.status(400).json({
          error: "Invalid drive (expected a whole-disk name like sda or nvme0n1)",
        });
      }
      // `md` is the array the disk currently belongs to — the bare md<N> name
      // (never /dev/-prefixed, never a partition, never shell-injectable).
      // Reuse the same shape gate the pool routes apply to their device.
      if (!validMdDevice(md)) {
        return res.status(400).json({ error: "Invalid pool array (expected md<N>)" });
      }
      const fs = typeof fstype === "string" && fstype ? fstype : "ext4";
      if (!VALID_FSTYPES.has(fs)) {
        return res.status(400).json({ error: "Invalid filesystem type" });
      }
      const wipe = typeof wipeMethod === "string" && wipeMethod ? wipeMethod : "quick";
      if (!VALID_WIPE.has(wipe)) {
        return res.status(400).json({ error: "Invalid wipe method (expected quick or secure)" });
      }
      if (label != null && !/^[A-Za-z0-9_-]{1,16}$/.test(String(label))) {
        return res.status(400).json({ error: "Invalid label (1-16 chars: letters, digits, _ or -)" });
      }
      return evalAndRespond(
        res,
        prisma,
        "drive_reclaim",
        device,
        {
          md,
          fstype: fs,
          wipe_method: wipe,
          ...(label != null ? { label: String(label) } : {}),
          confirm_phrase: confirmPhrase ?? "",
        },
        req.user?.id,
      );
    } catch (err) {
      next(err);
    }
  });

  // DELETE /api/storage/pools/:device — destroy a pool (DESTRUCTIVE).
  router.delete("/storage/pools/:device", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { device } = req.params;
      if (!validMdDevice(device)) {
        return res.status(400).json({ error: "Invalid pool device" });
      }
      return evalAndRespond(
        res,
        prisma,
        "pool_destroy",
        device,
        { confirm_phrase: req.body?.confirmPhrase ?? "" },
        req.user?.id,
      );
    } catch (err) {
      next(err);
    }
  });

  // POST /api/storage/pools/:device/format — format the array (DESTRUCTIVE).
  router.post("/storage/pools/:device/format", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { device } = req.params;
      if (!validMdDevice(device)) {
        return res.status(400).json({ error: "Invalid pool device" });
      }
      // WARP-1338 review: same pinned allow-list as adopt/reclaim. The old
      // shape-only regex admitted fstypes whose mkfs doesn't take -L (vfat
      // uses -n), and the host's pool_format now unconditionally runs
      // `mkfs.$FSTYPE -L pool` — a loose fstype would fail the op there.
      const fstype = req.body?.fstype;
      if (fstype !== undefined && !VALID_FSTYPES.has(String(fstype))) {
        return res.status(400).json({ error: "Invalid fstype" });
      }
      return evalAndRespond(
        res,
        prisma,
        "pool_format",
        device,
        { fstype, confirm_phrase: req.body?.confirmPhrase ?? "" },
        req.user?.id,
      );
    } catch (err) {
      next(err);
    }
  });

  // POST /api/storage/pools/:device/level — change RAID level (DESTRUCTIVE).
  router.post("/storage/pools/:device/level", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { device } = req.params;
      const { level } = req.body || {};
      if (!validMdDevice(device)) {
        return res.status(400).json({ error: "Invalid pool device" });
      }
      if (typeof level !== "string" || !VALID_LEVELS.has(level)) {
        return res.status(400).json({ error: "Invalid RAID level" });
      }
      return evalAndRespond(
        res,
        prisma,
        "pool_set_level",
        device,
        { level, confirm_phrase: req.body?.confirmPhrase ?? "" },
        req.user?.id,
      );
    } catch (err) {
      next(err);
    }
  });

  // POST /api/storage/pools/:device/spare — add a spare disk (DESTRUCTIVE — wipes the new disk).
  router.post("/storage/pools/:device/spare", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { device } = req.params;
      const { member } = req.body || {};
      if (!validMdDevice(device)) {
        return res.status(400).json({ error: "Invalid pool device" });
      }
      if (!validMember(member)) {
        return res.status(400).json({ error: "Invalid member device" });
      }
      return evalAndRespond(
        res,
        prisma,
        "pool_add_spare",
        device,
        { member, confirm_phrase: req.body?.confirmPhrase ?? "" },
        req.user?.id,
      );
    } catch (err) {
      next(err);
    }
  });

  // POST /api/storage/pools/:device/remove-disk — fail+remove a member (DESTRUCTIVE).
  router.post("/storage/pools/:device/remove-disk", requireRole("owner", "admin"), async (req, res, next) => {
    try {
      const { device } = req.params;
      const { member } = req.body || {};
      if (!validMdDevice(device)) {
        return res.status(400).json({ error: "Invalid pool device" });
      }
      if (!validMember(member)) {
        return res.status(400).json({ error: "Invalid member device" });
      }
      return evalAndRespond(
        res,
        prisma,
        "pool_remove_disk",
        device,
        { member, confirm_phrase: req.body?.confirmPhrase ?? "" },
        req.user?.id,
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
