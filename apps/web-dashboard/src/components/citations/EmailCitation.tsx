"use client";

/**
 * Email message-part viewer. The `email-part` anchor carries the
 * RFC-5322 `Message-Id` and the 0-based index of the MIME part the
 * chunk came from (body vs. each attachment). Clicking the card opens
 * a lightweight modal with the chunk text + part metadata; the
 * orchestrator currently doesn't ship a full message reconstruction
 * endpoint, so this is the smallest useful surface — enough for the
 * user to confirm *which* email is being cited.
 */

import { useState } from "react";
import { Mail } from "lucide-react";
import type { EmailPartAnchor } from "@droplet/shared-types";
import type { CitationHit } from "./CitationCard";

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
        className="
          inline-flex items-center gap-2 px-3 py-2 rounded-md
          type-caption-1 border text-left transition-colors duration-150
          max-w-full
          bg-surface-secondary text-label-primary border-separator
          hover:bg-surface-tertiary
        "
      >
        <Mail size={14} className="flex-shrink-0 text-label-tertiary" />
        <span className="flex flex-col min-w-0">
          <span className="truncate">{hit.filename}</span>
          <span className="type-caption-2 text-label-tertiary truncate">
            part #{anchor.partIndex} · {anchor.messageId}
          </span>
        </span>
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Email citation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => setOpen(false)}
        >
          <div
            className="dp-card max-w-xl w-full m-4 p-4"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between mb-2">
              <h2 className="type-subheadline text-label-primary truncate">
                {hit.filename}
              </h2>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="type-caption-1 text-label-secondary hover:text-label-primary"
                aria-label="Close"
              >
                ✕
              </button>
            </header>
            <dl className="type-caption-1 text-label-secondary space-y-1 mb-3">
              <div className="flex gap-2">
                <dt className="text-label-tertiary">Message-Id:</dt>
                {/* WARP-1153: min-w-0 so a long Message-Id truncates instead
                    of widening the card past max-w-xl. */}
                <dd className="font-mono truncate min-w-0">{anchor.messageId}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-label-tertiary">Part:</dt>
                <dd>#{anchor.partIndex}</dd>
              </div>
            </dl>
            <p className="type-body text-label-primary whitespace-pre-wrap">
              {hit.chunkText}
            </p>
          </div>
        </div>
      )}
    </>
  );
}
