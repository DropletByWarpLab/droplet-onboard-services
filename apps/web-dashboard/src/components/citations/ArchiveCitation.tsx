"use client";

/**
 * Archive-member viewer. The `archive-member` anchor names a member
 * path inside the carrier (zip/tar/email-with-attachments/...). If the
 * extractor recursed *into* that member (e.g. a PDF inside the zip),
 * it set `innerAnchor` to the per-member anchor; we render the
 * resulting deep-link by recursing back through `<CitationCard>` with
 * the inner anchor projected onto the *same* hit. That keeps the
 * dispatch rule (anchor.kind → component) in exactly one place.
 *
 * Recursion is bounded by `MAX_ARCHIVE_ANCHOR_DEPTH` at the extractor
 * layer (currently 3), so a runaway chain can't unwind here.
 */

import { Archive } from "lucide-react";
import type { ArchiveMemberAnchor } from "@droplet/shared-types";
import type { CitationHit } from "./CitationCard";
import { CitationCard } from "./CitationCard";

export interface ArchiveCitationProps {
  hit: CitationHit;
  anchor: ArchiveMemberAnchor;
}

export function ArchiveCitation({ hit, anchor }: ArchiveCitationProps): JSX.Element {
  const hasInner =
    anchor.innerAnchor != null && anchor.innerAnchor.kind !== "none";
  return (
    <div
      className="dp-card p-3 space-y-2"
      data-testid="archive-card"
      data-citation-kind="archive-member"
    >
      <header className="flex items-center gap-2">
        <Archive size={14} className="flex-shrink-0 text-label-tertiary" />
        <div className="min-w-0 flex-1">
          <p className="type-caption-1 text-label-primary truncate">
            {hit.filename}
          </p>
          <p className="type-caption-2 text-label-tertiary truncate" title={anchor.member}>
            {anchor.member}
          </p>
        </div>
        {typeof hit.score === "number" && (
          <span className="type-caption-2 text-label-tertiary flex-shrink-0">
            {Math.round(hit.score * 100)}%
          </span>
        )}
      </header>
      {hasInner && (
        // Project the inner anchor onto the same hit so the per-kind
        // viewer (PDF page, audio timestamp, ...) handles the actual
        // deep-link. The carrier just supplies the lineage breadcrumb.
        <div className="pl-5 border-l border-separator">
          <CitationCard
            hit={{ ...hit, anchor: anchor.innerAnchor ?? null }}
          />
        </div>
      )}
    </div>
  );
}
