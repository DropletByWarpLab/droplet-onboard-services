"use client";

import { ChevronDown, ExternalLink, HelpCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

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

function initialOpen(): boolean {
  // SSR / no matchMedia → default expanded (the desktop-first state); the
  // client collapses it after mount on a short viewport.
  if (typeof window === "undefined" || !window.matchMedia) return true;
  return window.matchMedia(TALL_ENOUGH).matches;
}

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
  const [open, setOpen] = useState(initialOpen);

  return (
    <details
      className="dp-card !p-4 mt-6 group"
      open={open}
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
          <a
            href={`/help#${helpAnchor}`}
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
