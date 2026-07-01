"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";

/**
 * WARP-458 — collapsed "Thought process" disclosure above an assistant answer.
 * The trace is muted, pre-wrapped plain text (model monologue, not markdown),
 * collapsed by default so it never competes with the reply.
 *
 * Extracted from ChatMessage (WARP-934) so the in-app chat AND the first-run
 * AI setup step render the model's reasoning identically — one component, one
 * set of tokens/copy (cross-viewport cohesion).
 */
export function ReasoningDisclosure({ trace }: { trace: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="
          inline-flex items-center gap-1 py-0.5
          type-caption-1 text-label-tertiary hover:text-label-secondary
          focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-sm
          transition-colors
        "
      >
        <ChevronRight
          size={12}
          aria-hidden="true"
          className={`transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        Thought process
      </button>
      {open && (
        <div
          className="
            mt-1 pl-3 border-l-2 border-separator
            whitespace-pre-wrap type-footnote text-label-tertiary
          "
        >
          {trace}
        </div>
      )}
    </div>
  );
}
