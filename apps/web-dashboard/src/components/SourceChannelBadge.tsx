"use client";

/**
 * WARP-214 — small "transcribed by ASR" / "embedded subtitles" / "OCR" pill
 * shown in the metadata row alongside size + date on RecentlyIndexedTab and
 * SearchTab cards.
 *
 * Returns null when no signal applies (PDF text, email body, plain text,
 * DOCX) — that's the design's intent: the pill only appears when the channel
 * is "lossy" enough that the user benefits from knowing.
 *
 * Styling matches AttachmentChip's pill convention: rounded-full,
 * type-caption-1, surface-secondary background, label-tertiary text.
 */

import type { SubtitleSource } from "@/lib/api";

export interface SourceChannelBadgeProps {
  subtitleSource?: SubtitleSource | null;
  warnings: string[];
}

const PILL_CLASS =
  "source-channel-badge inline-flex items-center rounded-full bg-surface-secondary border border-separator px-2 py-0.5 type-caption-1 text-label-tertiary";

export function SourceChannelBadge({
  subtitleSource,
  warnings,
}: SourceChannelBadgeProps) {
  // Subtitle source wins when present (video extractor + future frame OCR).
  if (subtitleSource === "asr_transcript") {
    return <span className={PILL_CLASS}>transcribed by ASR</span>;
  }
  if (subtitleSource === "embedded") {
    return <span className={PILL_CLASS}>embedded subtitles</span>;
  }
  if (subtitleSource === "frame_ocr") {
    return <span className={PILL_CLASS}>text from video frames</span>;
  }

  // Warnings array — image OCR signals.
  if (warnings.includes("low_confidence_ocr")) {
    return <span className={PILL_CLASS}>OCR · low confidence</span>;
  }
  if (warnings.includes("ocr_used")) {
    return <span className={PILL_CLASS}>OCR</span>;
  }

  return null;
}
