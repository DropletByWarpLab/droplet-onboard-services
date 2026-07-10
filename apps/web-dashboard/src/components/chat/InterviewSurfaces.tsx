"use client";

/**
 * WARP-1121 — the interview's chat chrome (design brief §3/§4):
 *   <InterviewIntroCard>  the first-chat empty-state card (owner/admin +
 *                         BUSINESS + not_started only — the PAGE gates that).
 *   <InterviewProgress>   pinned eyebrow: mono all-caps label + 7 dots driven
 *                         off parsed topic markers (hold, never guess) +
 *                         session controls (Pause / Skip the rest).
 *   <InterviewResumeBanner> in-session resume banner.
 *
 * All chrome copy ships verbatim from INTERVIEW_COPY (§9). The aurora wash +
 * serif capsule follow the voice-packet capsule pattern.
 */
import { Sparkles } from "lucide-react";
import {
  INTERVIEW_COPY,
  TOPIC_COUNT,
} from "@/lib/interview";

export function InterviewIntroCard({
  onStart,
  onSkip,
  modelReady,
}: {
  onStart: () => void;
  onSkip: () => void;
  /** false = the standard chat degraded state — Start disabled + footnote. */
  modelReady: boolean;
}) {
  return (
    <div
      data-testid="interview-intro-card"
      className="relative max-w-[640px] mx-auto text-center px-4 py-8"
    >
      <div
        aria-hidden="true"
        className="aurora-bg absolute inset-0 opacity-55 pointer-events-none rounded-2xl"
      />
      <div className="relative space-y-4">
        <div className="mx-auto w-10 h-10 text-accent" aria-hidden="true">
          <Sparkles size={40} />
        </div>
        <p className="font-serif text-[28px] leading-tight inline-block px-5 py-2 rounded-full bg-accent-subtle text-label-primary">
          {INTERVIEW_COPY.introSpokenLine}
        </p>
        <p className="type-body text-label-secondary max-w-[48ch] mx-auto">
          {INTERVIEW_COPY.introBody}
        </p>
        <p className="type-footnote text-label-secondary">
          {INTERVIEW_COPY.introMeta}
        </p>
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={onStart}
            disabled={!modelReady}
            className="px-6 py-2.5 rounded-full bg-accent text-white type-subheadline hover:bg-accent-hover disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-accent/40"
          >
            {INTERVIEW_COPY.introStart}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="type-subheadline text-label-secondary hover:text-label-primary px-3 py-2.5"
          >
            {INTERVIEW_COPY.introSkip}
          </button>
        </div>
        {!modelReady && (
          <p className="type-footnote text-label-tertiary" role="status">
            {INTERVIEW_COPY.warmingFootnote}
          </p>
        )}
        <p className="type-caption-1 text-label-quaternary">
          {INTERVIEW_COPY.introSubHint}
        </p>
      </div>
    </div>
  );
}

export function InterviewProgress({
  topic,
  onSkipTheRest,
  onPause,
}: {
  /** Last parsed topic marker (1-7); null before the first marker. */
  topic: number | null;
  onSkipTheRest: () => void;
  onPause: () => void;
}) {
  return (
    <div
      data-testid="interview-progress"
      className="flex flex-col items-center gap-1.5 py-2 border-b border-separator"
    >
      <div className="flex items-center gap-3">
        <span className="font-mono type-caption-2 tracking-widest text-label-secondary uppercase">
          {INTERVIEW_COPY.progressEyebrow}
        </span>
        {/* Dots ≥480px; the mono counter replaces them below 480 (CSS). */}
        <span className="hidden min-[480px]:flex items-center gap-1.5" aria-hidden="true">
          {Array.from({ length: TOPIC_COUNT }, (_, i) => (
            <span
              key={i}
              data-testid={`topic-dot-${i + 1}`}
              data-done={topic !== null && i < topic}
              className={`w-1.5 h-1.5 rounded-full ${
                topic !== null && i < topic ? "bg-accent" : "bg-separator"
              }`}
            />
          ))}
        </span>
        <span className="min-[480px]:hidden font-mono type-caption-2 text-label-secondary">
          {topic ?? 0} of {TOPIC_COUNT}
        </span>
      </div>
      {/* aria-live counter driven off the SAME parsed markers as the dots —
          it never announces a guess (§8). */}
      <span className="sr-only" aria-live="polite">
        {topic !== null ? `Topic ${topic} of ${TOPIC_COUNT}` : ""}
      </span>
      <div className="flex items-center gap-4">
        <button
          type="button"
          onClick={onPause}
          className="type-caption-1 text-label-secondary hover:text-label-primary"
        >
          {INTERVIEW_COPY.pause}
        </button>
        <button
          type="button"
          onClick={onSkipTheRest}
          data-testid="skip-the-rest"
          className="type-caption-1 text-label-secondary hover:text-label-primary"
        >
          {INTERVIEW_COPY.skipTheRest}
        </button>
      </div>
    </div>
  );
}

export function InterviewResumeBanner({
  onResume,
  onSkipTheRest,
}: {
  onResume: () => void;
  onSkipTheRest: () => void;
}) {
  return (
    <div
      data-testid="interview-resume-banner"
      className="flex items-center justify-between gap-3 px-4 py-2.5 border-l-2 border-system-orange bg-surface-secondary rounded-sm"
    >
      <span className="type-footnote text-label-primary">
        {INTERVIEW_COPY.resumeBanner}
      </span>
      <span className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={onResume}
          className="type-footnote text-accent hover:text-accent-hover"
        >
          {INTERVIEW_COPY.resume}
        </button>
        <button
          type="button"
          onClick={onSkipTheRest}
          className="type-footnote text-label-secondary hover:text-label-primary"
        >
          {INTERVIEW_COPY.skipTheRest}
        </button>
      </span>
    </div>
  );
}

export function FinishedElsewhereBanner({ onView }: { onView: () => void }) {
  return (
    <div
      data-testid="interview-finished-elsewhere"
      className="flex items-center justify-between gap-3 px-4 py-2.5 border-l-2 border-system-orange bg-surface-secondary rounded-sm"
    >
      <span className="type-footnote text-label-primary">
        {INTERVIEW_COPY.finishedElsewhere}
      </span>
      <button
        type="button"
        onClick={onView}
        className="type-footnote text-accent hover:text-accent-hover shrink-0"
      >
        {INTERVIEW_COPY.viewWhatIKnow}
      </button>
    </div>
  );
}

/** WARP-1122 (design §7.12) — the review-due nudge: a single dismissible
 *  chip above the composer in an empty chat. Orange accent, never a modal;
 *  dismissal persists server-side (explicit column) so it does not
 *  resurrect on reload within the same review period. */
export function ReviewNudgeChip({
  onUpdate,
  onDismiss,
}: {
  onUpdate: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      data-testid="review-nudge-chip"
      className="flex items-center gap-3 px-4 py-2 rounded-full border border-system-orange/40 bg-surface-secondary max-w-fit mx-auto"
    >
      <span className="type-footnote text-label-primary">
        {INTERVIEW_COPY.nudgeLine}
      </span>
      <button
        type="button"
        onClick={onUpdate}
        className="type-footnote text-accent hover:text-accent-hover shrink-0"
      >
        {INTERVIEW_COPY.nudgeAction}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="text-label-tertiary hover:text-label-primary shrink-0 leading-none"
      >
        ×
      </button>
    </div>
  );
}
