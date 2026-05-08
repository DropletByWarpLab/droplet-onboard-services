"use client";

/**
 * Shared citation chip — used by both the chat surface (when an LLM
 * tool returns retrieval hits) and the /knowledge dashboard view's
 * Search tab. Rendering them through the same component is what
 * keeps the two surfaces visually consistent without manual sync.
 *
 * The chip is intentionally agnostic about what it links to: brain
 * hits get a Sparkles icon and link to `/knowledge?tab=brain`,
 * Nextcloud hits get a FileText icon and link to the parent dir in
 * the Files page. Page numbers + similarity scores render when present.
 */

import Link from "next/link";
import { FileText, Sparkles } from "lucide-react";
import { iconForMime, mimeFromPath } from "@/lib/mime-icons";

export interface CitationChipProps {
  source: "nextcloud" | "brain";
  path: string;
  pageNumber?: number | null;
  score?: number;
  brainItemId?: string | null;
  /** Optional snippet shown on hover (title attr) so the chip can stay compact. */
  snippet?: string;
  /** Override the click-through URL — defaults to a sensible per-source destination. */
  href?: string;
  /**
   * WARP-214: when provided, the chip uses the Lucide icon mapped from this
   * MIME via `iconForMime`. When omitted, falls back to the source-based
   * Sparkles/FileText choice (preserving pre-WARP-214 behavior).
   */
  mimeType?: string;
}

function defaultHref(props: CitationChipProps): string {
  if (props.href) return props.href;
  if (props.source === "brain") {
    return props.brainItemId
      ? `/knowledge?tab=brain&item=${encodeURIComponent(props.brainItemId)}`
      : `/knowledge?tab=brain`;
  }
  // Nextcloud: link to the parent directory so the user lands in the
  // Files page with the file in view.
  const parent = props.path.replace(/\/[^/]*$/, "") || "/";
  return `/files?path=${encodeURIComponent(parent)}`;
}

export function CitationChip(props: CitationChipProps) {
  const { source, path, pageNumber, score, snippet, mimeType } = props;
  const fileName = path.split("/").pop() || path;
  // WARP-214: prefer the explicit MIME the caller hands us; fall back to
  // path-derived MIME so the dashboard's RecentlyIndexed/Search surfaces
  // still get a meaningful icon when the orchestrator only carries the
  // path. Only when neither yields a hit do we fall back to the legacy
  // source-based Sparkles/FileText choice.
  let Icon = source === "brain" ? Sparkles : FileText;
  if (mimeType) {
    Icon = iconForMime(mimeType);
  } else {
    const guessed = mimeFromPath(path);
    if (guessed !== "application/octet-stream") {
      Icon = iconForMime(guessed);
    }
  }
  const tone =
    source === "brain"
      ? "bg-accent-subtle text-accent border-accent/20 hover:bg-accent/15"
      : "bg-surface-secondary text-label-secondary border-separator hover:bg-surface-tertiary hover:text-label-primary";

  return (
    <Link
      href={defaultHref(props)}
      title={snippet ? snippet : path}
      className={`
        inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md
        type-caption-1 border transition-colors duration-150
        max-w-[18rem] truncate
        ${tone}
      `}
      data-citation-source={source}
      data-citation-path={path}
    >
      <Icon size={12} className="flex-shrink-0" />
      <span className="truncate">{fileName}</span>
      {pageNumber != null && (
        <span className="type-caption-2 text-label-tertiary flex-shrink-0">
          p.{pageNumber}
        </span>
      )}
      {typeof score === "number" && (
        <span className="type-caption-2 text-label-tertiary flex-shrink-0">
          {Math.round(score * 100)}%
        </span>
      )}
    </Link>
  );
}
