"use client";

import { useId, useRef, useState, useCallback, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Dialog } from "./Dialog";

/**
 * WARP-825 — <DestructiveConfirm>: a reusable, high-friction confirmation modal
 * for irreversible, high-blast-radius actions (DZ4 design).
 *
 * Composes the canonical <Dialog> primitive, so it inherits the focus trap,
 * Escape-to-close, body scroll-lock, focus restore, and prefers-reduced-motion
 * handling for free (don't reinvent a11y). On top of that it adds the
 * destructive-specific contract:
 *
 *   - a blunt, plain-language consequence statement (sentence case, no
 *     euphemisms, no exclamation marks — copy is the caller's),
 *   - an explicit affected-target summary so the owner can't act on the wrong
 *     thing,
 *   - a TYPE-TO-CONFIRM friction step: the destructive button is disabled until
 *     the owner types the exact confirm phrase (case-sensitive, trim-tolerant),
 *   - cancel as the default/least-effort action,
 *   - loading + long-running progress + error states, with the destructive
 *     button disabled while in flight so it can't double-fire.
 *
 * Tokens only: system-red for the destructive surface, dp-input / dp-btn-*,
 * type-* / text-label-* — no invented colors. 44px targets via the dp-btn-*
 * min-heights and the input's padding. WCAG AA: labelled inputs, role="alert"
 * on errors, aria-describedby wiring through <Dialog>.
 */
export interface DestructiveConfirmProps {
  /** Whether the modal is open. */
  open: boolean;
  /** Title — frame it as a question (e.g. "Factory reset this Droplet?"). */
  title: string;
  /** Blunt, plain-language statement of what will be lost. Sentence case. */
  consequence: ReactNode;
  /** The exact phrase the owner must type to clear the friction step. */
  confirmPhrase: string;
  /** Label for the destructive button (e.g. "Factory reset"). */
  confirmLabel: string;
  /** Copy shown on the destructive button while the action is in flight. */
  busyLabel?: string;
  /** A short summary of the target being acted on (e.g. the device name). */
  targetSummary?: ReactNode;
  /**
   * Run the destructive action. Resolve to let the caller close/redirect;
   * reject (throw) to keep the modal open and surface the error for retry.
   */
  onConfirm: () => Promise<void> | void;
  /** Cancel — the default action (Escape, backdrop, Cancel button). */
  onCancel: () => void;
  /** Element that opened the modal — focus returns here on close. */
  triggerRef?: React.RefObject<HTMLElement | null>;
}

export function DestructiveConfirm({
  open,
  title,
  consequence,
  confirmPhrase,
  confirmLabel,
  busyLabel = "Resetting…",
  targetSummary,
  onConfirm,
  onCancel,
  triggerRef,
}: DestructiveConfirmProps) {
  const titleId = useId();
  const bodyId = useId();
  const inputId = useId();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cancel is the default action — focus it on open so the safe path is the
  // least-effort one (a stray Enter cancels, never confirms).
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const phraseMatches = typed.trim() === confirmPhrase.trim() && confirmPhrase.length > 0;
  const canConfirm = phraseMatches && !busy;

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setError(null);
    setBusy(true);
    try {
      await onConfirm();
      // Leave `busy` true on success: the caller is expected to close/redirect
      // (a factory reset tears the page down), and we never want the button to
      // re-enable for a second fire in the window before that happens.
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : "Something went wrong. Please try again.",
      );
      setBusy(false);
    }
  }, [canConfirm, onConfirm]);

  const handleCancel = useCallback(() => {
    if (busy) return; // can't bail out mid-flight
    setTyped("");
    setError(null);
    onCancel();
  }, [busy, onCancel]);

  return (
    <Dialog
      open={open}
      onClose={handleCancel}
      labelledBy={titleId}
      describedBy={bodyId}
      maxWidth="md"
      initialFocusRef={cancelRef}
      triggerRef={triggerRef}
      // Don't let a stray backdrop click dismiss a destructive flow the owner
      // is mid-way through typing into — require an explicit Cancel/Escape.
      closeOnBackdrop={false}
    >
      <div className="p-6">
        {/* Header: red warning mark + question title */}
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-system-red/10">
            <AlertTriangle size={20} className="text-system-red" aria-hidden="true" />
          </span>
          <div className="min-w-0 pt-0.5">
            <h2 id={titleId} className="type-headline text-label-primary">
              {title}
            </h2>
            {targetSummary != null && (
              <p className="type-footnote text-label-tertiary mt-0.5">
                <span className="text-label-secondary">Affects </span>
                <span className="font-mono text-label-primary">{targetSummary}</span>
              </p>
            )}
          </div>
        </div>

        {/* Consequence copy */}
        <p id={bodyId} className="type-subheadline text-label-secondary mt-4 leading-relaxed">
          {consequence}
        </p>

        {/* Type-to-confirm friction step */}
        <div className="mt-5">
          <label htmlFor={inputId} className="type-caption-1 text-label-secondary px-0.5">
            Type{" "}
            <span className="font-mono text-label-primary">{confirmPhrase}</span>{" "}
            to confirm
          </label>
          <input
            id={inputId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canConfirm) handleConfirm();
            }}
            disabled={busy}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={typed.length > 0 && !phraseMatches}
            className="dp-input mt-1.5 font-mono disabled:opacity-60"
            placeholder={confirmPhrase}
          />
        </div>

        {/* Error (retry-able) */}
        {error && (
          <p
            role="alert"
            className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2 mt-3"
          >
            {error}
          </p>
        )}

        {/* Actions — Cancel is the default; destructive is gated + red */}
        <div className="mt-6 flex items-center justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={handleCancel}
            disabled={busy}
            className="dp-btn-secondary type-subheadline disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            aria-disabled={!canConfirm}
            className={
              // Destructive button: system-red fill, white label, 44px target.
              // Disabled until the friction step clears (and while in flight).
              "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-sm " +
              "bg-system-red px-5 py-2.5 font-medium text-white type-subheadline " +
              "transition-all duration-200 ease-smooth " +
              "hover:bg-system-red/90 active:scale-[0.97] " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-system-red/50 " +
              "disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100"
            }
          >
            {busy ? busyLabel : confirmLabel}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
