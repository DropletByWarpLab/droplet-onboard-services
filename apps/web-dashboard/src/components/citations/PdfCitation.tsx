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
import { relevancePct } from "@/lib/relevance";

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
      className="overflow-hidden rounded-2xl"
      style={{ background: "var(--card-bg)", border: "1px solid var(--card-bd)" }}
      data-citation-kind="pdf-page"
    >
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{ borderBottom: "1px solid var(--card-bd)" }}
      >
        <Link
          href={detailHref}
          className="type-caption-1 truncate hover:underline text-[var(--text)]"
          title={hit.filename}
        >
          {hit.filename}
        </Link>
        <span className="type-caption-2 flex-shrink-0 text-[var(--text-muted)]">
          p.{anchor.page}
          {typeof hit.score === "number" && (
            <span className="ml-2">
              {relevancePct(hit.score, hit.scoreKind)}%
            </span>
          )}
        </span>
      </div>
      <iframe
        data-testid="pdf-iframe"
        src={src}
        title={`${hit.filename} — page ${anchor.page}`}
        className="w-full h-80 bg-[var(--surface)]"
      />
    </div>
  );
}
