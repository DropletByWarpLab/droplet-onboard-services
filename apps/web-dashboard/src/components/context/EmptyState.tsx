"use client";

/**
 * WARP-225 — zero-files onboarding card.
 *
 * Renders instead of empty charts when the user has 0 BrainMemoryItem
 * rows. Per spec §error handling: "User has zero files → empty-state
 * card; no broken chart renders."
 */

import Link from "next/link";
import { Sparkles, MessageSquare, ArrowRight } from "lucide-react";

export function EmptyState() {
  return (
    <div
      className="dp-tile p-10 flex flex-col items-center text-center gap-5 max-w-2xl mx-auto"
      data-testid="context-empty-state"
    >
      <span className="w-14 h-14 rounded-2xl bg-accent-subtle flex items-center justify-center">
        <Sparkles size={28} className="text-accent" />
      </span>
      <div className="space-y-2 max-w-md">
        <h2 className="type-title-2 text-label-primary font-semibold">
          Your AI&apos;s context is empty
        </h2>
        <p className="type-body text-label-secondary">
          Drop a file into a chat conversation, or open the chat and attach
          one. We&apos;ll extract, chunk, and index it so your assistant can
          reason about its content.
        </p>
      </div>
      <Link
        href="/chat"
        className="inline-flex items-center gap-2 px-5 h-10 rounded-full bg-accent text-white type-subheadline font-medium hover:opacity-90 transition-opacity"
      >
        <MessageSquare size={16} />
        Open chat
        <ArrowRight size={14} />
      </Link>
    </div>
  );
}
