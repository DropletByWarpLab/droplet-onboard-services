"use client";

import Link from "next/link";
import { Cpu, HardDrive, Layers } from "lucide-react";
import { useDrives } from "@/lib/hooks/useDrives";
import { usePools } from "@/lib/hooks/usePools";
import { Meter } from "@/components/shell/primitives";
import type { DriveInfo, PoolInfo, SystemDiskInfo } from "@/lib/types";
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
  formatBytes,
  isPoolBackedDevice,
  poolBackingDrive,
  usagePctOf,
} from "./drive-display";

function pct(d: DriveInfo): number {
  return usagePctOf(d.used_bytes, d.size_bytes);
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
 * WARP-2098 — the Droplet's own install disk, as a tile on the Files screen.
 *
 * The tiles beside it are volumes you can open: each is a stretched link into
 * the Nextcloud-backed browser at the path the automounter registered. This one
 * is NOT. The system disk has no files_external registration, so a deep link
 * would be dead — the absence of the link is the affordance, and it is why this
 * is a separate component rather than a VolumeTile with a flag.
 *
 * It belongs on this screen because this is what the owner reads as "my
 * drives", and until now the appliance's own disk was invisible here while
 * being the disk Nextcloud actually writes uploads to.
 */
function SystemVolumeTile({ system }: { system: SystemDiskInfo }) {
  // Branch on the bridge's explicit state, never on the nulls: "partial" and
  // "unavailable" both carry null usage and are different things to say. No
  // meter for either — no fake 0%, and no undercount dressed as a total.
  const measured = system.measurement === "complete";
  const p = measured ? usagePctOf(system.used_bytes ?? 0, system.size_bytes) : 0;
  return (
    <div role="listitem" className="card relative">
      <div className="card-h">
        <span className="ci">
          <Cpu size={15} />
        </span>
        <span className="ct" title="System drive">
          System drive
        </span>
        <span className="cm">
          {measured
            ? `${formatBytes(system.free_bytes ?? 0)} free`
            : system.measurement === "partial"
              ? "Partly unreadable"
              : "Usage unavailable"}
        </span>
      </div>

      {measured && (
        <>
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
              {formatBytes(system.used_bytes ?? 0)}
            </span>
            <span>of {formatBytes(system.size_bytes)}</span>
          </div>
        </>
      )}

      <p
        style={{
          marginTop: "10px",
          fontSize: "12px",
          color: "var(--text-muted)",
        }}
      >
        The Droplet&rsquo;s own disk — separate from your storage.
      </p>
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
  const { drives, systemDisk, isLoading, bridgeError } = useDrives();
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

  // WARP-2098: a box with no data drives yet still has an install disk, and on
  // that box the system tile is the ONLY honest thing this panel can say — so
  // the panel no longer disappears when `drives` is empty. A bridge error still
  // hides everything: with no snapshot there is nothing trustworthy to render.
  if (bridgeError || (drives.length === 0 && !systemDisk)) {
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
      className={`grid ${volumeGridColumns(
        pooled.length + standalone.length + (systemDisk ? 1 : 0),
      )} gap-3 mb-4`}
      role="list"
      aria-label="Storage volumes"
    >
      {pooled.map(({ pool, drive }) => (
        <VolumeTile
          key={pool.device}
          // The pool's OWN displayName leads the shared chain; the matched
          // drive's fs label / GUID-guarded mount tail back it up, so a
          // nameless pool says "Storage pool" — never its GUID.
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
      {/* LAST, always: the owner's own storage leads, the appliance's disk
          follows. Omitted entirely when the bridge doesn't report it. */}
      {systemDisk && <SystemVolumeTile system={systemDisk} />}
    </div>
  );
}
