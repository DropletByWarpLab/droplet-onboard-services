"use client";

import { useRef, useState } from "react";
import { Check, Copy as CopyIcon } from "lucide-react";

/**
 * Fenced code block with a hover copy button. Rendered via the
 * ReactMarkdown `pre` component override so every code block in every
 * bubble gets the affordance (Claude-chat parity). The text is read
 * from the DOM at click time (textContent of the highlighted <code>),
 * so the button works identically for highlighted and plain blocks.
 *
 * Shared between ChatMessage and the wizard AiStep so both surfaces
 * render code snippets with consistent UX (WARP-866).
 */
export function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const handleCopy = async () => {
    const text = preRef.current?.textContent ?? "";
    if (!text || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API rejects in unfocused tabs — still flip the
      // transient state so the button doesn't appear stuck.
    }
    setCopied(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative group/code">
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        className="
          absolute right-1.5 top-1.5 z-10
          inline-flex items-center gap-1 px-2 py-1 rounded-md
          type-caption-2 text-label-tertiary bg-surface-secondary/90
          opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100
          hover:text-label-primary
          focus:outline-none focus:ring-2 focus:ring-accent/40
          transition-opacity duration-150
        "
      >
        {copied ? (
          <Check size={12} aria-hidden="true" />
        ) : (
          <CopyIcon size={12} aria-hidden="true" />
        )}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
      <pre ref={preRef} {...props} />
    </div>
  );
}
