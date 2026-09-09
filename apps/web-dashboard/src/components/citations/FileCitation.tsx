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
import { relevancePct } from "@/lib/relevance";

import type { JSX } from "react";

export interface FileCitationProps {
  hit: CitationHit;
}

export function FileCitation({ hit }: FileCitationProps): JSX.Element {
  const Icon = iconForMime(hit.mimeType);
  // WARP-859 — pick the click target per the resolved `href`:
  //   undefined → legacy default `/files/<fileId>` (Nextcloud),
  //   string    → use it (brain items → `/api/files/brain/<id>/download`),
  //   null      → no routable target → render a non-link chip (the old
  //               code linked `/files/<absolute-brain-path>` which 404'd).
  const href =
    hit.href === undefined
      ? `/files/${encodeURIComponent(hit.fileId)}`
      : hit.href;

  const inner = (
    <>
      <Icon size={12} className="flex-shrink-0" />
      <span className="truncate">{hit.filename}</span>
      {typeof hit.score === "number" && (
        <span className="type-caption-2 flex-shrink-0 text-[var(--text-muted)]">
          {relevancePct(hit.score, hit.scoreKind)}%
        </span>
      )}
    </>
  );

  const className = `
    inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md
    type-caption-1 border transition-colors duration-150
    max-w-[18rem] truncate
    bg-[var(--card-inner)] text-[var(--text-muted)] border-[var(--card-bd)]
    hover:bg-[var(--hover)] hover:text-[var(--text)]
  `;

  if (!href) {
    return (
      <span
        title={hit.chunkText}
        data-testid="file-card"
        data-citation-kind="file"
        className={`${className} cursor-default hover:bg-[var(--card-inner)] hover:text-[var(--text-muted)]`}
      >
        {inner}
      </span>
    );
  }

  return (
    <Link
      href={href}
      title={hit.chunkText}
      data-testid="file-card"
      data-citation-kind="file"
      className={className}
    >
      {inner}
    </Link>
  );
}
