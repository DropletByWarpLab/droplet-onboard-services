"use client";

import { HardDrive } from "lucide-react";
import { useDrives } from "@/lib/hooks/useDrives";
import type { DriveInfo } from "@/lib/types";

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

// Customer-facing name: prefer the filesystem label, fall back to the mount
// point's last segment so a customer sees "Cameras" or "Cloud Storage" — never
// /dev/nvme0n1p1. If neither is usable, show a generic "Drive" rather than the
// raw device path, since the target user is non-technical.
function displayName(d: DriveInfo): string {
  const fromMount = d.mount.split("/").filter(Boolean).pop() ?? "";
  const raw = (d.label || fromMount).replace(/[-_]+/g, " ").trim();
  if (!raw) return "Drive";
  return raw.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

function pct(d: DriveInfo): number {
  if (!d.size_bytes) return 0;
  return Math.max(0, Math.min(100, (d.used_bytes / d.size_bytes) * 100));
}

function barColor(p: number): string {
  if (p > 90) return "var(--color-system-red)";
  if (p > 75) return "var(--color-system-orange)";
  return "var(--color-accent)";
}

export function VolumesPanel() {
  const { drives, isLoading, bridgeError } = useDrives();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="dp-card p-4 h-[92px] animate-pulse bg-surface-secondary"
          />
        ))}
      </div>
    );
  }

  if (bridgeError || drives.length === 0) {
    return null;
  }

  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 mb-6"
      role="list"
      aria-label="Storage volumes"
    >
      {drives.map((d) => {
        const p = pct(d);
        const name = displayName(d);
        return (
          <div
            key={d.mount || d.device}
            role="listitem"
            className="dp-card p-4"
          >
            <div className="flex items-center gap-2 mb-3">
              <HardDrive
                size={14}
                className="text-label-tertiary flex-shrink-0"
              />
              <h3
                className="type-subheadline text-label-primary truncate"
                title={name}
              >
                {name}
              </h3>
            </div>

            <div className="h-[6px] rounded-full overflow-hidden bg-surface-secondary">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{
                  width: `${Math.max(2, p)}%`,
                  background: barColor(p),
                }}
              />
            </div>

            <div className="flex items-center justify-between mt-2 type-caption-1 text-label-tertiary tabular-nums">
              <span>
                <span className="text-label-primary">
                  {formatBytes(d.used_bytes)}
                </span>{" "}
                of {formatBytes(d.size_bytes)}
              </span>
              <span>{formatBytes(d.free_bytes)} free</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
