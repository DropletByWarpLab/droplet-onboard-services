"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { splitReasoningSteps } from "@/components/chat/reasoning-trace";

/**
 * WARP-458 — collapsed "Thought process" disclosure above an assistant answer.
 * The trace is muted, pre-wrapped plain text (model monologue, not markdown),
 * collapsed by default so it never competes with the reply.
 *
 * Extracted from ChatMessage (WARP-934) so the in-app chat AND the first-run
 * AI setup step render the model's reasoning identically — one component, one
 * set of tokens/copy (cross-viewport cohesion).
 *
 * WARP-1605 — the trace is now rendered PER AGENT STEP. `trace` is still the
 * flattened string every caller already has (no prop break for AiStep); the
 * component splits it on the orchestrator's step sentinel and renders one
 * block per step, numbered when there is more than one. A single-step trace —
 * every pre-WARP-1602 row, the setup wizard's one-shot probe, and every
 * single-iteration turn — renders exactly as it did before: no numbering, one
 * muted pre-wrapped block.
 *
 * SAFETY, non-negotiable: per OpenAI's harmony spec the analysis channel "has
 * not been trained to the same safety standards" and must not be shown to
 * users. This disclosure is the ONLY place raw thinking is allowed to appear,
 * it starts collapsed, and nothing in WARP-1605 makes it louder — the step
 * structure only exists INSIDE the expanded panel.
 */
export function ReasoningDisclosure({
  trace,
  /**
   * WARP-1605 — the turn is still generating. Adds a live-region hint to the
   * summary so the count visibly ticks up while the model works, without
   * revealing any of the text itself.
   */
  streaming = false,
}: {
  trace: string;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const steps = splitReasoningSteps(trace);
  if (steps.length === 0) return null;
  const multi = steps.length > 1;

  return (
    <div className="mb-1.5" data-testid="reasoning-disclosure">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        data-step-count={steps.length}
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
          className={`transition-transform duration-150 motion-reduce:transition-none ${
            open ? "rotate-90" : ""
          }`}
        />
        {/* The chevron is decorative; the label itself carries the
            expanded/collapsed and step-count state so neither is conveyed
            by rotation or color alone (WCAG 2.1 AA 1.4.1). */}
        Thought process
        {multi ? (
          <span className="text-label-tertiary">
            {" "}
            · {steps.length} steps
          </span>
        ) : null}
        {streaming ? <span className="sr-only"> — still thinking</span> : null}
      </button>
      {open && (
        <ol
          data-testid="reasoning-steps"
          className="mt-1 flex flex-col gap-2 list-none pl-0"
        >
          {steps.map((step, i) => (
            <li
              key={i}
              data-testid="reasoning-step"
              data-step-index={i}
              className="pl-3 border-l-2 border-separator"
            >
              {multi && (
                <p className="type-caption-2 font-medium text-label-tertiary mb-0.5">
                  Step {i + 1}
                </p>
              )}
              <div className="whitespace-pre-wrap type-footnote text-label-tertiary">
                {step}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
