/**
 * BUG-3 / ADR-019: presentation helpers for storage pools.
 *
 * Kept out of the component so the capacity/level/status logic is unit-tested
 * directly and the panel stays readable. NONE of this fabricates capacity —
 * usable bytes are only ever shown when the bridge supplies them; otherwise we
 * present level + member count, never a guessed sum.
 */

import type { PoolInfo } from "@/lib/types";

/** Human RAID-level label (tokens-only consumers render this verbatim). */
export function levelLabel(level: PoolInfo["level"]): string {
  switch (level) {
    case "raid0":
      return "RAID 0";
    case "raid1":
      return "RAID 1";
    case "raid5":
      return "RAID 5";
    case "raid6":
      return "RAID 6";
    case "raid10":
      return "RAID 10";
    case "jbod":
      return "JBOD";
    default:
      return "Pool";
  }
}

/** One-line plain-language description of what a level does for the user. */
export function levelBlurb(level: PoolInfo["level"]): string {
  switch (level) {
    case "raid0":
      return "Striped for speed — no redundancy";
    case "raid1":
      return "Mirrored — survives one drive failing";
    case "raid5":
      return "Parity — survives one drive failing";
    case "raid6":
      return "Double parity — survives two drives failing";
    case "raid10":
      return "Mirrored + striped — fast and redundant";
    case "jbod":
      return "Spanned — no redundancy";
    default:
      return "";
  }
}

export interface PoolStatusBadge {
  label: string;
  /** Whether this status warrants the page-level degraded/rebuild banner. */
  alarm: "none" | "degraded" | "resyncing" | "failed";
}

export function poolStatusBadge(status: PoolInfo["status"]): PoolStatusBadge {
  switch (status) {
    case "active":
      return { label: "Healthy", alarm: "none" };
    case "resyncing":
      return { label: "Rebuilding", alarm: "resyncing" };
    case "degraded":
      return { label: "Degraded", alarm: "degraded" };
    case "failed":
      return { label: "Failed", alarm: "failed" };
    case "none":
    default:
      return { label: "Not configured", alarm: "none" };
  }
}

/** The single most-severe banner to show across all pools (or null). */
export function worstPoolAlarm(pools: PoolInfo[]): "degraded" | "resyncing" | "failed" | null {
  // Severity order: failed > degraded > resyncing.
  if (pools.some((p) => p.status === "failed")) return "failed";
  if (pools.some((p) => p.status === "degraded")) return "degraded";
  if (pools.some((p) => p.status === "resyncing")) return "resyncing";
  return null;
}
