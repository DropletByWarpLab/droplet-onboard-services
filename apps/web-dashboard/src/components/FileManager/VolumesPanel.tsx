"use client";

import Link from "next/link";
import { HardDrive, Layers } from "lucide-react";
import { useDrives } from "@/lib/hooks/useDrives";
import { usePools } from "@/lib/hooks/usePools";
import { Meter } from "@/components/shell/primitives";
import type { DriveInfo, PoolInfo } from "@/lib/types";
// WARP-1337: ONE shared display-name chain (displayName → label → GUID-guarded
// mount tail) — this panel used to skip `displayName` entirely and rendered a
// pool's raw fs-UUID mount tail as the tile title.
// WARP-1339: pools and drives were two UNJOINED lists, so a mounted pool
// surfaced here solely as an anonymous GUID drive tile. The shared join
// helpers merge the mounted md filesystem into ONE pooled tile instead.
// WARP-1338: tiles deep-link into the file browser via the SAME
// driveContentsHref the Storage page's cards use — one target, no drift.
import {
  driveContentsHref,
  driveDisplayName,
  drivePoolName,
  isPoolBackedDevice,
  poolBackingDrive,
} from "./drive-display";

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
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

/** One volume tile — shared by the pooled and standalone shapes (same card
 *  chrome, meter and byte row; only icon + title differ). WARP-1338: the
 *  whole tile is clickable into the file browser at the volume's registered
 *  path, via a stretched link — an absolutely-positioned anchor over the
 *  `relative` card. The tile has no other interactive children, so nothing
 *  ever nests inside the anchor; hover tints the title with the brand color
 *  (150 ms, matching the DriveCard title affordance). */
function VolumeTile({
  name,
  icon,
  drive: d,
}: {
  name: string;
  icon: React.ReactNode;
  drive: DriveInfo;
}) {
  const p = pct(d);
  return (
    <div role="listitem" className="card relative group">
      <div className="card-h">
        <span className="ci">{icon}</span>
        <span
          className="ct transition-colors duration-150 group-hover:text-[color:var(--brand)]"
          title={name}
        >
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
        <span style={{ color: "var(--text)" }}>{formatBytes(d.used_bytes)}</span>
        <span>of {formatBytes(d.size_bytes)}</span>
      </div>

      <Link
        href={driveContentsHref(d)}
        aria-label={`Open ${name}`}
        className="absolute inset-0 focus-visible:outline-none focus-visible:ring-2"
        style={{ borderRadius: "inherit" }}
      />
    </div>
  );
}

/**
 * WARP-1876 — column count capped at the tile count.
 *
 * The grid was a flat `sm:grid-cols-2 xl:grid-cols-3`, so a box with a
 * single volume rendered one card and two columns of nothing — "a large
 * empty region to the right of the Nvr storage card". Static class strings
 * (never interpolated) so Tailwind's scanner still emits them.
 */
const VOLUME_GRID_COLUMNS = [
  "grid-cols-1",
  "grid-cols-1",
  "grid-cols-1 sm:grid-cols-2",
  "grid-cols-1 sm:grid-cols-2 xl:grid-cols-3",
] as const;

function volumeGridColumns(tileCount: number): string {
  return VOLUME_GRID_COLUMNS[Math.min(tileCount, VOLUME_GRID_COLUMNS.length - 1)];
}

export function VolumesPanel() {
  const { drives, isLoading, bridgeError } = useDrives();
  // WARP-1339: pools feed the join only — a pool with no mounted md
  // filesystem has nothing browsable (and no honest bytes) to show on the
  // Files screen, so it stays a Storage-page concern.
  const { pools } = usePools();

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
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

  // WARP-1339 — ONE tile per pool, carrying the mounted md filesystem's real
  // fs-level bytes (ADR-019 — never a fabricated raw-member sum) under the
  // pool's own name.
  const pooled = pools
    .map((pool) => ({ pool, drive: poolBackingDrive(pool.device, drives) }))
    .filter((t): t is { pool: PoolInfo; drive: DriveInfo } => !!t.drive);

  // Plain tiles keep ONLY standalone drives. A pool-backed drive whose pool is
  // missing from the pools payload (degraded /storage/pools fetch, older
  // bridge) stays a plain tile — hiding it with no pooled tile to merge into
  // would lose the volume from the Files screen entirely. Its title is still
  // GUID-guarded ("Storage pool") via the WARP-1337 chain.
  const standalone = drives.filter((d) => {
    const md = drivePoolName(d);
    return !md || !pools.some((p) => p.device === md);
  });

  return (
    <div
      className={`grid ${volumeGridColumns(pooled.length + standalone.length)} gap-3 mb-4`}
      role="list"
      aria-label="Storage volumes"
    >
      {pooled.map(({ pool, drive }) => (
        <VolumeTile
          key={pool.device}
          // The pool's OWN displayName leads the shared chain; the matched
          // drive's fs label / GUID-guarded mount tail back it up, so the
          // customer never sees a GUID. WARP-2097: pool_format now writes the
          // owner's chosen name as the FS LABEL, so a pool named at format
          // time reads back here even with no displayName set. A pool left
          // unnamed carries the literal label "pool" and therefore reads
          // "Pool" — the "Storage pool" generic is only reached when the label
          // is EMPTY (a legacy pre-WARP-1338 pool).
          name={driveDisplayName(
            { mount: drive.mount, label: drive.label, displayName: pool.displayName },
            { poolBacked: true },
          )}
          icon={<Layers size={15} />}
          drive={drive}
        />
      ))}
      {standalone.map((d) => (
        <VolumeTile
          key={d.mount || d.device}
          name={driveDisplayName(d, { poolBacked: isPoolBackedDevice(d.device) })}
          icon={<HardDrive size={15} />}
          drive={d}
        />
      ))}
    </div>
  );
}
