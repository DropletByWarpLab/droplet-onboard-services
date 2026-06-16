/**
 * BUG-3 / ADR-019 — RAID storage calculator (setup wizard).
 *
 * A PURE function over the detected-drive sizes. From the real drive inventory
 * (sizes from the existing GET /api/storage/drives fetch — never a fixture) it
 * computes the usable capacity for each ADR-019 RAID level and reports which
 * levels the current drive count can support, so the setup step can:
 *   - show an honest usable figure per level, and
 *   - grey out levels the drive count can't satisfy with a "needs N+ drives"
 *     (or "needs an even number") reason.
 *
 * Nothing here mutates state or talks to the network. The destructive create
 * path stays behind #489's owner-gated, confirm-token flow (ADR-019 D4); this
 * helper only does arithmetic for the chooser UI.
 *
 * Capacity model (smallest-drive rule for every redundant level, since md sizes
 * each member to the smallest disk):
 *   - jbod  / raid0 → sum of all drives        (no redundancy; raid0 needs ≥2)
 *   - raid1         → smallest                  (mirror;   needs ≥2)
 *   - raid5         → (N−1) × smallest          (parity;   needs ≥3)
 *   - raid6         → (N−2) × smallest          (2-parity; needs ≥4)
 *   - raid10        → (N/2) × smallest          (stripe+mirror; needs ≥4, even)
 */

import type { PoolInfo } from "@/lib/types";
import { levelLabel, levelBlurb } from "@/components/FileManager/pool-display";

/** The ADR-019 level enum (mirrors PoolInfo["level"]). */
export type RaidLevel = PoolInfo["level"];

/** The minimal drive shape the calculator needs. The setup step maps
 *  `DriveInfo` → this; keeping it narrow makes the helper trivially testable. */
export interface RaidCalcDrive {
  /** Block-device path (e.g. "/dev/sda") — used as the md member id downstream. */
  device: string;
  /** Raw drive size in bytes, as the device-bridge reports it. */
  size_bytes: number;
}

/** One RAID level as the chooser should render it. */
export interface RaidOption {
  level: RaidLevel;
  /** Human label, e.g. "RAID 5" (reused from pool-display for consistency). */
  label: string;
  /** One-line plain-language redundancy note (reused from pool-display). */
  blurb: string;
  /** Usable capacity in bytes for THIS drive set at this level. 0 when the
   *  level isn't applicable (or there are no drives). */
  usableBytes: number;
  /** True when the current drive count satisfies this level's minimum. */
  selectable: boolean;
  /** Minimum drive count this level requires. */
  minDrives: number;
  /** Why this level is greyed out, in plain language. Undefined when
   *  selectable. */
  unavailableReason?: string;
}

/** The order levels are presented in the chooser — safest-to-explain first:
 *  the two "more space" options, then the redundant ladder. */
const LEVEL_ORDER: RaidLevel[] = [
  "jbod",
  "raid0",
  "raid1",
  "raid5",
  "raid6",
  "raid10",
];

/** Per-level minimum drive count. */
export function minDrivesFor(level: RaidLevel): number {
  switch (level) {
    case "jbod":
      return 1;
    case "raid0":
    case "raid1":
      return 2;
    case "raid5":
      return 3;
    case "raid6":
    case "raid10":
      return 4;
    default:
      return 1;
  }
}

/** Levels that require an even number of drives. */
function requiresEven(level: RaidLevel): boolean {
  return level === "raid10";
}

/**
 * Usable bytes for a level given the (already filtered) real drive list.
 * Assumes `drives` are all > 0 bytes. Returns 0 when the level can't be built.
 */
function usableBytesFor(level: RaidLevel, drives: RaidCalcDrive[]): number {
  const n = drives.length;
  if (n === 0) return 0;
  const sum = drives.reduce((acc, d) => acc + d.size_bytes, 0);
  const smallest = drives.reduce(
    (min, d) => (d.size_bytes < min ? d.size_bytes : min),
    drives[0].size_bytes,
  );
  switch (level) {
    case "jbod":
    case "raid0":
      // Spanned / striped: all raw capacity is usable (no redundancy).
      return sum;
    case "raid1":
      // Mirror: one drive's worth, bounded by the smallest.
      return smallest;
    case "raid5":
      // Single parity: lose one drive's worth of capacity.
      return (n - 1) * smallest;
    case "raid6":
      // Double parity: lose two drives' worth.
      return (n - 2) * smallest;
    case "raid10":
      // Stripe of mirrors: half the (smallest-bounded) capacity.
      return Math.floor(n / 2) * smallest;
    default:
      return 0;
  }
}

/**
 * Compute the chooser options for the detected drives.
 *
 * Drives with a non-positive `size_bytes` (a momentary bridge artefact) are
 * ignored for BOTH the count and the capacity sums, so a phantom 0-byte drive
 * never makes a redundant level look selectable or inflate a figure.
 */
export function calculateRaidOptions(allDrives: RaidCalcDrive[]): RaidOption[] {
  const drives = allDrives.filter((d) => d.size_bytes > 0);
  const n = drives.length;

  return LEVEL_ORDER.map((level) => {
    const minDrives = minDrivesFor(level);
    const even = requiresEven(level);
    const meetsCount = n >= minDrives;
    const meetsEven = !even || n % 2 === 0;
    const selectable = meetsCount && meetsEven;

    let unavailableReason: string | undefined;
    if (!meetsCount) {
      unavailableReason = `Needs ${minDrives}+ drives`;
    } else if (!meetsEven) {
      // Count is high enough but odd — RAID 10 pairs drives, so it needs an
      // even number.
      unavailableReason = "Needs an even number of drives";
    }

    return {
      level,
      label: levelLabel(level),
      blurb: levelBlurb(level),
      usableBytes: selectable ? usableBytesFor(level, drives) : 0,
      selectable,
      minDrives,
      unavailableReason,
    };
  });
}
