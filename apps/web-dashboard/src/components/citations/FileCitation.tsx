"use client";

/**
 * Legacy / fall-through citation viewer. Used when:
 *   - The chunk pre-dates WARP-287 (no anchor recorded).
 *   - The anchor is explicitly `kind: "none"` (extractor opted out).
 *   - The dashboard sees an anchor kind it doesn't recognise yet
 *     (deploy skew between orchestrator and dashboard).
 *
 * Rendered as a compact link-chip that lands the user on the file's
 * detail page so they can still re-index or open the file manually.
 */

import Link from "next/link";
import { iconForMime } from "@/lib/mime-icons";
import type { CitationHit } from "./CitationCard";

export interface FileCitationProps {
  hit: CitationHit;
}

export function FileCitation({ hit }: FileCitationProps): JSX.Element {
  const Icon = iconForMime(hit.mimeType);
  const href = `/files/${encodeURIComponent(hit.fileId)}`;
  return (
    <Link
      href={href}
      title={hit.chunkText}
      data-testid="file-card"
      data-citation-kind="file"
      className="
        inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md
        type-caption-1 border transition-colors duration-150
        max-w-[18rem] truncate
        bg-surface-secondary text-label-secondary border-separator
        hover:bg-surface-tertiary hover:text-label-primary
      "
    >
      <Icon size={12} className="flex-shrink-0" />
      <span className="truncate">{hit.filename}</span>
      {typeof hit.score === "number" && (
        <span className="type-caption-2 text-label-tertiary flex-shrink-0">
          {Math.round(hit.score * 100)}%
        </span>
      )}
    </Link>
  );
}
