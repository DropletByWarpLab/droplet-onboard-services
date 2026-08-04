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
 * role → icon + plain label. `unknown` falls back to "Open" (per the design):
 * a port with no recognised device reads as an open port, not an error.
 */
export const ROLE: Record<SwitchPortRole, { Icon: LucideIcon; label: string }> = {
  ap: { Icon: Wifi, label: "AP" },
  camera: { Icon: Video, label: "Camera" },
  client: { Icon: Laptop, label: "Client" },
  uplink: { Icon: ArrowUp, label: "Uplink" },
  unknown: { Icon: Network, label: "Open" },
};

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

/** Friendly name with the design's fallback chain. */
export function portName(name: string | null | undefined): string {
  return name && name.trim().length > 0 ? name : "Open";
}

/** Clamp a 0..1 ratio to a 0..100 width percentage. */
export function pct(value: number, max: number): number {
  if (!max || max <= 0) return 0;
  return Math.max(0, Math.min(100, (value / max) * 100));
}
