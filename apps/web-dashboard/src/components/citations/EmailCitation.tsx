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
 * WARP-1875 — that modal goes through the <Dialog> primitive, which PORTALS to
 * document.body. A citation renders wherever an answer renders, and on Home
 * that is inside a `.bento` widget shell, which is now a query container
 * (`container-type: inline-size`, home-bento.css). Inline-size containment
 * implies `contain: layout`, which makes the tile a containing block for
 * `position: fixed` descendants — so rendered in place the backdrop would have
 * resolved `inset: 0` against a ~240px tile and then been clipped by its
 * `overflow: hidden`, instead of covering the viewport.
 *
 * Portalling is only half of it, which is why this uses the primitive rather
 * than its own `createPortal`. At the end of the document the dialog is no
 * longer the trigger's next DOM sibling, so Tab no longer steps into it — and
 * a hand-rolled portal that still declares `aria-modal="true"` would tab the
 * user onto the next citation chip BEHIND the scrim, inside a subtree it has
 * just told assistive tech does not exist. <Dialog> owns the focus trap,
 * initial focus, Escape, focus restore and scroll-lock that make the
 * `aria-modal` claim true. Guarded by citations/__tests__/EmailCitation.test.tsx.
 */

import { useId, useRef, useState } from "react";
import { Mail } from "lucide-react";
import type { EmailPartAnchor } from "@droplet/shared-types";
import type { CitationHit } from "./CitationCard";
import { Dialog } from "@/components/Dialog";

export interface EmailCitationProps {
  hit: CitationHit;
  anchor: EmailPartAnchor;
}

export function EmailCitation({ hit, anchor }: EmailCitationProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // Several citations can render in one answer, so the heading id has to be
  // per-instance or `aria-labelledby` resolves to the first one on the page.
  const titleId = useId();
  return (
    <>
      <button
        ref={triggerRef}
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
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        triggerRef={triggerRef}
        labelledBy={titleId}
        maxWidth="xl"
      >
        <header className="flex items-center justify-between gap-3 mb-2">
          <h2 id={titleId} className="type-subheadline truncate" style={{ color: "var(--text)" }}>
            {hit.filename}
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="type-caption-1 flex-shrink-0 text-[var(--text-muted)] transition-colors duration-150 hover:text-[var(--text)]"
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
      </Dialog>
    </>
  );
}
