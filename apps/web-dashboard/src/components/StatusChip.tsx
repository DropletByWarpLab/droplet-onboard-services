"use client";

/**
 * WARP-214 — small status pill on BrainMemoryItem cards.
 *
 * Four enum values:
 *   - queued_for_transcription → "Queued for transcription · runs nightly"
 *     + kebab overflow with discreet "Transcribe now" action (WARP-218)
 *   - indexing → "Indexing"
 *   - ready    → null (clean state — chip vanishes when ready)
 *   - failed   → "Failed" + tooltip with failureReason
 *
 * Forward-compat: unknown enum value renders generic "Processing" pill
 * so server-side enum changes can land before the dashboard knows about
 * them.
 *
 * The "Transcribe now" overflow is only shown when:
 *   1. status === "queued_for_transcription"
 *   2. an `onTranscribeNow` handler is wired up
 * Feature detection of WARP-218 happens at the call site (caller catches
 * `TranscribeNowUnavailable` from api.ts and stops re-rendering the menu).
 */

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { BrainMemoryItemStatus } from "@/lib/api";

export interface StatusChipProps {
  itemId: string;
  status: BrainMemoryItemStatus | string;
  failureReason?: string | null;
  onTranscribeNow?: (itemId: string) => void;
}

const PILL_BASE =
  "inline-flex items-center rounded-full px-2 py-0.5 type-caption-1 border";
const STATUS_CLASSES: Record<string, string> = {
  queued: `${PILL_BASE} bg-surface-secondary border-separator text-label-secondary`,
  indexing: `${PILL_BASE} bg-accent/10 border-accent/40 text-accent`,
  failed: `${PILL_BASE} bg-system-orange/10 border-system-orange/50 text-system-orange`,
  unknown: `${PILL_BASE} bg-surface-secondary border-separator text-label-tertiary`,
};

export function StatusChip({
  itemId,
  status,
  failureReason,
  onTranscribeNow,
}: StatusChipProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (status === "ready") return null;

  let label: string;
  let className: string;
  if (status === "queued_for_transcription") {
    label = "Queued for transcription · runs nightly";
    className = STATUS_CLASSES.queued;
  } else if (status === "indexing") {
    label = "Indexing";
    className = STATUS_CLASSES.indexing;
  } else if (status === "failed") {
    label = "Failed";
    className = STATUS_CLASSES.failed;
  } else {
    // Forward-compat for unknown enum values.
    label = "Processing";
    className = STATUS_CLASSES.unknown;
  }

  const showOverflow =
    status === "queued_for_transcription" &&
    typeof onTranscribeNow === "function";

  return (
    <div className="inline-flex items-center gap-1">
      <span
        className={className}
        title={status === "failed" ? failureReason ?? undefined : undefined}
      >
        {label}
      </span>
      {showOverflow && (
        <div className="relative">
          <button
            type="button"
            aria-label="More actions"
            className="inline-flex h-5 w-5 items-center justify-center rounded-full text-label-tertiary hover:bg-label-quaternary/40 hover:text-label-primary transition-colors"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-6 z-10 min-w-[8rem] rounded-md border border-separator bg-surface-primary py-1 shadow-md">
              <button
                type="button"
                className="block w-full px-3 py-1.5 text-left type-caption-1 text-label-primary hover:bg-surface-secondary"
                onClick={() => {
                  setMenuOpen(false);
                  onTranscribeNow?.(itemId);
                }}
              >
                Transcribe now
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
