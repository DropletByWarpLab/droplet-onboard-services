"use client";

/**
 * WARP-225 — home-page tile.
 *
 * Compact (~320×140 ish, but flexes to its grid cell), animated counter
 * on the file count, status pill (green / amber / red per spec's 4-color
 * palette), and a strip of category icons brightness-graded by share of
 * total. Click anywhere → /context.
 *
 * Skeleton render for the first paint; never a spinner per the spec
 * polish bar. Pulsing live-dot indicates polling is active.
 */

import Link from "next/link";
import { ArrowRight, AlertTriangle, Check, Clock } from "lucide-react";
import { useContextStatsSummary } from "@/lib/hooks/useContextStats";
import { AnimatedCounter } from "./AnimatedCounter";
import { iconForCategory, labelForCategory } from "@/lib/category-icons";
import type { MimeCategory } from "@/lib/types-context-stats";

const CATEGORIES_FOR_STRIP: MimeCategory[] = [
  "image",
  "audio",
  "video",
  "text",
  "pdf",
  "email",
  "archive",
];

export function ContextWidget() {
  const { summary, isLoading, error } = useContextStatsSummary();

  if (isLoading && !summary) {
    return (
      <Link
        href="/context"
        className="dp-tile dp-tile-interactive p-6 flex flex-col gap-4 group min-h-[140px]"
        aria-label="Loading your AI context"
      >
        <div className="flex items-center justify-between">
          <div className="h-3 w-32 rounded bg-surface-secondary animate-pulse" />
          <div className="h-3 w-3 rounded bg-surface-secondary animate-pulse" />
        </div>
        <div className="h-8 w-40 rounded bg-surface-secondary animate-pulse" />
        <div className="h-3 w-48 rounded bg-surface-secondary animate-pulse" />
      </Link>
    );
  }

  // Error tile — never blocks; surfaces a tile-shaped fallback so the
  // home grid layout doesn't shift.
  if (error || !summary) {
    return (
      <Link
        href="/context"
        className="dp-tile dp-tile-interactive p-6 flex flex-col gap-3 group min-h-[140px]"
      >
        <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
          Your AI&apos;s Context
        </p>
        <p className="type-footnote text-label-tertiary">
          Couldn&apos;t reach the context service.
        </p>
      </Link>
    );
  }

  const allReady = summary.queued === 0 && summary.failed === 0;
  const StatusIcon = summary.failed > 0
    ? AlertTriangle
    : summary.queued > 0
      ? Clock
      : Check;
  const statusTone = summary.failed > 0
    ? "text-system-red"
    : summary.queued > 0
      ? "text-system-orange"
      : "text-system-green";

  // Source-icon strip — brightness-graded by share-of-total across the
  // recently-indexed list. Categories with zero items get a faded icon
  // so the strip width stays consistent (the eye reads "covered all
  // sources, varying density").
  const totalRecent = summary.recentlyIndexed.length || 1;
  const counts = new Map<MimeCategory, number>();
  for (const r of summary.recentlyIndexed) {
    counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  }

  return (
    <Link
      href="/context"
      className="dp-tile dp-tile-interactive p-6 flex flex-col gap-4 group min-h-[140px]"
      data-testid="context-widget"
    >
      <div className="flex items-center justify-between">
        <p className="type-caption-1 text-label-tertiary uppercase tracking-[0.18em]">
          Your AI&apos;s Context
        </p>
        <div className="flex items-center gap-2 type-caption-1 text-label-tertiary">
          <span
            aria-hidden
            className="w-1.5 h-1.5 rounded-full bg-system-green animate-pulse"
            title="Live — polling every 30s"
          />
          <ArrowRight
            size={14}
            className="text-label-tertiary group-hover:text-accent group-hover:translate-x-0.5 transition-all"
          />
        </div>
      </div>

      <div className="flex items-baseline gap-3">
        <AnimatedCounter
          value={summary.files}
          className="type-display text-label-primary text-4xl font-semibold"
        />
        <span className="type-subheadline text-label-secondary">
          {summary.files === 1 ? "file indexed" : "files indexed"}
        </span>
      </div>

      <div className="flex items-center justify-between gap-3">
        <p className="type-footnote text-label-secondary">
          <AnimatedCounter
            value={summary.chunks}
            className="text-label-primary font-medium"
          />{" "}
          chunks searchable
        </p>
        <span
          className={`inline-flex items-center gap-1.5 type-caption-1 ${statusTone}`}
        >
          <StatusIcon size={12} />
          {allReady ? (
            "All ready"
          ) : (
            <>
              {summary.queued > 0 && `${summary.queued} queued`}
              {summary.queued > 0 && summary.failed > 0 && " · "}
              {summary.failed > 0 && `${summary.failed} failed`}
            </>
          )}
        </span>
      </div>

      <div className="flex items-center gap-2 pt-1 border-t border-separator">
        {CATEGORIES_FOR_STRIP.map((cat) => {
          const Icon = iconForCategory(cat);
          const count = counts.get(cat) ?? 0;
          const intensity = count === 0 ? 0.25 : 0.6 + (count / totalRecent) * 0.4;
          return (
            <span
              key={cat}
              title={`${labelForCategory(cat)}: ${count} recent`}
              style={{ opacity: intensity }}
            >
              <Icon size={14} className="text-label-secondary" />
            </span>
          );
        })}
      </div>
    </Link>
  );
}
