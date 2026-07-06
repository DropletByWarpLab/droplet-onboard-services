"use client";

import { HardDrive } from "lucide-react";
import { useDrives } from "@/lib/hooks/useDrives";
import { Meter } from "@/components/shell/primitives";
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

// Design Storage meter: the fill turns amber past 80% and red past 95%,
// so a nearly-full volume reads as a warning at a glance.
function meterKind(p: number): "" | "warn" | "danger" {
  if (p > 95) return "danger";
  if (p > 80) return "warn";
  return "";
}

export function VolumesPanel() {
  const { drives, isLoading, bridgeError } = useDrives();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="card h-[92px] animate-pulse"
            style={{ background: "var(--inset)" }}
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
          <div key={d.mount || d.device} role="listitem" className="card">
            <div className="card-h">
              <span className="ci">
                <HardDrive size={15} />
              </span>
              <span className="ct" title={name}>
                {name}
              </span>
              <span className="cm">{formatBytes(d.free_bytes)} free</span>
            </div>

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
                {formatBytes(d.used_bytes)}
              </span>
              <span>of {formatBytes(d.size_bytes)}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
