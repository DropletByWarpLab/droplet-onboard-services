"use client";

/**
 * WARP-837 — the §6 safety chip, in the two tiers this surface can surface.
 *
 * The backend's analysis vocabulary is exactly "Read" | "Write · confirm"
 * (email-analysis.service.ts coerces to these). We render the full FEATURES §6
 * phrasing in the chip ("Read · stays on LAN" / "Write · confirm to apply") so
 * the meaning is legible.
 *
 * WARP-1088 — indigo shell: recolored onto the shared `.badge` language
 * (droplet-shell.css, same idiom as StatusChip.tsx and the /tools page's
 * Writes/Asks-first chips). `.badge.ok` / `.badge.warn` already carry
 * AA-contrast-safe label text on their tinted backgrounds, so the safety
 * meaning stays semantic — green for the read-only tier, amber for the
 * write-and-confirm tier — without a separate high-contrast text override.
 */

import { Eye, Pencil } from "lucide-react";
import type { ActionSafety } from "@/lib/types-email";

export function SafetyChip({ safety }: { safety: ActionSafety }) {
  const isWrite = safety === "Write · confirm";
  const label = isWrite ? "Write · confirm to apply" : "Read · stays on LAN";
  const Icon = isWrite ? Pencil : Eye;

  return (
    <span className={`badge ${isWrite ? "warn" : "ok"}`}>
      <Icon size={10} aria-hidden />
      {label}
    </span>
  );
}
