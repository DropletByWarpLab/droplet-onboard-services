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
 * Indigo tokens only (WARP-1079): the shell ramp (`--text*`, `--surface`,
 * `--border`) resolves via the `droplet-shell` scope the <Dialog> backdrop
 * carries; the destructive fill is the established #ef4444 idiom — no
 * invented colors. 44px targets via explicit min-heights and the input's
 * padding. WCAG AA: labelled inputs, role="alert" on errors,
 * aria-describedby wiring through <Dialog>.
 */
export interface DestructiveConfirmProps {
  /** Whether the modal is open. */
  open: boolean;
  /** Title — frame it as a question (e.g. "Factory reset this Droplet?"). */
  title: string;
  /** Blunt, plain-language statement of what will be lost. Sentence case. */
  consequence: ReactNode;
  /**
   * The exact phrase the owner must type to clear the friction step. When the
   * expected value is only known SERVER-side (e.g. the factory-reset device
   * name — the API intentionally returns it only as a masked hint so the
   * modal can't offer a copy/paste-able confirm value), omit this and supply
   * `confirmPrompt` (+ optionally `confirmHint`): the input then gates on
   * "non-empty" and the server verdict is the authority — a mismatch comes
   * back as a thrown error from `onConfirm` and is surfaced for retry.
   */
  confirmPhrase?: string;
  /**
   * What to type, described in words, for the server-validated mode (e.g.
   * "your device's name"). Ignored when `confirmPhrase` is set.
   */
  confirmPrompt?: ReactNode;
  /**
   * Masked orientation hint shown next to the prompt in the server-validated
   * mode (e.g. "d••••••t"). Ignored when `confirmPhrase` is set.
   */
  confirmHint?: string;
  /** Label for the destructive button (e.g. "Factory reset"). */
  confirmLabel: string;
  /** Copy shown on the destructive button while the action is in flight. */
  busyLabel?: string;
  /** A short summary of the target being acted on (e.g. the device name). */
  targetSummary?: ReactNode;
  /**
   * Run the destructive action; receives the typed (trimmed) confirm value so
   * server-validated callers can forward it. Resolve to let the caller
   * close/redirect; reject (throw) to keep the modal open and surface the
   * error for retry.
   */
  onConfirm: (typed: string) => Promise<void> | void;
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
  confirmPrompt,
  confirmHint,
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

  // Server-validated mode: the exact phrase is deliberately unknown here, so
  // the local gate is "typed something" and the server is the authority.
  const serverValidated = confirmPhrase === undefined;
  const phraseMatches = serverValidated
    ? typed.trim().length > 0
    : typed.trim() === confirmPhrase.trim() && confirmPhrase.length > 0;
  const canConfirm = phraseMatches && !busy;

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setError(null);
    setBusy(true);
    try {
      await onConfirm(typed.trim());
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
  }, [canConfirm, onConfirm, typed]);

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
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[rgba(239,68,68,0.1)]"
          >
            <AlertTriangle size={20} className="text-[#ef4444]" aria-hidden="true" />
          </span>
          <div className="min-w-0 pt-0.5">
            <h2 id={titleId} className="type-headline" style={{ color: "var(--text)" }}>
              {title}
            </h2>
            {targetSummary != null && (
              <p className="type-footnote mt-0.5" style={{ color: "var(--text-muted)" }}>
                <span>Affects </span>
                <span className="font-mono" style={{ color: "var(--text)" }}>
                  {targetSummary}
                </span>
              </p>
            )}
          </div>
        </div>

        {/* Consequence copy */}
        <p
          id={bodyId}
          className="type-subheadline mt-4 leading-relaxed"
          style={{ color: "var(--text-muted)" }}
        >
          {consequence}
        </p>

        {/* Type-to-confirm friction step */}
        <div className="mt-5">
          <label
            htmlFor={inputId}
            className="type-caption-1 px-0.5"
            style={{ color: "var(--text-muted)" }}
          >
            Type{" "}
            {serverValidated ? (
              <>
                {confirmPrompt ?? "the confirmation phrase"}
                {confirmHint ? (
                  <>
                    {" "}
                    (
                    <span className="font-mono" style={{ color: "var(--text)" }}>
                      {confirmHint}
                    </span>
                    )
                  </>
                ) : null}
              </>
            ) : (
              <span className="font-mono" style={{ color: "var(--text)" }}>
                {confirmPhrase}
              </span>
            )}{" "}
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
            className="w-full px-3 py-2.5 mt-1.5 font-mono outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors disabled:opacity-60"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--text)",
            }}
            placeholder={serverValidated ? confirmHint : confirmPhrase}
          />
        </div>

        {/* Error (retry-able) */}
        {error && (
          <p
            role="alert"
            className="type-footnote text-[#ef4444] bg-[rgba(239,68,68,0.1)] rounded-[var(--radius-input)] px-3 py-2 mt-3"
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
            className="btn ghost min-h-[44px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!canConfirm}
            aria-disabled={!canConfirm}
            className={
              // Destructive button: #ef4444 fill (indigo shell destructive
              // idiom), white label, 44px target. Disabled until the
              // friction step clears (and while in flight).
              "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[var(--radius-input)] " +
              "bg-[#ef4444] px-5 py-2.5 font-medium text-white type-subheadline " +
              "transition-all duration-200 ease-smooth " +
              "hover:bg-[#dc2626] active:scale-[0.97] " +
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(239,68,68,0.5)] " +
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
