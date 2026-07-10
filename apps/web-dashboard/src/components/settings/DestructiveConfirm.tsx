"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Dialog } from "@/components/Dialog";

/**
 * WARP-828 — reusable type-to-confirm modal for irreversible actions.
 *
 * The friction layer in front of a destructive operation. Unlike the lighter
 * <ConfirmDialog> (one click), this requires the owner to TYPE an exact phrase
 * — the affected target's name — before the destructive button enables. First
 * caller: the Settings Danger Zone "reformat a drive" flow, where a mis-click
 * would erase a whole disk.
 *
 * This is a HUMAN gate, never the only gate: the orchestrator independently
 * enforces owner-role + a single-use confirm token (see storage.ts /
 * storage-safety.service.ts). The component never sees or trusts those — it
 * just makes the human step deliberate and honest.
 *
 * Built on the WARP-289 <Dialog> primitive, so it inherits the full modal
 * contract for free: focus trap, Escape-to-close, body scroll-lock, focus
 * restore to the trigger on close, and `prefers-reduced-motion` (Dialog gates
 * its fade/scale on framer-motion's useReducedMotion).
 *
 * Behaviour contract:
 *   - Cancel is the DEFAULT focused action (the safe choice). The destructive
 *     button is disabled until the typed text matches `confirmPhrase`
 *     (case-insensitive, trimmed — a home user shouldn't fight capitalisation).
 *   - `onConfirm` may be async. While it runs, both buttons lock and a
 *     long-running progress line shows so the owner can't double-fire or back
 *     out mid-operation. On resolve the caller closes the dialog (via its own
 *     state); on reject we STAY OPEN and show the error so the owner can retry.
 *   - The error copy is the caller's `errorMessage` when provided (the caller
 *     maps raw host/bridge failures to calm home-user language), else a calm
 *     generic. Raw device/mkfs strings never reach the screen.
 */
export interface DestructiveConfirmProps {
  open: boolean;
  /** Element that opened the dialog — focus returns here on close. */
  triggerRef?: RefObject<HTMLElement | null>;
  /** Question-form title ("Reformat this drive?"). */
  title: string;
  /** Plain-language consequence, blunt and honest ("This erases everything…"). */
  consequence: string;
  /** One-line summary of exactly what's affected ("Wedding Photos · 2 TB"). */
  affectedSummary: string;
  /** The exact phrase the owner must type to unlock the destructive button. */
  confirmPhrase: string;
  /** Verb-first destructive action word ("Erase and reformat"). */
  confirmLabel: string;
  /** Override the default "Cancel" label. */
  cancelLabel?: string;
  /** Async or sync. Resolve → caller closes; reject → dialog stays open. */
  onConfirm: () => void | Promise<void>;
  /** Called on Cancel, Escape, or backdrop click. */
  onCancel: () => void;
  /**
   * Calm, home-user error copy shown if `onConfirm` rejects. When omitted a
   * generic calm fallback is used. NEVER pass a raw exception message here.
   */
  errorMessage?: string;
  /**
   * Progress copy shown while `onConfirm` is in flight. Defaults to a calm
   * long-running message; callers can tailor it ("Reformatting the drive…").
   */
  progressMessage?: string;
  /**
   * Optional content between the consequence and the type-to-confirm field —
   * e.g. extra warning detail. Additive; omit for the default layout.
   */
  accessory?: ReactNode;
}

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

