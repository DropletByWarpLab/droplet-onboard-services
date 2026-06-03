"use client";

import { useMemo, useState } from "react";
import { HardDrive, Usb, MemoryStick, RefreshCw } from "lucide-react";
import { useDrives } from "@/lib/hooks/useDrives";
import { ejectDrive, rescanDrives } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { translateError } from "@/lib/friendly-errors";
import type { DriveInfo } from "@/lib/types";

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
function driveName(d: DriveInfo): string {
  const tail = d.mount.split("/").filter(Boolean).pop() ?? "";
  const raw = (d.displayName || d.label || tail).replace(/[-_]+/g, " ").trim();
  if (!raw) return "Drive";
  return raw.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

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
  const { toast } = useToast();
  const [rescanning, setRescanning] = useState(false);
  const [ejectTarget, setEjectTarget] = useState<DriveInfo | null>(null);
  const [ejecting, setEjecting] = useState<string | null>(null);

  const pool = useMemo(() => {
    const size = drives.reduce((a, d) => a + (d.size_bytes || 0), 0);
    const used = drives.reduce((a, d) => a + (d.used_bytes || 0), 0);
    const free = drives.reduce((a, d) => a + (d.free_bytes || 0), 0);
    return { size, used, free, count: drives.length };
  }, [drives]);

  async function onRescan() {
    setRescanning(true);
    try {
      await rescanDrives();
      // SWR refetches on the 30s interval; nudge an immediate refresh by
      // toasting success — the next poll picks up new/removed drives.
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

  return (
    <div className="flex flex-col gap-5">
      {/* Pool summary */}
      <section className="dp-card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="type-caption-2 uppercase tracking-wide text-label-tertiary mb-1">
              Total pooled storage
            </p>
            <p className="type-title-2 text-label-primary tabular-nums">
              {fmtBytes(pool.used)}
              <span className="type-subheadline text-label-tertiary font-normal">
                {" "}
                of {fmtBytes(pool.size)} used
              </span>
            </p>
          </div>
          <div className="flex items-center gap-6">
            <div className="text-right">
              <p className="type-title-3 text-label-primary tabular-nums">{pool.count}</p>
              <p className="type-caption-2 text-label-tertiary">mounted</p>
            </div>
            <div className="text-right">
              <p className="type-title-3 text-label-primary tabular-nums">{fmtBytes(pool.free)}</p>
              <p className="type-caption-2 text-label-tertiary">free</p>
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
        </div>
        <div className="mt-3 flex items-center justify-between type-caption-1 text-label-tertiary">
          <span>
            Mount base <span className="font-mono">/mnt/droplet/</span>
          </span>
        </div>
      </section>

      {/* Per-drive cards */}
      <div
        className="grid grid-cols-1 sm:grid-cols-2 gap-4"
        role="list"
        aria-label="Mounted drives"
      >
        {drives.map((d) => {
          const p = usagePct(d);
          const st = statusOf(d);
          return (
            <div key={d.uuid || d.mount || d.device} role="listitem" className="dp-card p-4">
              <div className="flex items-start gap-3">
                <span className="flex-none h-10 w-10 rounded-[10px] bg-surface-secondary text-label-secondary flex items-center justify-center">
                  <BusIcon bus={d.bus} className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h3 className="type-headline text-label-primary truncate" title={driveName(d)}>
                      {driveName(d)}
                    </h3>
                    <span className="flex-none type-caption-2 uppercase tracking-wide px-1.5 py-0.5 rounded border border-separator text-label-tertiary">
                      {busLabel(d.bus)}
                    </span>
                  </div>
                  <p className="type-caption-1 font-mono text-label-tertiary truncate" title={d.mount}>
                    {d.mount}
                  </p>
                </div>
                <span className={`flex-none type-caption-2 px-2 py-0.5 rounded-full ${st.cls}`}>
                  {st.label}
                </span>
              </div>

              <div className="mt-3">
                <div className="flex items-baseline justify-between type-caption-1 tabular-nums mb-1">
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

              <div className="mt-3 flex items-center gap-2 flex-wrap type-caption-2">
                <span className="font-mono px-1.5 py-0.5 rounded border border-separator text-label-tertiary">
                  {d.device}
                </span>
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

              {d.notes && (
                <p className="mt-2 type-caption-1 text-label-tertiary">{d.notes}</p>
              )}

              {d.removable && d.mounted && (
                <div className="mt-3 pt-3 border-t border-separator flex justify-end">
                  <button
                    onClick={() => setEjectTarget(d)}
                    disabled={ejecting === d.uuid}
                    className="dp-btn-secondary type-caption-1 px-2.5 h-8 rounded-md"
                  >
                    {ejecting === d.uuid ? "Ejecting…" : "Eject"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
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
