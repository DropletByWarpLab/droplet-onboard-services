"use client";

/**
 * Safety chip — the Read/Write/Setup tier markers from the design brief §10.
 * Rendered with the GLOBAL design tokens (type-*, tailwind color tokens) so it
 * works both inside ShellPage (.droplet-shell) and inside a portaled Dialog.
 *
 * The chip is load-bearing, not decoration: it tells the user whether a surface
 * only reads (and that the data stays on their network) or is about to write.
 */

import { ShieldCheck, Lock, PlugZap } from "lucide-react";

export type SafetyVariant = "read-lan" | "read-phi" | "write" | "setup";

const COPY: Record<SafetyVariant, string> = {
  "read-lan": "Read · stays on LAN",
  "read-phi": "Read · PHI · stays on LAN",
  write: "Write · confirm to apply",
  setup: "Setup · stays on your box",
};

export function SafetyChip({
  variant,
  className = "",
}: {
  variant: SafetyVariant;
  className?: string;
}) {
  const isWrite = variant === "write";
  const Icon = isWrite ? PlugZap : variant === "setup" ? Lock : ShieldCheck;
  const tone = isWrite
    ? "text-accent bg-accent-subtle border-accent/25"
    : "text-label-secondary bg-surface-primary border-separator";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 type-caption-1 whitespace-nowrap ${tone} ${className}`}
    >
      <Icon size={12} strokeWidth={1.75} aria-hidden />
      {COPY[variant]}
    </span>
  );
}
