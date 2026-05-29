"use client";

/**
 * PDF deep-link viewer. The `pdf-page` anchor carries a 1-based page
 * number; we surface it via the standard `#page=N` PDF URL fragment
 * which Chrome / Firefox / pdf.js / Safari (with the built-in viewer)
 * all honor for native scroll-to-page on first load.
 *
 * The wrapping card renders a thin header with the filename + page
 * badge and the iframe inline so the citation reads as a self-
 * contained preview. Click-through to the full file detail page lives
 * on the filename header for users who want the full UI.
 */

import Link from "next/link";
import type { PdfPageAnchor } from "@droplet/shared-types";
import type { CitationHit } from "./CitationCard";

export interface PdfCitationProps {
  hit: CitationHit;
  anchor: PdfPageAnchor;
}

export function PdfCitation({ hit, anchor }: PdfCitationProps): JSX.Element {
  // Stream the file content via the orchestrator's authenticated download
  // endpoint. The `#page=N` fragment is the de-facto PDF deep-link
  // convention; viewers that don't support it just open at page 1.
  const src = `/api/files/${encodeURIComponent(hit.fileId)}/content#page=${anchor.page}`;
  const detailHref = `/files/${encodeURIComponent(hit.fileId)}`;
  return (
    <div
      className="dp-card overflow-hidden"
      data-citation-kind="pdf-page"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-separator">
        <Link
          href={detailHref}
          className="type-caption-1 text-label-primary truncate hover:underline"
          title={hit.filename}
        >
          {hit.filename}
        </Link>
        <span className="type-caption-2 text-label-tertiary flex-shrink-0">
          p.{anchor.page}
          {typeof hit.score === "number" && (
            <span className="ml-2">{Math.round(hit.score * 100)}%</span>
          )}
        </span>
      </div>
      <iframe
        data-testid="pdf-iframe"
        src={src}
        title={`${hit.filename} — page ${anchor.page}`}
        className="w-full h-80 bg-surface-primary"
      />
    </div>
  );
}
