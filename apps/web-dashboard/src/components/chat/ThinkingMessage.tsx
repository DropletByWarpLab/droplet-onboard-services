"use client";

import type { ReactNode } from "react";
import { Brain } from "lucide-react";
import { ReasoningDisclosure } from "@/components/chat/ReasoningDisclosure";

/**
 * WARP-1605 — the assistant turn's THINKING message.
 *
 * Romain's ask: *"make sure that 'new messages' are shown between thinking and
 * actual answers from the LLM."* Before this, one assistant bubble carried the
 * collapsed reasoning header AND the answer, so there was no boundary at all —
 * the thinking header simply grew an answer underneath it.
 *
 * The turn is now rendered as TWO message rows sharing one `ChatMessage`
 * record (no wire or DB shape change — WARP-1613 owns the wire):
 *
 *   [brain]  ┌ dashed process card ─────────────┐   ← this component
 *            │ › Thought process · 3 steps      │
 *            │ [tool chips]                     │
 *            └──────────────────────────────────┘
 *   [spark]  ┌ answer bubble ───────────────────┐   ← ChatMessage's bubble
 *            │ The answer…                      │
 *            └──────────────────────────────────┘
 *
 * Two avatars, two shapes, two rows: the boundary is structural, not a
 * decorative divider, so it reads the same live, on reload, and to a screen
 * reader (the card carries its own labelled group). The card is deliberately
 * NOT a bubble — a bubble would read as a second reply.
 *
 * SAFETY: the card makes the *existence* and *shape* of the thinking visible;
 * it does not make the thinking itself any more visible. The trace stays
 * behind `ReasoningDisclosure`, collapsed by default, exactly as before —
 * harmony analysis text "has not been trained to the same safety standards"
 * and must not be shown to users unbidden.
 *
 * `children` is the process-phase slot (today: the tool-call chip row), so a
 * later preamble/status line (WARP-1613, out of scope here) is an additive
 * child rather than a restructure.
 */
export function ThinkingMessage({
  trace,
  streaming = false,
  children,
}: {
  /** Flattened reasoning trace (the `ChatMessage.reasoning` column). */
  trace: string;
  /** The turn is still generating — drives the SR-only "still thinking" hint. */
  streaming?: boolean;
  /** Process-phase content rendered under the disclosure (tool-call chips). */
  children?: ReactNode;
}) {
  return (
    <div className="msg" data-testid="assistant-process">
      <div className="msg-ava is-assistant" aria-hidden="true">
        <Brain size={15} />
      </div>
      <div className="msg-col items-start">
        <div
          role="group"
          aria-label="How the assistant worked on this"
          className="
            w-full rounded-2xl border border-dashed border-separator
            bg-surface-secondary/40 px-3 py-2
          "
        >
          <ReasoningDisclosure trace={trace} streaming={streaming} />
          {children}
        </div>
      </div>
    </div>
  );
}