export function DestructiveConfirm({
  open,
  triggerRef,
  title,
  consequence,
  affectedSummary,
  confirmPhrase,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  errorMessage,
  progressMessage = "This can take a moment — keep this open until it finishes.",
  accessory,
}: DestructiveConfirmProps) {
  const headingId = useId();
  const descId = useId();
  const inputId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  // Reset the transient state whenever the dialog (re)opens so a previous
  // attempt's typed phrase / error never leaks into a fresh confirmation.
  useEffect(() => {
    if (open) {
      setTyped("");
      setPending(false);
      setFailed(false);
    }
  }, [open]);

  const matches = normalize(typed) === normalize(confirmPhrase) && confirmPhrase.length > 0;

  const handleConfirm = useCallback(async () => {
    if (pending || !matches) return;
    setFailed(false);
    setPending(true);
    try {
      await onConfirm();
      // Success: the caller owns closing (it usually refreshes data first).
      // We don't call onCancel here — leave the close decision to the caller
      // so it can sequence a reload before unmounting us.
    } catch {
      // Stay open for retry. The caller surfaces the *cause* via errorMessage;
      // we never render the raw exception.
      setFailed(true);
    } finally {
      setPending(false);
    }
  }, [pending, matches, onConfirm]);

  return (
    <Dialog
      open={open}
      onClose={pending ? () => {} : onCancel}
      triggerRef={triggerRef}
      initialFocusRef={cancelRef}
      labelledBy={headingId}
      describedBy={descId}
      maxWidth="sm"
      placement="center"
    >
      {/* Body padding comes from the <Dialog> primitive (WARP-1153). */}
      <div className="space-y-4">
        <div className="flex items-start gap-3">
          <span
            className="flex-none mt-0.5 flex h-9 w-9 items-center justify-center rounded-full bg-[rgba(239,68,68,0.1)] text-[#ef4444]"
            aria-hidden="true"
          >
            <AlertTriangle size={18} />
          </span>
          <div className="min-w-0">
            <h2 id={headingId} className="type-headline" style={{ color: "var(--text)" }}>
              {title}
            </h2>
            <p
              id={descId}
              className="type-subheadline mt-1.5"
              style={{ color: "var(--text-muted)" }}
            >
              {consequence}
            </p>
          </div>
        </div>

        {/* Exactly what's at stake — separated, monospace, hard to misread. */}
        <p
          className="type-caption-1 font-mono break-all rounded-[var(--radius-input)] px-3 py-2"
          style={{ background: "var(--inset)", color: "var(--text-muted)" }}
        >
          {affectedSummary}
        </p>

        {accessory && <div>{accessory}</div>}

        {/* Type-to-confirm friction. The label names the exact phrase so a
            screen-reader user knows what to type without seeing the heading. */}
        <div className="space-y-1.5">
          <label
            htmlFor={inputId}
            className="block type-footnote"
            style={{ color: "var(--text-muted)" }}
          >
            Type{" "}
            <span className="font-mono" style={{ color: "var(--text)" }}>
              {confirmPhrase}
            </span>{" "}
            to confirm
          </label>
          <input
            id={inputId}
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={pending}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            aria-invalid={failed || undefined}
            className="w-full px-3 py-2.5 font-mono outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors disabled:opacity-60"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--text)",
            }}
            placeholder={confirmPhrase}
          />
        </div>

        {failed && (
          <div
            role="alert"
            className="flex items-start gap-2 type-footnote bg-[rgba(239,68,68,0.1)] rounded-[var(--radius-input)] px-3 py-2"
            style={{ color: "var(--text)" }}
          >
            <AlertTriangle
              size={14}
              className="mt-0.5 flex-shrink-0 text-[#ef4444]"
              aria-hidden="true"
            />
            <span>
              {errorMessage ??
                "That didn't go through. Check the drive is connected and try again."}
            </span>
          </div>
        )}

        {pending && (
          <p
            className="flex items-center gap-2 type-footnote"
            style={{ color: "var(--text-muted)" }}
            aria-live="polite"
          >
            <Loader2 size={14} className="animate-spin flex-none" aria-hidden="true" />
            {progressMessage}
          </p>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="btn ghost min-h-[44px]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={!matches || pending}
            aria-busy={pending || undefined}
            className="type-subheadline px-4 rounded-[var(--radius-input)] bg-[#ef4444] text-white hover:bg-[#dc2626] disabled:opacity-60 disabled:cursor-not-allowed inline-flex items-center gap-1.5 min-h-[44px]"
          >
            {pending ? (
              <>
                <Loader2 size={14} className="animate-spin" aria-hidden="true" />
                Working&hellip;
              </>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
