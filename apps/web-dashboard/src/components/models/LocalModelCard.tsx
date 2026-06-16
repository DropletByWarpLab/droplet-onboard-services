"use client";

/**
 * WARP-836 — one local LLM card on the Models page (rendered 2-up).
 *
 * Status-only (one-model rule, architecture-guard #13): there are NO
 * pull/swap/benchmark/delete controls — the card is purely informational.
 * Metrics the backend doesn't report yet (gbOnDisk, role, tokensPerSec,
 * diskBarPct) render as an honest "—", never a fabricated value. The status
 * chip maps the backend lifecycle enum to home-user language:
 * ready → "running", loading → "loading", error → "error".
 */

import { BookOpen, Cpu, Gauge, HardDrive, ShieldCheck } from "lucide-react";
import type { LocalModelRow } from "@/lib/types";

const DASH = "—";

/** Humanise a context window: 131072 → "128k", 8192 → "8k", small → exact. */
function formatContext(tokens: number | null): string {
  if (tokens == null) return DASH;
  if (tokens >= 1000) {
    const k = tokens / 1024;
    // Show "128k" for clean powers, otherwise one decimal ("65.5k").
    const rounded = Number.isInteger(k) ? String(k) : k.toFixed(1);
    return `${rounded}k`;
  }
  return String(tokens);
}

/** Visual mapping for each lifecycle status. `label` is the home-user word. */
const STATUS_META: Record<
  LocalModelRow["status"],
  { label: string; dot: string; text: string; tint: string }
> = {
  ready: {
    label: "running",
    dot: "bg-system-green",
    text: "text-system-green",
    tint: "bg-system-green/15",
  },
  loading: {
    label: "loading",
    dot: "bg-system-orange",
    text: "text-system-orange",
    tint: "bg-system-orange/15",
  },
  error: {
    label: "error",
    dot: "bg-system-red",
    text: "text-system-red",
    tint: "bg-system-red/15",
  },
};

export function LocalModelCard({ model }: { model: LocalModelRow }) {
  const status = STATUS_META[model.status];
  const gb = model.gbOnDisk != null ? `${model.gbOnDisk} GB on disk` : DASH;
  const rate =
    model.tokensPerSec != null ? `${model.tokensPerSec} tok/s` : DASH;
  const hasMeter = model.diskBarPct != null;

  return (
    <div className="dp-card p-4 flex flex-col gap-3.5">
      {/* Header: glyph · name + family · status chip */}
      <div className="flex items-start gap-2.5">
        <span
          className="
            w-8 h-8 rounded-md bg-accent-subtle text-accent
            flex items-center justify-center flex-shrink-0
          "
          aria-hidden
        >
          <Cpu size={18} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <h3 className="type-subheadline text-label-primary font-medium truncate">
            {model.name}
          </h3>
          <p className="type-caption-1 text-label-tertiary truncate">
            {model.family}
            {model.role ? ` · ${model.role}` : ""}
          </p>
        </div>
        <span
          className={`
            inline-flex items-center gap-1.5 h-6 px-2 rounded-full
            type-caption-2 font-medium text-label-primary ${status.tint}
          `}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} aria-hidden />
          {status.label}
        </span>
      </div>

      {/* On-disk usage meter — only when the backend reports a percentage.
          Otherwise we say so plainly rather than draw an empty/zero bar. */}
      {hasMeter ? (
        <div
          className="h-1.5 rounded-full bg-surface-secondary overflow-hidden"
          role="progressbar"
          aria-label="On-disk usage"
          aria-valuenow={model.diskBarPct ?? undefined}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{ width: `${Math.min(100, Math.max(0, model.diskBarPct!))}%` }}
          />
        </div>
      ) : (
        <p className="type-caption-2 text-label-quaternary">
          On-disk usage not available yet
        </p>
      )}

      {/* Foot stats — on-disk GB and a tokens/sec sample, both honest about
          missing data, plus the always-true "local-only" reassurance. */}
      <div className="flex items-center gap-4 type-caption-1 text-label-tertiary">
        <span className="inline-flex items-center gap-1">
          <HardDrive size={12} strokeWidth={2} aria-hidden />
          <span className="tabular-nums">{gb}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <Gauge size={12} strokeWidth={2} aria-hidden />
          <span className="tabular-nums">{rate}</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <BookOpen size={12} strokeWidth={2} aria-hidden />
          <span className="tabular-nums">ctx {formatContext(model.contextLength)}</span>
        </span>
        <span className="inline-flex items-center gap-1 ml-auto text-label-secondary">
          <ShieldCheck size={12} strokeWidth={2} aria-hidden />
          local-only
        </span>
      </div>
    </div>
  );
}
