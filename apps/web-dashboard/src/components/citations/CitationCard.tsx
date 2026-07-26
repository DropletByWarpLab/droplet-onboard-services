"use client";

/**
 * WARP-287 — `<CitationCard>` is the canonical citation surface for any
 * indexed-file hit returned by `/api/files/knowledge/search` or
 * `/api/llm/chat`. It dispatches to a per-kind viewer based on the
 * `anchor` discriminator, so a PDF hit deep-links to a page, an audio
 * hit seeks to the timestamp, an email hit opens a modal with the
 * message part, and so on.
 *
 * Why dispatch here rather than at each call site:
 *   - The dashboard / chat surface only knows about `CitationHit`; the
 *     viewer-selection rule lives next to the components it routes to,
 *     not duplicated in every page.
 *   - The exhaustiveness `default: never` line makes new anchor kinds
 *     fail-fast at compile time. The runtime fall-through to
 *     `<FileCitation>` is the deploy-skew safety net: if a newer
 *     orchestrator ships an anchor kind this dashboard hasn't learned
 *     yet, we still render *something* the user can click.
 *   - Legacy chunks (anchor `null` or `kind: "none"`) collapse into
 *     `<FileCitation>` — the same chip the old `<CitationChip>` rendered,
 *     minus the source-vs-kind iconography.
 */

import type { Anchor } from "@droplet/shared-types";
import type { ScoreKind } from "@/lib/relevance";
import { PdfCitation } from "./PdfCitation";
import { MediaCitation } from "./MediaCitation";
import { EmailCitation } from "./EmailCitation";
import { ArchiveCitation } from "./ArchiveCitation";
import { FileCitation } from "./FileCitation";

/**
 * The minimum hit shape every citation viewer can consume. Call sites
 * (dashboard / chat) project their richer per-API hit shape down to
 * this DTO before handing it to `<CitationCard>`.
 */
export interface CitationHit {
  fileId: string;
  filename: string;
  mimeType: string;
  chunkText: string;
  /**
   * WARP-1603 — OPTIONAL on purpose. Every viewer that renders a percent
   * guards on `typeof hit.score === "number"` so a hit whose score didn't
   * survive extraction shows NO badge. Call sites must pass `undefined`
   * rather than coercing a missing score to `0` — a literal "0%" is a
   * factual claim about relevance that the pipeline never made.
   */
  score?: number;
  /**
   * WARP-1603 — the scale `score` is expressed in, when the call site
   * knows it. Omit to let `relevancePct` infer (see `lib/relevance.ts`);
   * absent is the correct value for any producer that doesn't tag its
   * payload yet, so this stays backward compatible.
   */
  scoreKind?: ScoreKind;
  anchor: Anchor | null;
  /**
   * WARP-859 — resolved click target for the fall-through `<FileCitation>`
   * chip. Lets the call site pick the right route per source instead of
   * always linking `/files/<fileId>`:
   *   - a string → use it verbatim (e.g. brain items →
   *     `/api/files/brain/<id>/download`),
   *   - `null`   → the hit has no routable target (a brain chunk whose
   *     brainItemId is missing — its stored path is an unroutable
   *     `/data/brain-memory/...` filesystem path), so render a plain,
   *     non-navigable chip rather than a 404 link,
   *   - `undefined` → legacy default `/files/<fileId>` (Nextcloud hits).
   */
  href?: string | null;
}

export interface CitationCardProps {
  hit: CitationHit;
}

export function CitationCard({ hit }: CitationCardProps): JSX.Element {
  const anchor = hit.anchor;
  if (!anchor) return <FileCitation hit={hit} />;
  switch (anchor.kind) {
    case "pdf-page":
      return <PdfCitation hit={hit} anchor={anchor} />;
    case "media-timestamp":
      return <MediaCitation hit={hit} anchor={anchor} />;
    case "email-part":
      return <EmailCitation hit={hit} anchor={anchor} />;
    case "archive-member":
      return <ArchiveCitation hit={hit} anchor={anchor} />;
    case "none":
      return <FileCitation hit={hit} />;
    default: {
      // Compile-time exhaustiveness check + runtime deploy-skew fallback:
      // a future anchor kind shipped by a newer orchestrator should still
      // render something the user can click.
      const _exhaustive: never = anchor;
      void _exhaustive;
      return <FileCitation hit={hit} />;
    }
  }
}
