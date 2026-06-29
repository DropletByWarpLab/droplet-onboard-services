"use client";

import { ChevronDown, ExternalLink, HelpCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { HELP_PATH } from "@/lib/routing";

/**
 * Inline "how does this work?" callout, reused by every wizard step.
 *
 * The wizard's primary surface stays plain-language (ADR-002 home-user
 * persona) — anything that needs context, a definition, or a "where do I
 * sign up" link goes inside this card. Default title is the question
 * itself; pass `title` to override (e.g. "How to use this on your
 * phone").
 *
 * If a step's help topic has a dedicated section in `/help`, pass
 * `helpAnchor` and the card adds a "Learn more" link to `/help#<anchor>`.
 *
 * WARP-820 — the card is now a native **disclosure** (`<details>/<summary>`)
 * so it can RECOVER vertical budget on short viewports for the zero-scroll
 * wizard: it starts **expanded on tall viewports** (desktop discoverability
 * unchanged) and **collapsed on short ones** (`min-height` media query), where
 * the customer can still open it on demand. Native element → keyboard-operable
 * and works with no JS; the only JS is picking the initial open state. Motion
 * is restraint-first: the chevron rotates on toggle, no height animation.
 *
 * Copy discipline (per `auto-claude/agents/ui-ux.md` and the brain
 * addendum):
 *   - **No** "connect to cloud", "sync account", "paired device",
 *     "log in to your X account" — Droplet is local-first.
 *   - Plain language, no installer-grade vocab (zones, VLANs, ONVIF).
 *   - Sentence-case; verb-first when an action is implied.
 */

/** Viewport tall enough that the help card can stay open without costing the
 *  zero-scroll budget. Below this, the card starts collapsed. */
const TALL_ENOUGH = "(min-height: 760px)";

export function LearnMoreCard({
  title = "How does this work?",
  children,
  helpAnchor,
}: {
  title?: string;
  children: ReactNode;
  /** Anchor in `/help` (e.g. "internet" for `/help#internet`). */
  helpAnchor?: string;
}) {
  // WARP-820 — start EXPANDED, unconditionally. This is the SSR-rendered value,
  // so the server markup and the client's first paint agree (no hydration
  // mismatch / open→closed flicker). A lazy `useState(initialOpen)` could NOT do
  // this: its initializer runs once, on the server it has no `window` and
  // returns `true`, and React never re-runs a lazy initializer on hydration — so
  // on a SHORT client viewport the card stayed permanently expanded.
  const [open, setOpen] = useState(true);

  // …then re-derive the open state once, AFTER mount, from the viewport height.
  // Tall viewports keep it open (desktop discoverability unchanged); short ones
  // collapse it to recover the zero-scroll budget, where the customer can still
  // open it on demand. matchMedia is guarded for the SSR/old-browser path
  // (effects never run on the server, but the guard keeps it safe either way).
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    setOpen(window.matchMedia(TALL_ENOUGH).matches);
  }, []);

  return (
    <details
      className="dp-card !p-4 mt-6 group"
      open={open}
      // The open state is intentionally corrected on the client in a post-mount
      // effect; suppress React's hydration-attribute warning for that one frame.
      suppressHydrationWarning
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        <HelpCircle
          size={16}
          className="text-accent flex-shrink-0"
          aria-hidden="true"
        />
        <p className="type-subheadline text-label-primary flex-1">{title}</p>
        <ChevronDown
          size={16}
          className="text-label-tertiary flex-shrink-0 transition-transform duration-200 ease-smooth group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="mt-2 pl-7">
        <div className="type-footnote text-label-secondary space-y-2">
          {children}
        </div>
        {helpAnchor && (
          // WARP-930 — open the help page in a NEW TAB. During setup the wizard
          // owns the current tab; a same-tab navigation to /help remounts the
          // wizard tree and wipes the in-progress step's fields (the "cleared
          // out text" symptom on the Workspace step). A new tab keeps the
          // half-filled step intact. (The ExternalLink glyph already signals
          // that it leaves the page; AuthGate renders /help during setup.)
          <a
            href={`${HELP_PATH}#${helpAnchor}`}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Learn more (opens in a new tab)"
            className="type-footnote text-accent hover:underline mt-3 inline-flex items-center gap-1"
          >
            Learn more
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </div>
    </details>
  );
}
