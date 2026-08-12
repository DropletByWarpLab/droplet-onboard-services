"use client";

/**
 * Email message-part viewer. The `email-part` anchor carries the
 * RFC-5322 `Message-Id` and the 0-based index of the MIME part the
 * chunk came from (body vs. each attachment). Clicking the card opens
 * a lightweight modal with the chunk text + part metadata; the
 * orchestrator currently doesn't ship a full message reconstruction
 * endpoint, so this is the smallest useful surface — enough for the
 * user to confirm *which* email is being cited.
 *
 * WARP-1875 — that modal PORTALS to document.body. A citation renders wherever
 * an answer renders, and on Home that is inside a `.bento` widget shell, which
 * is now a query container (`container-type: inline-size`, home-bento.css).
 * Inline-size containment implies `contain: layout`, which makes the tile a
 * containing block for `position: fixed` descendants — so rendered in place
 * the backdrop would have resolved `inset: 0` against a ~240px tile and then
 * been clipped by its `overflow: hidden`, instead of covering the viewport.
 * Same escape hatch, same reason, as the <Dialog> primitive.
 */

import { useState } from "react";
import { createPortal } from "react-dom";
import { Mail } from "lucide-react";
import type { EmailPartAnchor } from "@droplet/shared-types";
import type { CitationHit } from "./CitationCard";
// Portal-mounted to document.body, OUTSIDE any page scope, so the backdrop
// carries the `droplet-shell` class itself and imports the tokens it reads
// (`--scrim`, `--card-bg`, `--card-bd`, `--lift`) — the WARP-1079 pattern the
// <Dialog> primitive documents.
import "@/components/shell/indigo-tokens.css";

export interface EmailCitationProps {
  hit: CitationHit;
  anchor: EmailPartAnchor;
}

export function EmailCitation({ hit, anchor }: EmailCitationProps): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid="email-card"
        data-citation-kind="email-part"
        title={hit.chunkText}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-md type-caption-1 border text-left transition-colors duration-150 max-w-full bg-[var(--card-inner)] text-[var(--text)] border-[var(--card-bd)] hover:bg-[var(--hover)]"
      >
        <Mail size={14} className="flex-shrink-0 text-[var(--brand-soft)]" />
        <span className="flex flex-col min-w-0">
          <span className="truncate">{hit.filename}</span>
          <span className="type-caption-2 truncate" style={{ color: "var(--text-muted)" }}>
            part #{anchor.partIndex} · {anchor.messageId}
          </span>
        </span>
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Email citation"
          className="droplet-shell fixed inset-0 z-50 flex items-center justify-center"
          style={{ position: "fixed", background: "var(--scrim)" }}
          onClick={() => setOpen(false)}
        >
          <div
            className="max-w-xl w-full m-4 p-4"
            style={{
              background: "var(--card-bg)",
              border: "1px solid var(--card-bd)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--lift)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between mb-2">
              <h2 className="type-subheadline truncate" style={{ color: "var(--text)" }}>
                {hit.filename}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="type-caption-1 text-[var(--text-muted)] hover:text-[var(--text)]"
                aria-label="Close"
              >
                ✕
              </button>
            </header>
            <dl className="type-caption-1 space-y-1 mb-3" style={{ color: "var(--text-muted)" }}>
              <div className="flex gap-2">
                <dt style={{ color: "var(--text-muted)" }}>Message-Id:</dt>
                {/* WARP-1153: min-w-0 so a long Message-Id truncates instead
                    of widening the card past max-w-xl. */}
                <dd className="font-mono truncate min-w-0">{anchor.messageId}</dd>
              </div>
              <div className="flex gap-2">
                <dt style={{ color: "var(--text-muted)" }}>Part:</dt>
                <dd>#{anchor.partIndex}</dd>
              </div>
            </dl>
            <p className="type-body whitespace-pre-wrap" style={{ color: "var(--text)" }}>
              {hit.chunkText}
            </p>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
