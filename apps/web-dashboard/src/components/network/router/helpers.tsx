"use client";

import { Globe, Network, Radio, Cable, CircleDashed, type LucideIcon } from "lucide-react";
import type { RouterPort, RouterPortRole, RouterPortStatus } from "@/lib/types/router-ports";

/**
 * Router port-map helpers (WARP-1866).
 *
 * The chip/tone vocabulary is deliberately the same as the switch panel's
 * (`../switch/helpers`) so the two port maps on the Network tab read as one
 * system — but the *values* differ, because a router port has states a switch
 * port doesn't (`absent`) and lacks ones it does (PoE). Those are re-declared
 * here rather than widened over there: a shared map keyed by the union of both
 * vocabularies would let a switch port claim a status it can never have.
 */

/** role → icon + plain label. `unused` is a real answer, not a fallback. */
export const ROLE: Record<RouterPortRole, { Icon: LucideIcon; label: string }> = {
  wan: { Icon: Globe, label: "Internet" },
  lan: { Icon: Network, label: "LAN" },
  guest: { Icon: Radio, label: "Guest" },
  other: { Icon: Cable, label: "Other" },
  unused: { Icon: CircleDashed, label: "Unused" },
};

export const STATUS_TONE: Record<RouterPortStatus, "ok" | "warn" | "neutral" | "err"> = {
  online: "ok",
  offline: "neutral",
  disabled: "err",
  // Not a fault — we simply have no reading. Neutral, and the label says so.
  absent: "neutral",
};

export const STATUS_LABEL: Record<RouterPortStatus, string> = {
  online: "up",
  offline: "empty",
  disabled: "disabled",
  absent: "no module",
};

export const CHIP_CLASS: Record<"ok" | "warn" | "neutral" | "err", string> = {
  ok: "bg-system-green/10 text-system-green",
  warn: "bg-system-orange/10 text-system-orange",
  neutral: "bg-[var(--card-inner)] text-[color:var(--text-muted)]",
  err: "bg-system-red/10 text-system-red",
};

export const DOT_CLASS: Record<"ok" | "warn" | "neutral" | "err", string> = {
  ok: "bg-system-green",
  warn: "bg-system-orange",
  neutral: "bg-[var(--text-faint)]",
  err: "bg-system-red",
};

/**
 * The friendly line for a port, in the order of what we actually know.
 *
 * Never "Open" for a port we haven't measured: an empty SFP cage reports no
 * netifd device at all, and calling that "Open" claims we looked at the cable
 * and found none. It gets "No module" — the honest description of a cage with
 * nothing in it. This is the same lesson WARP-1716 cost on the switch panel,
 * where unmeasured ports announced themselves as open while carrying traffic.
 */
export function portName(p: Pick<RouterPort, "role" | "link_up" | "present" | "is_sfp" | "status">): string {
  if (!p.present) return p.is_sfp ? "No module" : "Not present";
  if (p.status === "disabled") return "Disabled";
  if (p.role !== "unused") return ROLE[p.role].label;
  return p.link_up ? "In use" : "Open";
}

/** "lan · guest" — every interface whose traffic reaches this jack. */
export function networksLabel(p: Pick<RouterPort, "networks">): string {
  return p.networks.length > 0 ? p.networks.join(" · ") : "—";
}

/** Bytes → "1.4 GB" / "820 MB" / "0 B". Mirrors the switch panel's formatter. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit >= 3 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** "3 of 9 ports connected" — the one-line summary in the panel header. */
export function linkSummary(ports: RouterPort[]): string {
  const linked = ports.filter((p) => p.link_up).length;
  return `${linked} of ${ports.length} port${ports.length === 1 ? "" : "s"} connected`;
}
