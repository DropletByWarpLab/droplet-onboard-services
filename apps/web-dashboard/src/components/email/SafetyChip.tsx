"use client";

/**
 * WARP-837 — the §6 safety chip, in the two tiers this surface can surface.
 *
 * The backend's analysis vocabulary is exactly "Read" | "Write · confirm"
 * (email-analysis.service.ts coerces to these). We render the full FEATURES §6
 * phrasing in the chip ("Read · stays on LAN" / "Write · confirm to apply") so
 * the meaning is legible, while the contract value drives the tier.
 *
 * Color carries a hint; the high-contrast label text carries the meaning (the
 * shipped tinted-text tokens fail AA at caption size — same lesson as the Tools
 * page badges), so the LABEL always uses label-primary.
 */

import { Eye, Pencil } from "lucide-react";
import type { ActionSafety } from "@/lib/types-email";

export function SafetyChip({ safety }: { safety: ActionSafety }) {
  const isWrite = safety === "Write · confirm";
  const label = isWrite ? "Write · confirm to apply" : "Read · stays on LAN";
  const Icon = isWrite ? Pencil : Eye;
  const tint = isWrite ? "bg-system-orange/15" : "bg-system-green/15";
  const iconColor = isWrite ? "text-system-orange" : "text-system-green";

  return (
    <span
      className={`inline-flex items-center gap-1 h-5 px-1.5 rounded-full type-caption-2 font-medium text-label-primary ${tint}`}
    >
      <span className={iconColor}>
        <Icon size={10} aria-hidden />
      </span>
      {label}
    </span>
  );
}
