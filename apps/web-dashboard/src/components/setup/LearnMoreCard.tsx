"use client";

import { ExternalLink, HelpCircle } from "lucide-react";
import type { ReactNode } from "react";

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
 * Copy discipline (per `auto-claude/agents/ui-ux.md` and the brain
 * addendum):
 *   - **No** "connect to cloud", "sync account", "paired device",
 *     "log in to your X account" — Droplet is local-first.
 *   - Plain language, no installer-grade vocab (zones, VLANs, ONVIF).
 *   - Sentence-case; verb-first when an action is implied.
 */
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
  return (
    <div className="dp-card !p-4 mt-6">
      <div className="flex items-start gap-3">
        <HelpCircle
          size={16}
          className="text-accent flex-shrink-0 mt-0.5"
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <p className="type-subheadline text-label-primary mb-2">{title}</p>
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
      </div>
    </div>
  );
}
