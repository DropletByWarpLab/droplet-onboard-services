"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  HardDrive,
  Usb,
  MemoryStick,
  RefreshCw,
  Layers,
  AlertTriangle,
  Loader2,
  Pencil,
  Check,
  X,
  FolderOpen,
  Cpu,
} from "lucide-react";
import { useDrives } from "@/lib/hooks/useDrives";
import { usePools } from "@/lib/hooks/usePools";
import {
  adoptDrive,
  confirmStorageCommand,
  ejectDrive,
  reclaimDrive,
  requestFormatPool,
  rescanDrives,
  updateDriveLabel,
  updatePoolLabel,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/Toast";
import { Meter, Badge, type BadgeKind } from "@/components/shell/primitives";
import { ConfirmDialog } from "@/components/ConfirmDialog";
// WARP-1915: typed-name friction for the reclaim wipe — the same
// DestructiveConfirm the Settings Danger zone puts in front of a reformat.
// One primitive for every type-to-confirm destructive flow, never a fork.
import { DestructiveConfirm } from "@/components/settings/DestructiveConfirm";
import { translateError } from "@/lib/friendly-errors";
import type {
  DataStorageTotals,
  DiskInfo,
  DriveInfo,
  PoolInfo,
  SystemDiskInfo,
} from "@/lib/types";
// Shared destructive-flow helpers (same ones the Settings Danger zone reuses):
// the host script's typed-phrase gate + the calm adopt-refusal copy.
import {
  buildConfirmPhrase,
  friendlyAdoptError,
  wholeDiskName,
} from "@/components/setup/steps/StorageStep";
import {
  levelLabel,
  levelBlurb,
  poolStatusBadge,
  reclaimPoolImpact,
  worstPoolAlarm,
} from "./pool-display";
// WARP-1337: the display-name chain (override → displayName → label →
// GUID-guarded mount tail) lives in ONE shared helper now, used by this panel
// and VolumesPanel alike — the private per-panel copies drifted (VolumesPanel's
// never consulted displayName and rendered raw fs-UUID tails).
import {
  driveContentsHref,
  driveDisplayName,
  drivePoolName,
  isPoolBackedDevice,
  poolBackingDrive,
  sanitizeFsLabel,
  takenVolumeNames,
  uniqueFsLabel,
  usagePctOf,
} from "./drive-display";

// Binary units, matching the rest of the dashboard (VolumesPanel etc.).
function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Customer-facing name: friendly displayName, then FS label, then the
// GUID-guarded mount tail — never the raw device path or a machine id, since
// the target user is non-technical. `override` lets the card show an
// optimistic just-typed name before the hook's data refetches.
function driveName(d: DriveInfo, override?: string | null): string {
  return driveDisplayName(d, { override, poolBacked: isPoolBackedDevice(d.device) });
}

// Customer-facing pool name: the owner's displayName, else a generic label —
// never the raw md device path (ADR-002 home-user persona; follow-up to WARP-827
// which gave DriveCard the same treatment).
function poolName(pool: PoolInfo): string {
  const raw = (pool.displayName || "").replace(/[-_]+/g, " ").trim();
  if (!raw) return "Storage pool";
  return raw.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

// WARP-1338: driveContentsHref moved to the shared drive-display helper —
// VolumesPanel tiles deep-link to the same target now, and a private copy
// here would let the two surfaces drift.

// Customer-chosen drive names are 1–64 chars, trimmed, non-empty — mirrors the
// orchestrator's updateDriveSchema (z.string().trim().min(1).max(64)).
const DRIVE_NAME_MAX = 64;


function usagePct(d: DriveInfo): number {
  return usagePctOf(d.used_bytes, d.size_bytes);
}

// Design Storage meter: amber past 80%, red past 95% (matches VolumesPanel).
function meterKind(p: number): "" | "warn" | "danger" {
  if (p > 95) return "danger";
  if (p > 80) return "warn";
  return "";
}

type Status = { label: string; kind: BadgeKind };
function statusOf(d: DriveInfo): Status {
  if (!d.mounted) return { label: "Offline", kind: "danger" };
  if (d.readonly) return { label: "Read-only", kind: "muted" };
  if (usagePct(d) > 90) return { label: "Nearly full", kind: "warn" };
  return { label: "Mounted", kind: "ok" };
}

// Map a pool's health to a design `.badge` variant. The plain-language label
// still comes from `poolStatusBadge()`; the colour idiom lives entirely in
// the indigo Badge (WARP-1091 removed pool-display's unused `cls` field).
function poolBadgeKind(status: PoolInfo["status"]): BadgeKind {
  switch (status) {
    case "active":
      return "ok";
    case "resyncing":
      return "info";
    case "degraded":
      return "warn";
    case "failed":
      return "danger";
    default:
      return "muted";
  }
}

function BusIcon({ bus, className }: { bus?: string; className?: string }) {
  if (bus === "usb") return <Usb className={className} />;
  if (bus === "mmc") return <MemoryStick className={className} />;
  return <HardDrive className={className} />; // nvme + generic disk
}

// Small bordered hardware token (bus / filesystem / temperature). Mirrors the
// indigo input chrome: 1px --border, --radius-input, muted mono-ish label.
function HwTag({ children, upper = true }: { children: ReactNode; upper?: boolean }) {
  return (
    <span
      className={`flex-none inline-flex items-center ${upper ? "uppercase tracking-wide" : ""} tabular-nums`}
      style={{
        fontSize: "10.5px",
        fontWeight: 600,
        padding: "1px 6px",
        borderRadius: "var(--radius-input)",
        border: "1px solid var(--card-bd)",
        color: "var(--text-muted)",
      }}
    >
      {children}
    </span>
  );
}

// Icon tile for the leading square on drive / disk rows — the design's
// `.lrow .ri` treatment (neutral inner surface, muted glyph).
function IconTile({ children }: { children: ReactNode }) {
  return (
    <span
      className="flex-none h-10 w-10 flex items-center justify-center"
      style={{
        borderRadius: "10px",
        background: "var(--card-inner)",
        color: "var(--text-muted)",
      }}
    >
      {children}
    </span>
  );
}

function busLabel(bus?: string): string {
  switch (bus) {
    case "nvme":
      return "NVMe";
    case "usb":
      return "USB";
    case "sata":
      return "SATA";
    case "sas":
      return "SAS";
    case "scsi":
      return "SCSI";
    case "mmc":
      return "SD / eMMC";
    default:
      return "Disk";
  }
}

export function DrivesPanel() {
  const { drives, disks, totals, systemDisk, isLoading, bridgeError, refresh } =
    useDrives();
  // BUG-3 / ADR-019: real mdadm pools replace the old client-side byte-sum
  // "pooled storage" fiction. Pools are OPTIONAL — `pools` is [] when none.
  const { pools, refresh: refreshPools } = usePools();
  const { toast } = useToast();
  // WARP-827: renaming a drive writes a device-wide label (PATCH is admin-only
  // server-side); gate the edit affordance on the same roles so non-admins
  // don't see a control that would 403. Mirrors isAdmin() in storage.ts.
  const { user } = useAuth();
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const [rescanning, setRescanning] = useState(false);
  const [ejectTarget, setEjectTarget] = useState<DriveInfo | null>(null);
  const [ejecting, setEjecting] = useState<string | null>(null);

  // WARP-936 — erase & adopt an unmounted disk. Two-step: mint a confirm
  // token (nothing destructive happens), then the owner confirms in the
  // blast-radius dialog to execute. Same gated flow the setup wizard and the
  // Settings Danger zone use — one wire path, one contract.
  const [adoptPending, setAdoptPending] = useState<{
    token: { confirmationToken: string; service: string; resourceId: string };
    disk: DiskInfo;
  } | null>(null);
  const [adoptBusy, setAdoptBusy] = useState<string | null>(null);

  // WARP-936 — format & mount a created-but-never-formatted pool (the live
  // box's md127 shape). Same two-step confirm-token flow via pool_format.
  const [formatPending, setFormatPending] = useState<{
    token: { confirmationToken: string; service: string; resourceId: string };
    pool: PoolInfo;
  } | null>(null);
  const [formatBusy, setFormatBusy] = useState<string | null>(null);

  // WARP-1048 — reclaim a pool-MEMBER disk into standalone use: break it out of
  // its md array, then adopt it. Same two-step confirm-token flow as adopt; the
  // disk carries its owning `md` so the host script detaches it first.
  const [reclaimPending, setReclaimPending] = useState<{
    token: { confirmationToken: string; service: string; resourceId: string };
    disk: DiskInfo;
  } | null>(null);
  const [reclaimBusy, setReclaimBusy] = useState<string | null>(null);

  // Focus restore for the destructive confirms (WCAG 2.4.3, UX review). The
  // row CTA is DISABLED while the confirm-token request is in flight, which
  // drops browser focus to <body> before the dialog opens — so the Dialog
  // primitive's capture-at-open fallback records <body>, not the button.
  // Capture the trigger explicitly at click time instead (only one of these
  // dialogs can be open at once, so a single shared ref is enough).
  const destructiveTriggerRef = useRef<HTMLElement | null>(null);

  // Disks worth surfacing in "Available drives": everything the bridge
  // reports that is NOT already in use (in-use disks are the mounted drive
  // cards below — listing them twice would be confusing, not honest).
  const availableDisks = (disks ?? []).filter((d) => d.state !== "in_use");

  // A pool whose md device backs no mounted filesystem was created but never
  // formatted+mounted (or lost its mount) — offer the owner a way forward
  // instead of a dead-end card. Count a mount of the md node itself OR of one
  // of its partitions (md127p1) as "backed" (UX review: an exact-node check
  // re-offered the erase CTA forever for a partitioned pool). Anchored match,
  // so /dev/md127p1 never counts as a mount of md12.
  const poolHasMountedFs = (pool: PoolInfo) => {
    const re = new RegExp(`^/dev/${pool.device}(p\\d+)?$`);
    return drives.some((d) => re.test(d.device));
  };

  // WARP-1339 — ONE pooled entry instead of pool card + anonymous GUID drive
  // tile. The mounted md filesystem is merged INTO its pool's card (it is the
  // pool's only fs-level capacity/browse source — ADR-019 real usable
  // capacity, never a fabricated raw-member sum) and excluded from the drives
  // grid below. The join key is the orchestrator's `pool` annotation (bare
  // array name), with the anchored md-device matcher as the older-orchestrator
  // fallback (drivePoolName). Only drives whose DEVICE is the md node are
  // hidden — a dropped member disk lives in `disks` (state pool_member) and
  // keeps its Available-drives card + Reclaim action untouched. When the pools
  // payload lacks the matching pool (degraded /storage/pools fetch), the md
  // drive stays in the grid: hiding it with no pool card to merge into would
  // lose the volume entirely.
  const standaloneDrives = drives.filter((d) => {
    const md = drivePoolName(d);
    return !md || !pools.some((p) => p.device === md);
  });

  // Code review (WARP-1337): the collision snapshot for a seeded FS label —
  // every mounted volume's label/tail EXCEPT those on the target disk itself,
  // which the wipe is about to erase (their names can't collide with the new
  // mount). Same member derivation as StorageStep's reclaimDisks and the
  // Danger zone's reformat, so all three destructive flows agree.
  function takenNamesExcluding(disk: DiskInfo): string[] {
    return takenVolumeNames(
      drives.filter((d) => (d.parent_disk || wholeDiskName(d.device)) !== disk.name),
    );
  }

  async function handleStartAdopt(disk: DiskInfo) {
    if (disk.state !== "foreign" && disk.state !== "available") return;
    destructiveTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setAdoptBusy(disk.name);
    try {
      // WARP-1337: seed the post-wipe FS label from the name the card shows
      // (the hardware model — an unmounted disk has no customer-typed name
      // yet). The label becomes the mount tail, so the adopted drive never
      // lands back on a GUID mount. Omitted when the bridge has no model.
      // Code review: uniquified against the OTHER mounted volumes' labels/
      // tails — the host script's raw mount would stack an identical label
      // over the existing mount (2× the same model is the realistic trigger);
      // the serial tail disambiguates.
      const label = uniqueFsLabel(
        sanitizeFsLabel(disk.model),
        takenNamesExcluding(disk),
        disk.serial,
      );
      const token = await adoptDrive({
        device: disk.name,
        wipeMethod: "quick",
        ...(label ? { label } : {}),
        confirmPhrase: buildConfirmPhrase([disk.name]),
      });
      setAdoptPending({
        token: {
          confirmationToken: token.confirmationToken,
          service: token.service,
          resourceId: token.resourceId,
        },
        disk,
      });
    } catch (err) {
      toast(friendlyAdoptError(err), "error");
    } finally {
      setAdoptBusy(null);
    }
  }

  async function doAdopt() {
    const p = adoptPending;
    if (!p) return;
    try {
      await confirmStorageCommand(p.token);
      setAdoptPending(null);
      toast(`${diskTitle(p.disk)} erased and added to your Droplet`, "success");
      refresh();
      refreshPools();
    } catch (err) {
      setAdoptPending(null);
      toast(friendlyAdoptError(err), "error");
    }
  }

  async function handleStartFormat(pool: PoolInfo) {
    destructiveTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFormatBusy(pool.device);
    try {
      const token = await requestFormatPool(pool.device, {
        confirmPhrase: buildConfirmPhrase([pool.device]),
      });
      setFormatPending({
        token: {
          confirmationToken: token.confirmationToken,
          service: token.service,
          resourceId: token.resourceId,
        },
        pool,
      });
    } catch (err) {
      toast(translateError(err, "files"), "error");
    } finally {
      setFormatBusy(null);
    }
  }

  async function doFormat() {
    const p = formatPending;
    if (!p) return;
    try {
      await confirmStorageCommand(p.token);
      setFormatPending(null);
      // Honest outcome copy (UX review): pool_format really does mount now —
      // the host script mkfs-then-host_mounts under /mnt/droplet.
      toast(`${poolName(p.pool)} formatted and mounted — ready to use`, "success");
      refresh();
      refreshPools();
    } catch (err) {
      setFormatPending(null);
      toast(translateError(err, "files"), "error");
    }
  }

  async function handleStartReclaim(disk: DiskInfo) {
    if (disk.state !== "pool_member" || !disk.md) return;
    destructiveTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReclaimBusy(disk.name);
    try {
      // WARP-1337: same FS-label seeding as adopt — the reclaimed drive comes
      // back named instead of GUID-mounted — with the same shadow-mount
      // collision guard and own-volume exclusion (code review). The pool's
      // OWN mounted fs still counts: its device is the md node, whose parent
      // is never this member disk, so it stays in the taken set (reclaiming
      // one member leaves the array's mount alive).
      const label = uniqueFsLabel(
        sanitizeFsLabel(disk.model),
        takenNamesExcluding(disk),
        disk.serial,
      );
      const token = await reclaimDrive({
        device: disk.name,
        md: disk.md,
        wipeMethod: "quick",
        ...(label ? { label } : {}),
        confirmPhrase: buildConfirmPhrase([disk.name]),
      });
      setReclaimPending({
        token: {
          confirmationToken: token.confirmationToken,
          service: token.service,
          resourceId: token.resourceId,
        },
        disk,
      });
    } catch (err) {
      toast(friendlyAdoptError(err), "error");
    } finally {
      setReclaimBusy(null);
    }
  }

  async function doReclaim() {
    const p = reclaimPending;
    if (!p) return;
    try {
      await confirmStorageCommand(p.token);
      setReclaimPending(null);
      toast(`${diskTitle(p.disk)} reclaimed and added to your Droplet`, "success");
      refresh();
      refreshPools();
    } catch (err) {
      setReclaimPending(null);
      toast(friendlyAdoptError(err), "error");
    }
  }

  async function onRescan() {
    setRescanning(true);
    try {
      await rescanDrives();
      // SWR refetches on the 30s interval; nudge an immediate refresh by
      // toasting success — the next poll picks up new/removed drives.
      refresh();
      refreshPools();
      toast("Rescanning drives — the list refreshes shortly", "success");
    } catch (err) {
      toast(translateError(err, "files"), "error");
    } finally {
      setRescanning(false);
    }
  }

  async function doEject() {
    const d = ejectTarget;
    if (!d) return;
    setEjecting(d.uuid);
    try {
      await ejectDrive(d.uuid);
      setEjectTarget(null);
      toast(`${driveName(d)} ejected — safe to unplug`, "success");
      refresh();
    } catch (err) {
      toast(translateError(err, "files"), "error");
      throw err;
    } finally {
      setEjecting(null);
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4">
        <div
          className="card h-28 animate-pulse"
          style={{ background: "var(--inset)" }}
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="card h-44 animate-pulse"
              style={{ background: "var(--inset)" }}
            />
          ))}
        </div>
      </div>
    );
  }

  // The storage service being unreachable is the ONLY whole-panel dead end —
  // we can't honestly render pools or disks either. WARP-936: an empty
  // MOUNTED list is no longer an early return; the box may still have a pool
  // (the live md127 case) or present-but-unmounted disks to show below.
  if (bridgeError) {
    return (
      <div className="card" style={{ padding: 0 }}>
        <div className="empty">
          <span className="ei">
            <HardDrive size={24} />
          </span>
          <p className="eh">Storage is unavailable</p>
          <p style={{ fontSize: "13px" }}>
            The storage service isn&rsquo;t reachable right now.
          </p>
          <button
            onClick={onRescan}
            disabled={rescanning}
            className="btn"
            style={{ marginTop: "6px" }}
          >
            <RefreshCw size={15} className={rescanning ? "animate-spin" : ""} />
            Rescan
          </button>
        </div>
      </div>
    );
  }

  const alarm = worstPoolAlarm(pools);

  return (
    <div className="flex flex-col gap-5">
      {/* Degraded / rebuild banner — only when a real pool needs attention. */}
      {alarm && <PoolAlarmBanner alarm={alarm} pools={pools} />}

      {/* Header: section title + Rescan. */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 style={{ fontSize: "17px", fontWeight: 600, color: "var(--text)" }}>
            Storage
          </h2>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
            Mount base{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>/mnt/droplet/</span>
          </p>
        </div>
        {/* WARP-2098 — the one box-level storage figure, and the wording is
            load-bearing. It is "across your drives", never "pooled": ADR-019
            deleted a client-side byte-sum labelled "Total pooled storage"
            because it described no disk that existed, and this number is a sum
            too. What makes it honest is its INPUT — the server's post-filter
            data-drive list, which excludes the system disk and counts a pool
            as its one mounted filesystem rather than its raw members. Absent
            totals render nothing at all rather than 0 B. */}
        {totals && (
          <DataStorageHeadline totals={totals} />
        )}
        <button
          onClick={onRescan}
          disabled={rescanning}
          className="btn ghost sm"
          aria-label="Rescan drives"
        >
          <RefreshCw size={15} className={rescanning ? "animate-spin" : ""} />
          Rescan
        </button>
      </div>

      {/* Storage pools (mdadm software RAID). Pools are OPTIONAL — when none
          exists we say so honestly rather than fabricating a pooled sum. */}
      <section aria-label="Storage pools">
        {pools.length === 0 ? (
          <div className="card flex items-start gap-3">
            <span
              className="flex-none h-10 w-10 flex items-center justify-center"
              style={{
                borderRadius: "10px",
                background: "var(--card-inner)",
                color: "var(--text-muted)",
              }}
            >
              <Layers className="h-5 w-5" />
            </span>
            <div>
              <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--text)" }}>
                No storage pool configured
              </p>
              <p
                style={{
                  fontSize: "13px",
                  color: "var(--text-muted)",
                  marginTop: "2px",
                }}
              >
                Your drives work on their own. A pool combines drives for more
                space or redundancy — optional, and you can set one up anytime.
              </p>
            </div>
          </div>
        ) : (
          <div
            className="grid grid-cols-1 gap-4"
            role="list"
            aria-label="Storage pools"
          >
            {pools.map((p) => (
              <PoolCard
                key={p.device}
                pool={p}
                isAdmin={isAdmin}
                // WARP-1339: the mounted md filesystem backing this pool —
                // its real used/size/free meter + browse link render on the
                // pool card itself (one pooled entry).
                backingDrive={poolBackingDrive(p.device, drives)}
                // WARP-936: a pool whose md device backs no mounted filesystem
                // was created but never formatted+mounted — give the owner the
                // gated way forward. Failed pools get support copy, not a
                // format button.
                canFormat={
                  isAdmin && p.status !== "failed" && !poolHasMountedFs(p)
                }
                formatting={formatBusy === p.device}
                onFormat={() => handleStartFormat(p)}
                onRenamed={() => refreshPools()}
              />
            ))}
          </div>
        )}
      </section>

      {/* Per-drive cards */}
      <div>
        <h3
          className="uppercase tracking-wide mb-2"
          style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-muted)" }}
        >
          Drives
        </h3>
        {standaloneDrives.length === 0 ? (
          <div className="card flex items-start gap-3">
            <span
              className="flex-none h-10 w-10 flex items-center justify-center"
              style={{
                borderRadius: "10px",
                background: "var(--card-inner)",
                color: "var(--text-muted)",
              }}
            >
              <HardDrive className="h-5 w-5" />
            </span>
            <div>
              <p style={{ fontSize: "14px", fontWeight: 600, color: "var(--text)" }}>
                No drives yet
              </p>
              <p
                style={{
                  fontSize: "13px",
                  color: "var(--text-muted)",
                  marginTop: "2px",
                }}
              >
                Plug in a drive and it mounts automatically.
              </p>
            </div>
          </div>
        ) : (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-4"
            role="list"
            aria-label="Mounted drives"
          >
            {standaloneDrives.map((d) => (
              <DriveCard
                key={d.uuid || d.mount || d.device}
                drive={d}
                isAdmin={isAdmin}
                ejecting={ejecting === d.uuid}
                onEject={() => setEjectTarget(d)}
                onRenamed={() => refresh()}
              />
            ))}
          </div>
        )}
      </div>

      {/* WARP-2098 — the Droplet's own install disk, in its OWN section below
          the owner's drives. Placement is the point: it comes after the data
          drives because it is context, not capacity the owner can use, and it
          is a section of its own so it can never be mistaken for a pool member
          or a drive with actions. Rendered only when the bridge reports it, so
          an older bridge simply shows nothing here. */}
      {systemDisk && (
        <div>
          <h3
            className="uppercase tracking-wide mb-2"
            style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-muted)" }}
          >
            System drive
          </h3>
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-4"
            role="list"
            aria-label="System drive"
          >
            <SystemDriveCard system={systemDisk} />
          </div>
        </div>
      )}

      {/* WARP-936 — present-but-unmounted disks. Read-only inventory with an
          explicit per-state path forward; nothing here auto-mounts or
          auto-wipes, and every destructive action goes through the tier-3
          confirm-token + blast-radius dialog. */}
      {availableDisks.length > 0 && (
        <div>
          <h3
            className="uppercase tracking-wide mb-2"
            style={{ fontSize: "11px", fontWeight: 600, color: "var(--text-muted)" }}
          >
            Available drives
          </h3>
          <div
            className="grid grid-cols-1 sm:grid-cols-2 gap-4"
            role="list"
            aria-label="Available drives"
          >
            {availableDisks.map((disk) => (
              <AvailableDiskCard
                key={disk.name}
                disk={disk}
                isAdmin={isAdmin}
                busy={
                  adoptBusy === disk.name || reclaimBusy === disk.name
                }
                onAdopt={() => handleStartAdopt(disk)}
                onReclaim={() => handleStartReclaim(disk)}
              />
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={ejectTarget !== null}
        onConfirm={doEject}
        onCancel={() => setEjectTarget(null)}
        title="Eject this drive?"
        description={`${ejectTarget ? driveName(ejectTarget) : "The drive"} will be unmounted. Wait for the confirmation before unplugging it.`}
        confirmLabel="Eject"
        variant="destructive"
      />

      {/* WARP-936 — erase & adopt blast-radius confirm. Names the disk +
          size so the owner verifies the target before anything runs. */}
      <ConfirmDialog
        open={adoptPending !== null}
        onConfirm={doAdopt}
        onCancel={() => setAdoptPending(null)}
        title="Erase and adopt this drive?"
        description="This permanently erases everything on the drive, then formats it and adds it to your Droplet. This can't be undone — make sure anything you want is backed up first."
        confirmLabel="Erase & adopt"
        confirmedIdentifier={
          adoptPending
            ? `${diskTitle(adoptPending.disk)} · ${fmtBytes(adoptPending.disk.size_bytes)} · ${adoptPending.disk.name}`
            : ""
        }
        variant="destructive"
        triggerRef={destructiveTriggerRef}
      />

      {/* WARP-936 — format & mount confirm for a never-formatted pool. */}
      <ConfirmDialog
        open={formatPending !== null}
        onConfirm={doFormat}
        onCancel={() => setFormatPending(null)}
        title="Format this storage pool?"
        description="This permanently erases anything on the pool and sets it up as storage for your Droplet. This can't be undone."
        confirmLabel="Format & mount"
        confirmedIdentifier={
          formatPending
            ? `${poolName(formatPending.pool)} · ${levelLabel(formatPending.pool.level)} · ${formatPending.pool.members.length} ${formatPending.pool.members.length === 1 ? "drive" : "drives"}`
            : ""
        }
        variant="destructive"
        triggerRef={destructiveTriggerRef}
      />

      {/* WARP-1048 / WARP-1915 — reclaim a pool-member disk: break it out of
          the pool, then erase + add it on its own. A wipe deserves more than a
          one-click confirmation (QA: the red Reclaim read as reversible), so this
          uses the Settings Danger zone's typed-name DestructiveConfirm: the
          owner types the drive's name to unlock the action, and the accessory
          line spells out the pool impact — a RAID 1 mirror loses the second
          copy of the files. Names the disk + size so the owner verifies the
          target. Success/error both close + toast in doReclaim (same contract
          as adopt/format — a failed confirm token is not retryable). */}
      <DestructiveConfirm
        open={reclaimPending !== null}
        onConfirm={doReclaim}
        onCancel={() => setReclaimPending(null)}
        title="Reclaim this drive from the pool?"
        consequence={
          reclaimPending
            ? `This removes ${diskTitle(reclaimPending.disk)} from your storage pool, permanently erases everything on it, and sets it up as a drive of its own. This can't be undone — back up anything you want to keep first.`
            : ""
        }
        affectedSummary={
          reclaimPending
            ? `${diskTitle(reclaimPending.disk)} · ${fmtBytes(reclaimPending.disk.size_bytes)} · ${reclaimPending.disk.name}`
            : ""
        }
        confirmPhrase={reclaimPending ? diskTitle(reclaimPending.disk) : ""}
        confirmLabel="Reclaim & erase"
        progressMessage="Reclaiming the drive — this can take a moment. Keep this open until it finishes."
        accessory={
          reclaimPending ? (
            <p className="type-footnote" style={{ color: "var(--text)" }}>
              {reclaimPoolImpact(
                pools.find((p) => p.device === reclaimPending.disk.md)?.level,
              )}
            </p>
          ) : undefined
        }
        triggerRef={destructiveTriggerRef}
      />
    </div>
  );
}

/** WARP-936 — customer-facing name for an unmounted disk: the hardware model
 *  when the bridge knows it, else a friendly generic. The raw /dev/ path is
 *  never rendered; the bare kernel name (sda) appears only as the small
 *  disambiguating token, mirroring the setup wizard's reclaim rows. */
function diskTitle(d: DiskInfo): string {
  const model = (d.model || "").replace(/[-_]+/g, " ").trim();
  return model || "Drive";
}

/**
 * WARP-2098 — the box-level storage headline.
 *
 * Deliberately compact and deliberately named: "used across your drives".
 * ADR-019 removed a client-side sum labelled "Total pooled storage" because a
 * sum of every mounted volume is not a pool's capacity, and
 * drives-panel.pools.test.tsx still asserts that phrase never returns. This is
 * a sum too — what makes it legitimate is that the server computed it over the
 * SAME filtered data-drive list it returned, so the system disk is excluded and
 * a pool contributes one mounted filesystem, not its member disks.
 */
function DataStorageHeadline({ totals }: { totals: DataStorageTotals }) {
  const p = usagePctOf(totals.used_bytes, totals.size_bytes);
  return (
    <div className="min-w-0" style={{ minWidth: "180px" }}>
      <div
        className="flex items-baseline gap-1.5 tabular-nums"
        style={{ fontSize: "13px", color: "var(--text-muted)" }}
      >
        <span style={{ color: "var(--text)", fontWeight: 600 }}>
          {fmtBytes(totals.used_bytes)}
        </span>
        <span>of {fmtBytes(totals.size_bytes)} used across your drives</span>
      </div>
      <div style={{ marginTop: "6px" }}>
        <Meter pct={p} kind={meterKind(p)} />
      </div>
    </div>
  );
}

/** WARP-2098 — plain-language label for one filesystem on the system disk.
 *  The role comes from the server so this is a lookup, not path-matching. */
function systemFsLabel(role: SystemDiskInfo["filesystems"][number]["role"]): string {
  if (role === "root") return "System software";
  if (role === "boot") return "Startup files";
  return "App data and files";
}

/**
 * WARP-2098 — the Droplet's OWN system disk, shown as its own card.
 *
 * Why it exists: WARP-827 hid the OS disk from every drive list, which was
 * right (those lists feed rename / eject / erase / pool pickers) but left the
 * owner unable to see the appliance's own disk at all. On this box that is the
 * disk that fills first — the docker data-root, and so Nextcloud's uploaded
 * files, live on it while the storage pool reaches Nextcloud only as external
 * storage — so "how full is the Droplet itself?" had no answer in the product.
 *
 * Why it is a separate component and not a DriveCard: it must carry NO
 * affordances. No Browse (it is not a Nextcloud mount, so a deep link would be
 * dead), no Rename (there is no Drive row, and there is no uuid to PATCH), no
 * Eject, and it can never reach adopt / reclaim / reformat. It takes
 * SystemDiskInfo, not DriveInfo, so it cannot be handed to anything that acts
 * on a drive.
 */
function SystemDriveCard({ system }: { system: SystemDiskInfo }) {
  // null means "identified the disk, could not measure it" — show the capacity
  // and say so, rather than a 0% meter that reads as a pristine empty disk.
  const measured = system.used_bytes !== null;
  const p = measured ? usagePctOf(system.used_bytes ?? 0, system.size_bytes) : 0;
  const model = (system.model || "").replace(/[-_]+/g, " ").trim();
  // Startup partitions are tiny and there can be two of them (/boot, /boot/efi);
  // fold them into one row so the breakdown reads as three lines, not four.
  const rows = [
    ...system.filesystems.filter((f) => f.role !== "boot"),
  ];
  const boot = system.filesystems.filter((f) => f.role === "boot");
  return (
    <div role="listitem" className="card">
      <div className="flex items-start gap-3">
        <IconTile>
          <Cpu className="h-5 w-5" />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4
              className="truncate"
              style={{ fontSize: "14px", fontWeight: 600, color: "var(--text)" }}
              title={model || "System drive"}
            >
              System drive
            </h4>
            {model && <HwTag upper={false}>{model}</HwTag>}
            {system.bus && <HwTag>{busLabel(system.bus)}</HwTag>}
          </div>
          <p
            className="tabular-nums"
            style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}
          >
            {fmtBytes(system.size_bytes)} ·{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>{system.name}</span>
          </p>
        </div>
        <Badge kind="muted">Not user storage</Badge>
      </div>

      {measured ? (
        <div className="mt-3">
          <Meter pct={p} kind={meterKind(p)} />
          <div
            className="flex items-center justify-between tabular-nums"
            style={{
              marginTop: "10px",
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              color: "var(--text-muted)",
            }}
          >
            <span style={{ color: "var(--text)" }}>
              {fmtBytes(system.used_bytes ?? 0)}
            </span>
            <span>of {fmtBytes(system.size_bytes)}</span>
          </div>
        </div>
      ) : (
        <p className="mt-3" style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          Usage unavailable.
        </p>
      )}

      {/* The breakdown is the useful part: it shows the owner that uploaded
          files land here, on the Droplet's own disk, rather than on the pool. */}
      {(rows.length > 0 || boot.length > 0) && (
        <ul
          className="mt-3 flex flex-col gap-1"
          style={{ fontSize: "12px", color: "var(--text-muted)" }}
        >
          {rows.map((f) => (
            <li key={f.mount} className="flex items-center justify-between gap-3">
              <span className="truncate">{systemFsLabel(f.role)}</span>
              <span className="tabular-nums flex-none" style={{ fontFamily: "var(--font-mono)" }}>
                {fmtBytes(f.used_bytes)} of {fmtBytes(f.size_bytes)}
              </span>
            </li>
          ))}
          {boot.length > 0 && (
            <li className="flex items-center justify-between gap-3">
              <span className="truncate">{systemFsLabel("boot")}</span>
              <span className="tabular-nums flex-none" style={{ fontFamily: "var(--font-mono)" }}>
                {fmtBytes(boot.reduce((n, f) => n + f.used_bytes, 0))} of{" "}
                {fmtBytes(boot.reduce((n, f) => n + f.size_bytes, 0))}
              </span>
            </li>
          )}
        </ul>
      )}

      <p className="mt-3" style={{ fontSize: "12px", color: "var(--text-muted)" }}>
        The Droplet&rsquo;s own disk. It isn&rsquo;t part of your storage pool
        and can&rsquo;t be renamed, ejected, or added to one.
      </p>
    </div>
  );
}

/** One available (unmounted) disk card. States:
 *    foreign / available — admin gets the gated "Erase & adopt" action
 *    pool_member         — admin gets the gated "Reclaim & erase" action
 *                          (WARP-1048, relabelled WARP-1915):
 *                          break it out of the pool, then adopt it. (Adopting a
 *                          member directly EBUSYs; reclaim detaches first.) */
function AvailableDiskCard({
  disk,
  isAdmin,
  busy,
  onAdopt,
  onReclaim,
}: {
  disk: DiskInfo;
  isAdmin: boolean;
  busy: boolean;
  onAdopt: () => void;
  onReclaim: () => void;
}) {
  const adoptable = disk.state === "foreign" || disk.state === "available";
  // WARP-1048: a pool member is reclaimable only when we know which array to
  // break it out of (the bridge names it). Without `md` we can't detach it, so
  // fall back to the read-only "manage from the pool" guidance.
  const reclaimable = disk.state === "pool_member" && !!disk.md;
  const chip: { label: string; kind: BadgeKind } =
    disk.state === "pool_member"
      ? { label: "In a pool", kind: "info" }
      : disk.state === "foreign"
        ? { label: "Has data", kind: "warn" }
        : { label: "Empty", kind: "muted" };
  const blurb =
    disk.state === "pool_member"
      ? reclaimable
        ? // WARP-1915: say what reclaiming actually does BEFORE the click —
          // it removes the drive from the pool AND erases everything on it.
          "Part of your storage pool. Reclaiming removes it from the pool and erases everything on it, so it can be used on its own."
        : "Part of your storage pool — manage it from the pool above."
      : disk.state === "foreign"
        ? "Holds files from another system. Erase it to add its space to your Droplet."
        : "Empty and ready to be added to your Droplet.";
  return (
    <div role="listitem" className="card">
      <div className="flex items-start gap-3">
        <IconTile>
          <BusIcon bus={disk.bus} className="h-5 w-5" />
        </IconTile>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4
              className="truncate"
              style={{ fontSize: "14px", fontWeight: 600, color: "var(--text)" }}
              title={diskTitle(disk)}
            >
              {diskTitle(disk)}
            </h4>
            <HwTag>{busLabel(disk.bus)}</HwTag>
          </div>
          <p
            className="tabular-nums"
            style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}
          >
            {fmtBytes(disk.size_bytes)} ·{" "}
            <span style={{ fontFamily: "var(--font-mono)" }}>{disk.name}</span>
          </p>
        </div>
        <Badge kind={chip.kind}>{chip.label}</Badge>
      </div>

      <p
        className="mt-3"
        style={{ fontSize: "12px", color: "var(--text-muted)" }}
      >
        {blurb}
      </p>

      {isAdmin && (adoptable || reclaimable) && (
        <div
          className="mt-4 pt-3 flex justify-end"
          style={{ borderTop: "1px solid var(--card-bd)" }}
        >
          <button
            onClick={reclaimable ? onReclaim : onAdopt}
            disabled={busy}
            className="btn danger sm flex-none whitespace-nowrap"
          >
            {/* WARP-1915: the label names both halves of the destructive
                action — mirrors "Erase & adopt"; never a bare "Reclaim". */}
            {busy ? "Working…" : reclaimable ? "Reclaim & erase" : "Erase & adopt"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * One drive card. Read by everyone; admins additionally get an inline rename
 * (WARP-827) wired to the existing PATCH /api/storage/drives/:uuid via
 * updateDriveLabel(). The friendly name is applied optimistically and rolled
 * back if the save fails. Clicking the card title deep-links into the existing
 * file browser scoped to this drive — never a new endpoint. The raw /dev/sdX
 * path is intentionally NOT shown (home-user persona, ADR-002).
 */
function DriveCard({
  drive: d,
  isAdmin,
  ejecting,
  onEject,
  onRenamed,
}: {
  drive: DriveInfo;
  isAdmin: boolean;
  ejecting: boolean;
  onEject: () => void;
  onRenamed: () => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // Optimistic display name — set on a successful (or in-flight) save so the
  // card shows the new name before the drives list refetches; rolled back on
  // failure.
  const [optimisticName, setOptimisticName] = useState<string | null>(null);
  // Return focus to the Rename trigger when edit mode exits — save and cancel
  // both unmount the input, which would otherwise drop focus to <body>
  // (WCAG 2.4.3 focus order).
  const renameBtnRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) renameBtnRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const p = usagePct(d);
  const st = statusOf(d);
  const name = driveName(d, optimisticName);
  const trimmed = draft.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= DRIVE_NAME_MAX;

  function beginEdit() {
    // Seed the field with the current friendly name (without the raw fallbacks
    // that aren't user-set) so a rename edits rather than starts blank.
    setDraft(optimisticName || d.displayName || "");
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setDraft("");
  }

  async function save() {
    if (!valid || saving) return;
    const previous = optimisticName;
    setOptimisticName(trimmed); // optimistic
    setSaving(true);
    setEditing(false);
    try {
      await updateDriveLabel(d.uuid, { displayName: trimmed });
      onRenamed(); // refetch so the persisted name replaces the optimistic one
    } catch (err) {
      setOptimisticName(previous); // roll back
      // WARP-1141: storage domain, not files — a failed rename is a WRITE,
      // and the files fallback ("couldn't load those files") read as a
      // transient load blip, hiding the failure from the user.
      toast(translateError(err, "storage"), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    // `relative` anchors the stretched title-link overlay (WARP-1338): the
    // whole card is the click target, while later-in-DOM positioned controls
    // (the Rename button) stack above it and stay functional.
    <div role="listitem" className="card relative">
      <div className="flex items-start gap-3">
        <IconTile>
          <BusIcon bus={d.bus} className="h-5 w-5" />
        </IconTile>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                aria-label="Drive name"
                value={draft}
                maxLength={DRIVE_NAME_MAX}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                  if (e.key === "Escape") cancelEdit();
                }}
                className="min-w-0 flex-1 outline-none text-[16px] lg:text-[13.5px]"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                  fontWeight: 500,
                  padding: "6px 10px",
                }}
                placeholder="Drive name"
              />
              <button
                onClick={save}
                disabled={!valid || saving}
                aria-label="Save"
                className="flex-none inline-flex items-center justify-center h-11 w-11 disabled:opacity-40 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2"
                style={{
                  borderRadius: "var(--radius-input)",
                  color: "var(--brand)",
                }}
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                onClick={cancelEdit}
                aria-label="Cancel"
                className="flex-none inline-flex items-center justify-center h-11 w-11 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2"
                style={{
                  borderRadius: "var(--radius-input)",
                  color: "var(--text-muted)",
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link
                href={driveContentsHref(d)}
                className="min-w-0 inline-flex items-center gap-1 group focus-visible:outline-none focus-visible:ring-2"
                style={{ borderRadius: "var(--radius-input)" }}
                aria-label={`Open ${name}`}
              >
                {/* WARP-1338: stretched link — this overlay spans the whole
                    (relative) card, widening the click target without adding
                    a second tab stop or nesting controls inside the anchor.
                    The Rename button below is positioned later in the DOM,
                    so it stacks above and stays clickable. */}
                <span className="absolute inset-0" aria-hidden="true" />
                <h3
                  className="truncate transition-colors duration-150 group-hover:text-[color:var(--brand)]"
                  style={{ fontSize: "14px", fontWeight: 600, color: "var(--text)" }}
                  title={name}
                >
                  {name}
                </h3>
                <FolderOpen
                  className="flex-none h-3.5 w-3.5 transition-colors duration-150 group-hover:text-[color:var(--brand)]"
                  style={{ color: "var(--text-muted)" }}
                />
              </Link>
              <HwTag>{busLabel(d.bus)}</HwTag>
              {/* WARP-1141: the label row is keyed by the drive's FS UUID —
                  the bridge can report a drive without one (automount state
                  gap, no /dev/disk/by-uuid symlink), and renaming such a
                  drive can never persist. Don't offer a control that is
                  guaranteed to fail. */}
              {isAdmin && !!d.uuid && (
                <button
                  ref={renameBtnRef}
                  onClick={beginEdit}
                  aria-label="Rename"
                  // `relative` lifts the control above the stretched title
                  // link's inset overlay (WARP-1338) so Rename stays clickable.
                  className="relative flex-none ml-auto inline-flex items-center justify-center h-11 w-11 -my-2.5 -mr-2.5 transition-colors duration-150 hover:text-[color:var(--brand)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2"
                  style={{
                    borderRadius: "var(--radius-input)",
                    color: "var(--text-muted)",
                  }}
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
        {!editing && <Badge kind={st.kind}>{st.label}</Badge>}
      </div>

      <div className="mt-4">
        <div
          className="flex items-baseline justify-between tabular-nums mb-1.5"
          style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" }}
        >
          <span>
            <span style={{ color: "var(--text)" }}>{fmtBytes(d.used_bytes)}</span> of{" "}
            {fmtBytes(d.size_bytes)}
          </span>
          <span>{fmtBytes(d.free_bytes)} free</span>
        </div>
        <Meter pct={p} kind={meterKind(p)} />
      </div>

      {/* Hardware facts — friendly only. The raw /dev/sdX path is deliberately
          never surfaced (home-user persona, ADR-002); the bus label above is
          the only hardware identifier we show. */}
      {(d.fs || typeof d.temp_c === "number" || d.smart) && (
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {d.fs && <HwTag>{d.fs}</HwTag>}
          {typeof d.temp_c === "number" && <HwTag upper={false}>{d.temp_c}°C</HwTag>}
          {d.smart && (
            <Badge kind={d.smart === "PASSED" ? "ok" : "danger"}>
              SMART {d.smart}
            </Badge>
          )}
        </div>
      )}

      {d.notes && (
        <p className="mt-2" style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          {d.notes}
        </p>
      )}

      {d.removable && d.mounted && (
        <div
          className="mt-4 pt-3 flex justify-end"
          style={{ borderTop: "1px solid var(--card-bd)" }}
        >
          <button
            onClick={onEject}
            disabled={ejecting}
            // `relative` lifts the control above the stretched title link's
            // inset overlay (WARP-1338) — same treatment as Rename. Without
            // it the positioned overlay paints over this static button and
            // clicking Eject silently navigates to /files instead (UX
            // review finding).
            className="relative btn ghost sm disabled:opacity-60"
          >
            {ejecting ? "Ejecting…" : "Eject"}
          </button>
        </div>
      )}
    </div>
  );
}

/** Page-level banner for a pool that needs attention. Uses role="alert" so it
 *  is announced; tokens-only colours. Blast-radius copy is plain-language. */
function PoolAlarmBanner({
  alarm,
  pools,
}: {
  alarm: "degraded" | "resyncing" | "failed";
  pools: PoolInfo[];
}) {
  const affected = pools
    .filter((p) =>
      alarm === "failed"
        ? p.status === "failed"
        : alarm === "degraded"
          ? p.status === "degraded"
          : p.status === "resyncing",
    )
    .map((p) => poolName(p))
    .join(", ");

  if (alarm === "resyncing") {
    return (
      <div
        role="alert"
        className="card flex items-start gap-3"
        style={{
          border: "1px solid color-mix(in srgb, var(--brand) 30%, transparent)",
          background: "var(--brand-subtle)",
        }}
      >
        <Loader2
          size={18}
          className="mt-0.5 flex-none motion-safe:animate-spin"
          style={{ color: "var(--brand)" }}
        />
        <div>
          <p style={{ fontSize: "13.5px", fontWeight: 500, color: "var(--text)" }}>
            Rebuilding {affected}
          </p>
          <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
            A drive is being resynced. Your data stays available — leave the
            Droplet on until the rebuild finishes.
          </p>
        </div>
      </div>
    );
  }

  const failed = alarm === "failed";
  const tone = failed ? "#ef4444" : "#d9a35c";
  return (
    <div
      role="alert"
      className="card flex items-start gap-3"
      style={{
        border: `1px solid color-mix(in srgb, ${tone} 32%, transparent)`,
        background: `color-mix(in srgb, ${tone} 8%, transparent)`,
      }}
    >
      <AlertTriangle size={18} className="mt-0.5 flex-none" style={{ color: tone }} />
      <div>
        <p style={{ fontSize: "13.5px", fontWeight: 500, color: "var(--text)" }}>
          {failed ? `${affected} has failed` : `${affected} is degraded`}
        </p>
        <p style={{ fontSize: "12px", color: "var(--text-muted)", marginTop: "2px" }}>
          {failed
            ? "This pool is offline and its data may be at risk. Check the drives and contact support before making changes."
            : "A drive has dropped out of this pool. Your data is still here, but replace the drive soon — another failure could lose it."}
        </p>
      </div>
    </div>
  );
}

/** One storage-pool card: name, level + plain-language blurb, health badge,
 *  and a member-count chip. Admins additionally get an inline rename (WARP-1048)
 *  wired to PATCH /api/storage/pools/:device via updatePoolLabel() — the same
 *  optimistic-then-refetch pattern as the per-drive DriveCard rename.
 *  Destructive actions (format) live behind the Tier-3 confirm flow.
 *  Raw kernel device names (/dev/md*, member /dev/sd*) are deliberately NOT
 *  surfaced — the target user is non-technical (ADR-002; follow-up to WARP-827,
 *  which gave the per-drive DriveCard the same treatment). */
function PoolCard({
  pool,
  isAdmin = false,
  backingDrive,
  canFormat = false,
  formatting = false,
  onFormat,
  onRenamed,
}: {
  pool: PoolInfo;
  isAdmin?: boolean;
  /** WARP-1339: the mounted md filesystem backing this pool (the drives-list
   *  entry whose device is the pool's md node / a partition of it). Supplies
   *  the REAL fs-level used/size/free meter (ADR-019 usable capacity — never
   *  a fabricated raw-member sum) and the browse deep-link. Absent for a
   *  created-but-never-formatted pool. */
  backingDrive?: DriveInfo;
  /** WARP-936: true when the pool's md device backs no mounted filesystem —
   *  created but never formatted+mounted. Admin-gated by the caller. */
  canFormat?: boolean;
  formatting?: boolean;
  onFormat?: () => void;
  /** WARP-1048: called after a successful rename so the list refetches. */
  onRenamed?: () => void;
}) {
  const { toast } = useToast();
  const badge = poolStatusBadge(pool.status);
  const memberCount = pool.members.length;
  const usedPct = backingDrive ? usagePct(backingDrive) : 0;

  // Inline rename — mirrors DriveCard (WARP-827). Optimistic name shown until
  // the pools list refetches; rolled back on failure. Focus returns to the
  // Rename trigger when edit mode exits (WCAG 2.4.3).
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [optimisticName, setOptimisticName] = useState<string | null>(null);
  const renameBtnRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) renameBtnRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const name = poolName(
    optimisticName != null ? { ...pool, displayName: optimisticName } : pool,
  );
  const trimmed = draft.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= DRIVE_NAME_MAX;

  function beginEdit() {
    setDraft(optimisticName || pool.displayName || "");
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
    setDraft("");
  }
  async function save() {
    if (!valid || saving) return;
    const previous = optimisticName;
    setOptimisticName(trimmed); // optimistic
    setSaving(true);
    setEditing(false);
    try {
      await updatePoolLabel(pool.device, { displayName: trimmed });
      onRenamed?.();
    } catch (err) {
      setOptimisticName(previous); // roll back
      // WARP-1141: storage domain — same rationale as the DriveCard rename.
      toast(translateError(err, "storage"), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div role="listitem" className="card">
      <div className="flex items-start gap-3">
        <span
          className="flex-none h-10 w-10 flex items-center justify-center"
          style={{
            borderRadius: "10px",
            background: "var(--brand-subtle)",
            color: "var(--brand)",
          }}
        >
          <Layers className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                aria-label="Pool name"
                value={draft}
                maxLength={DRIVE_NAME_MAX}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                  if (e.key === "Escape") cancelEdit();
                }}
                className="min-w-0 flex-1 outline-none text-[16px] lg:text-[13.5px]"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                  fontWeight: 500,
                  padding: "6px 10px",
                }}
                placeholder="Pool name"
              />
              <button
                onClick={save}
                disabled={!valid || saving}
                aria-label="Save"
                className="flex-none inline-flex items-center justify-center h-11 w-11 disabled:opacity-40 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2"
                style={{ borderRadius: "var(--radius-input)", color: "var(--brand)" }}
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                onClick={cancelEdit}
                aria-label="Cancel"
                className="flex-none inline-flex items-center justify-center h-11 w-11 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2"
                style={{ borderRadius: "var(--radius-input)", color: "var(--text-muted)" }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              {backingDrive ? (
                // WARP-1339: the pool's contents are the mounted md
                // filesystem's — deep-link into the existing file browser at
                // its mount tail, exactly like a DriveCard title (reuse, no
                // new endpoint).
                <Link
                  href={driveContentsHref(backingDrive)}
                  className="min-w-0 inline-flex items-center gap-1 group focus-visible:outline-none focus-visible:ring-2"
                  style={{ borderRadius: "var(--radius-input)" }}
                  aria-label={`Open ${name}`}
                >
                  <h4
                    className="truncate transition-colors duration-150 group-hover:text-[color:var(--brand)]"
                    style={{ fontSize: "14px", fontWeight: 600, color: "var(--text)" }}
                    title={name}
                  >
                    {name}
                  </h4>
                  <FolderOpen
                    className="flex-none h-3.5 w-3.5 transition-colors duration-150 group-hover:text-[color:var(--brand)]"
                    style={{ color: "var(--text-muted)" }}
                  />
                </Link>
              ) : (
                <h4
                  className="truncate"
                  style={{ fontSize: "14px", fontWeight: 600, color: "var(--text)" }}
                  title={name}
                >
                  {name}
                </h4>
              )}
              <HwTag>{levelLabel(pool.level)}</HwTag>
              {isAdmin && (
                <button
                  ref={renameBtnRef}
                  onClick={beginEdit}
                  aria-label="Rename"
                  className="flex-none ml-auto inline-flex items-center justify-center h-11 w-11 -my-2.5 -mr-2.5 transition-colors duration-150 hover:text-[color:var(--brand)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2"
                  style={{ borderRadius: "var(--radius-input)", color: "var(--text-muted)" }}
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          {!editing && (
            <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
              {levelBlurb(pool.level)}
            </p>
          )}
        </div>
        {!editing && <Badge kind={poolBadgeKind(pool.status)}>{badge.label}</Badge>}
      </div>

      {/* WARP-1339: the pool's REAL usable capacity — the mounted md
          filesystem's fs-level bytes (ADR-019), same meter idiom as a
          DriveCard. No meter for a never-formatted pool: there is no
          filesystem to measure, and a raw-member sum would be a fiction. */}
      {backingDrive && (
        <div className="mt-4">
          <div
            className="flex items-baseline justify-between tabular-nums mb-1.5"
            style={{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--text-muted)" }}
          >
            <span>
              <span style={{ color: "var(--text)" }}>
                {fmtBytes(backingDrive.used_bytes)}
              </span>{" "}
              of {fmtBytes(backingDrive.size_bytes)}
            </span>
            <span>{fmtBytes(backingDrive.free_bytes)} free</span>
          </div>
          <Meter pct={usedPct} kind={meterKind(usedPct)} />
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <HwTag upper={false}>
          {memberCount} {memberCount === 1 ? "drive" : "drives"}
        </HwTag>
      </div>

      {pool.notes && (
        <p className="mt-2" style={{ fontSize: "12px", color: "var(--text-muted)" }}>
          {pool.notes}
        </p>
      )}

      {/* WARP-936: the way forward for a created-but-never-formatted pool.
          Destructive → tier-3 confirm-token + blast-radius dialog in the
          parent; this is just the entry point. */}
      {canFormat && (
        <div
          className="mt-4 pt-3 flex items-center justify-between gap-3 flex-wrap"
          style={{ borderTop: "1px solid var(--card-bd)" }}
        >
          <p style={{ fontSize: "12px", color: "var(--text-muted)" }}>
            This pool isn&rsquo;t set up as storage yet.
          </p>
          <button
            onClick={onFormat}
            disabled={formatting}
            className="btn danger sm flex-none whitespace-nowrap"
          >
            {formatting ? "Working…" : "Format & mount"}
          </button>
        </div>
      )}
    </div>
  );
}
