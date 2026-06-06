"use client";

import { useEffect, useRef, useState } from "react";
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
} from "lucide-react";
import { useDrives } from "@/lib/hooks/useDrives";
import { usePools } from "@/lib/hooks/usePools";
import { ejectDrive, rescanDrives, updateDriveLabel } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { translateError } from "@/lib/friendly-errors";
import type { DriveInfo, PoolInfo } from "@/lib/types";
import {
  levelLabel,
  levelBlurb,
  poolStatusBadge,
  worstPoolAlarm,
} from "./pool-display";

// Binary units, matching the rest of the dashboard (VolumesPanel etc.).
function fmtBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Customer-facing name: friendly displayName, then FS label, then the mount
// tail — never the raw device path, since the target user is non-technical.
// `override` lets the card show an optimistic just-typed name before the
// hook's data refetches.
function driveName(d: DriveInfo, override?: string | null): string {
  const tail = d.mount.split("/").filter(Boolean).pop() ?? "";
  const raw = (override || d.displayName || d.label || tail)
    .replace(/[-_]+/g, " ")
    .trim();
  if (!raw) return "Drive";
  return raw.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

// Customer-facing pool name: the owner's displayName, else a generic label —
// never the raw md device path (ADR-002 home-user persona; follow-up to WARP-827
// which gave DriveCard the same treatment).
function poolName(pool: PoolInfo): string {
  const raw = (pool.displayName || "").replace(/[-_]+/g, " ").trim();
  if (!raw) return "Storage pool";
  return raw.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

// WARP-827: the auto-mounter registers each drive as a Nextcloud external
// storage mount at `/<mount-tail>` (services/automount/droplet-automount.sh →
// `files_external:create "/$NAME"`), where the tail equals the host mount's
// last path segment. So the drive's contents are browsable in the existing
// Nextcloud-backed file browser at that path — we deep-link there (reuse, no
// new endpoint). The FilesPage reads `?path=` on mount.
function driveContentsHref(d: DriveInfo): string {
  const tail = d.mount.split("/").filter(Boolean).pop() ?? "";
  const ncPath = `/${tail}`;
  return `/files?path=${encodeURIComponent(ncPath)}`;
}

// Customer-chosen drive names are 1–64 chars, trimmed, non-empty — mirrors the
// orchestrator's updateDriveSchema (z.string().trim().min(1).max(64)).
const DRIVE_NAME_MAX = 64;

function usagePct(d: DriveInfo): number {
  if (!d.size_bytes) return 0;
  return Math.max(0, Math.min(100, (d.used_bytes / d.size_bytes) * 100));
}

function barColor(p: number): string {
  if (p > 90) return "var(--color-system-red)";
  if (p > 75) return "var(--color-system-orange)";
  return "var(--color-accent)";
}

type Status = { label: string; cls: string };
function statusOf(d: DriveInfo): Status {
  if (!d.mounted) return { label: "Offline", cls: "bg-system-red/10 text-system-red" };
  if (d.readonly) return { label: "Read-only", cls: "bg-surface-secondary text-label-secondary" };
  if (usagePct(d) > 90) return { label: "Nearly full", cls: "bg-system-orange/10 text-system-orange" };
  return { label: "Mounted", cls: "bg-system-green/10 text-system-green" };
}

function BusIcon({ bus, className }: { bus?: string; className?: string }) {
  if (bus === "usb") return <Usb className={className} />;
  if (bus === "mmc") return <MemoryStick className={className} />;
  return <HardDrive className={className} />; // nvme + generic disk
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
  const { drives, isLoading, bridgeError, refresh } = useDrives();
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
        <div className="dp-card h-28 animate-pulse bg-surface-secondary" />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="dp-card h-44 animate-pulse bg-surface-secondary" />
          ))}
        </div>
      </div>
    );
  }

  if (bridgeError || drives.length === 0) {
    return (
      <div className="dp-card p-8 text-center">
        <HardDrive size={28} className="mx-auto text-label-tertiary mb-3" />
        <h2 className="type-headline text-label-primary mb-1">No drives mounted</h2>
        <p className="type-subheadline text-label-secondary mb-4">
          {bridgeError
            ? "The storage service isn't reachable right now."
            : "Plug in a drive and it mounts automatically."}
        </p>
        <button
          onClick={onRescan}
          disabled={rescanning}
          className="dp-btn-secondary inline-flex items-center gap-1.5 px-3 h-9 rounded-md"
        >
          <RefreshCw size={15} className={rescanning ? "animate-spin" : ""} />
          <span className="type-subheadline">Rescan</span>
        </button>
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
          <h2 className="type-title-3 text-label-primary">Storage</h2>
          <p className="type-caption-1 text-label-tertiary">
            Mount base <span className="font-mono">/mnt/droplet/</span>
          </p>
        </div>
        <button
          onClick={onRescan}
          disabled={rescanning}
          className="dp-btn-secondary inline-flex items-center gap-1.5 px-3 h-9 rounded-md"
          aria-label="Rescan drives"
        >
          <RefreshCw size={15} className={rescanning ? "animate-spin" : ""} />
          <span className="type-subheadline">Rescan</span>
        </button>
      </div>

      {/* Storage pools (mdadm software RAID). Pools are OPTIONAL — when none
          exists we say so honestly rather than fabricating a pooled sum. */}
      <section aria-label="Storage pools">
        {pools.length === 0 ? (
          <div className="dp-card p-5 flex items-start gap-3">
            <span className="flex-none h-10 w-10 rounded-[10px] bg-surface-secondary text-label-tertiary flex items-center justify-center">
              <Layers className="h-5 w-5" />
            </span>
            <div>
              <p className="type-headline text-label-primary">No storage pool configured</p>
              <p className="type-subheadline text-label-secondary mt-0.5">
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
              <PoolCard key={p.device} pool={p} />
            ))}
          </div>
        )}
      </section>

      {/* Per-drive cards */}
      <div>
        <h3 className="type-caption-2 uppercase tracking-wide text-label-tertiary mb-2">
          Drives
        </h3>
        <div
          className="grid grid-cols-1 sm:grid-cols-2 gap-4"
          role="list"
          aria-label="Mounted drives"
        >
          {drives.map((d) => (
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
      </div>

      <ConfirmDialog
        open={ejectTarget !== null}
        onConfirm={doEject}
        onCancel={() => setEjectTarget(null)}
        title="Eject this drive?"
        description={`${ejectTarget ? driveName(ejectTarget) : "The drive"} will be unmounted. Wait for the confirmation before unplugging it.`}
        confirmLabel="Eject"
        variant="destructive"
      />
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
      toast(translateError(err, "files"), "error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div role="listitem" className="dp-card p-4">
      <div className="flex items-start gap-3">
        <span className="flex-none h-10 w-10 rounded-[10px] bg-surface-secondary text-label-secondary flex items-center justify-center">
          <BusIcon bus={d.bus} className="h-5 w-5" />
        </span>
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
                className="dp-input !py-1.5 !px-2.5 type-subheadline min-w-0 flex-1"
                placeholder="Drive name"
              />
              <button
                onClick={save}
                disabled={!valid || saving}
                aria-label="Save"
                className="flex-none inline-flex items-center justify-center h-11 w-11 rounded-md text-accent hover:bg-accent-subtle disabled:opacity-40 transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <Check className="h-4 w-4" />
              </button>
              <button
                onClick={cancelEdit}
                aria-label="Cancel"
                className="flex-none inline-flex items-center justify-center h-11 w-11 rounded-md text-label-tertiary hover:bg-surface-secondary transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Link
                href={driveContentsHref(d)}
                className="min-w-0 inline-flex items-center gap-1 group rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                aria-label={`Open ${name}`}
              >
                <h3
                  className="type-headline text-label-primary truncate group-hover:text-accent transition-colors duration-150"
                  title={name}
                >
                  {name}
                </h3>
                <FolderOpen className="flex-none h-3.5 w-3.5 text-label-tertiary group-hover:text-accent transition-colors duration-150" />
              </Link>
              <span className="flex-none type-caption-2 uppercase tracking-wide px-1.5 py-0.5 rounded border border-separator text-label-tertiary">
                {busLabel(d.bus)}
              </span>
              {isAdmin && (
                <button
                  ref={renameBtnRef}
                  onClick={beginEdit}
                  aria-label="Rename"
                  className="flex-none ml-auto inline-flex items-center justify-center h-11 w-11 -my-2.5 -mr-2.5 rounded-md text-label-tertiary hover:text-accent hover:bg-accent-subtle transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                >
                  <Pencil className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
        {!editing && (
          <span className={`flex-none type-caption-2 px-2 py-0.5 rounded-full ${st.cls}`}>
            {st.label}
          </span>
        )}
      </div>

      <div className="mt-4">
        <div className="flex items-baseline justify-between type-caption-1 tabular-nums mb-1.5">
          <span className="text-label-secondary">
            <span className="text-label-primary">{fmtBytes(d.used_bytes)}</span> of{" "}
            {fmtBytes(d.size_bytes)}
          </span>
          <span className="text-label-tertiary">{fmtBytes(d.free_bytes)} free</span>
        </div>
        <div className="h-1.5 rounded-full overflow-hidden bg-surface-secondary">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${Math.max(2, p)}%`, background: barColor(p) }}
          />
        </div>
      </div>

      {/* Hardware facts — friendly only. The raw /dev/sdX path is deliberately
          never surfaced (home-user persona, ADR-002); the bus label above is
          the only hardware identifier we show. */}
      {(d.fs || typeof d.temp_c === "number" || d.smart) && (
        <div className="mt-3 flex items-center gap-2 flex-wrap type-caption-2">
          {d.fs && (
            <span className="uppercase px-1.5 py-0.5 rounded border border-separator text-label-tertiary">
              {d.fs}
            </span>
          )}
          {typeof d.temp_c === "number" && (
            <span className="px-1.5 py-0.5 rounded border border-separator text-label-tertiary tabular-nums">
              {d.temp_c}°C
            </span>
          )}
          {d.smart && (
            <span
              className={`px-1.5 py-0.5 rounded ${
                d.smart === "PASSED"
                  ? "bg-system-green/10 text-system-green"
                  : "bg-system-red/10 text-system-red"
              }`}
            >
              SMART {d.smart}
            </span>
          )}
        </div>
      )}

      {d.notes && <p className="mt-2 type-caption-1 text-label-tertiary">{d.notes}</p>}

      {d.removable && d.mounted && (
        <div className="mt-4 pt-3 border-t border-separator flex justify-end">
          <button
            onClick={onEject}
            disabled={ejecting}
            className="dp-btn-secondary type-subheadline px-4 rounded-md disabled:opacity-60"
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
        className="dp-card p-4 flex items-start gap-3 border border-system-blue/30 bg-system-blue/5"
      >
        <Loader2 size={18} className="mt-0.5 flex-none text-system-blue motion-safe:animate-spin" />
        <div>
          <p className="type-subheadline text-label-primary">Rebuilding {affected}</p>
          <p className="type-caption-1 text-label-secondary mt-0.5">
            A drive is being resynced. Your data stays available — leave the
            Droplet on until the rebuild finishes.
          </p>
        </div>
      </div>
    );
  }

  const failed = alarm === "failed";
  return (
    <div
      role="alert"
      className={`dp-card p-4 flex items-start gap-3 border ${
        failed
          ? "border-system-red/30 bg-system-red/5"
          : "border-system-orange/30 bg-system-orange/5"
      }`}
    >
      <AlertTriangle
        size={18}
        className={`mt-0.5 flex-none ${failed ? "text-system-red" : "text-system-orange"}`}
      />
      <div>
        <p className="type-subheadline text-label-primary">
          {failed ? `${affected} has failed` : `${affected} is degraded`}
        </p>
        <p className="type-caption-1 text-label-secondary mt-0.5">
          {failed
            ? "This pool is offline and its data may be at risk. Check the drives and contact support before making changes."
            : "A drive has dropped out of this pool. Your data is still here, but replace the drive soon — another failure could lose it."}
        </p>
      </div>
    </div>
  );
}

/** One storage-pool card: name, level + plain-language blurb, health badge,
 *  and a member-count chip. Read-only — destructive actions live behind the
 *  Tier-2 confirm flow (not surfaced here in the read-only view).
 *  Raw kernel device names (/dev/md*, member /dev/sd*) are deliberately NOT
 *  surfaced — the target user is non-technical (ADR-002; follow-up to WARP-827,
 *  which gave the per-drive DriveCard the same treatment). */
function PoolCard({ pool }: { pool: PoolInfo }) {
  const badge = poolStatusBadge(pool.status);
  const name = poolName(pool);
  const memberCount = pool.members.length;
  return (
    <div role="listitem" className="dp-card p-4">
      <div className="flex items-start gap-3">
        <span className="flex-none h-10 w-10 rounded-[10px] bg-accent/10 text-accent flex items-center justify-center">
          <Layers className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="type-headline text-label-primary truncate" title={name}>
              {name}
            </h4>
            <span className="flex-none type-caption-2 uppercase tracking-wide px-1.5 py-0.5 rounded border border-separator text-label-tertiary">
              {levelLabel(pool.level)}
            </span>
          </div>
          <p className="type-caption-1 text-label-tertiary">{levelBlurb(pool.level)}</p>
        </div>
        <span className={`flex-none type-caption-2 px-2 py-0.5 rounded-full ${badge.cls}`}>
          {badge.label}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-2 flex-wrap type-caption-2">
        <span className="px-1.5 py-0.5 rounded border border-separator text-label-tertiary">
          {memberCount} {memberCount === 1 ? "drive" : "drives"}
        </span>
      </div>

      {pool.notes && <p className="mt-2 type-caption-1 text-label-tertiary">{pool.notes}</p>}
    </div>
  );
}
