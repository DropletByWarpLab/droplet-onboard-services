"use client";

import {
  Wifi,
  Video,
  Laptop,
  ArrowUp,
  Network,
  type LucideIcon,
} from "lucide-react";
import type { SwitchPort, SwitchPortRole, SwitchPortStatus } from "@/lib/types/switch";

/**
 * A pending Tier-2 write, surfaced to the confirm dialog. `what` is the
 * question title, `blast` the blast-radius sentence, and the typed payload
 * (vlanId / enabled) is what the panel passes to the matching useSwitch
 * action once the user confirms. `provision` carries no port.
 */
export type SwitchAction =
  | { kind: "vlan"; port: SwitchPort; vlanId: number; what: string; blast: string }
  | { kind: "poe"; port: SwitchPort; enabled: boolean; what: string; blast: string }
  | { kind: "enable"; port: SwitchPort; enabled: boolean; what: string; blast: string }
  | { kind: "provision"; what: string; blast: string };

/**
 * role → icon + plain label.
 *
 * WARP-1716: `unknown` used to read "Open", which is a claim about the CABLE,
 * not about the role — so a port with link up, PoE delivering and traffic
 * flowing still announced itself as open. The role map now says only what it
 * knows ("Unknown"); whether the port is open is decided by link state, in
 * `roleLabel` / `portName` below.
 */
export const ROLE: Record<SwitchPortRole, { Icon: LucideIcon; label: string }> = {
  ap: { Icon: Wifi, label: "AP" },
  camera: { Icon: Video, label: "Camera" },
  client: { Icon: Laptop, label: "Client" },
  uplink: { Icon: ArrowUp, label: "Uplink" },
  unknown: { Icon: Network, label: "Unknown" },
};

/**
 * Role chip text. An unresolved role is reported by LINK state, because that's
 * the fact we actually hold: a dark port is genuinely open, a lit one is
 * carrying something we haven't identified yet — never "Open".
 */
export function roleLabel(p: Pick<SwitchPort, "role" | "link_up">): string {
  if (p.role !== "unknown") return ROLE[p.role].label;
  return p.link_up ? "Connected" : "Open";
}

/**
 * Map the §7 port status to the existing §2.6 status-chip tone.
 *   online → ok (green) · warn → warn (orange) · offline → neutral ·
 *   blocked → err (red).
 */
export const STATUS_TONE: Record<SwitchPortStatus, "ok" | "warn" | "neutral" | "err"> = {
  online: "ok",
  warn: "warn",
  offline: "neutral",
  blocked: "err",
};

/** Tailwind chip classes per tone — token colors only, never literal hex. */
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

/** "5.2 W" / "off" / "—" — mono wattage, best-effort. */
export function formatWatts(power_w: number): string {
  return `${power_w.toFixed(1)} W`;
}

/**
 * Friendly port name, in the order of what we actually know (WARP-1716).
 *
 *   1. the joined device's name       — "Living-room AP"
 *   2. the port's own friendly name   — operator-set / provisioned
 *   3. link up but unidentified       — "In use"
 *   4. no link                        — "Open"
 *
 * The old signature took the bare name and answered "Open" for anything empty,
 * so every port on a switch that had never been auto-provisioned — which is
 * every port, since the backend hardcoded `name: null` — claimed to be open
 * while carrying traffic.
 */
export function portName(p: Pick<SwitchPort, "name" | "link_up" | "device">): string {
  const deviceName = p.device?.name;
  if (deviceName && deviceName.trim().length > 0) return deviceName;
  if (p.name && p.name.trim().length > 0) return p.name;
  return p.link_up ? "In use" : "Open";
}

/** Bytes → "1.4 GB" / "820 MB" / "0 B". Best-effort, one decimal above MB. */
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

/** Clamp a 0..1 ratio to a 0..100 width percentage. */
export function pct(value: number, max: number): number {
  if (!max || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}
