"use client";

import { useCallback, useId, useState, type ReactNode, type RefObject } from "react";
import { Loader2 } from "lucide-react";
import { Dialog } from "./Dialog";

/**
 * Destructive- / neutral-confirmation primitive for the dashboard
 * (WARP-291). Built on top of the WARP-289 <Dialog> primitive so every
 * confirm dialog in the dashboard inherits full modal ARIA + focus
 * trap + Escape close + scroll-lock for free.
 *
 * Replaces every native `window.confirm()` callsite in the dashboard
 * with a consistent, themeable surface.
 *
 * Behavior contract:
 *   - `onConfirm` may return a Promise. While that promise is pending
 *     the confirm button is disabled and shows a "Working…" label so
 *     the user cannot double-fire the mutation. If the promise
 *     resolves we call `onCancel` to close the dialog. If it rejects
 *     we leave the dialog open and let the caller surface the error
 *     (typically via toast). Never close on error — the user may want
 *     to retry without re-opening.
 *   - `variant="destructive"` (default) paints the confirm button red
 *     (`.btn danger`, the indigo shell's destructive fill).
 *     `variant="neutral"` uses the standard `.btn primary` so
 *     non-destructive confirms (Unblock, Allow, etc.) don't carry a
 *     misleading warning hue.
 *   - Enter on the confirm button activates it via default button
 *     semantics (no special key handling needed here).
 *   - `triggerRef` is plumbed through to <Dialog> for focus restore on
 *     close so keyboard users land back on the row action they came
 *     from.
 */
export interface ConfirmDialogProps {
  open: boolean;
  /** Async or sync. Resolve to close; reject to keep the dialog open. */
  onConfirm: () => void | Promise<void>;
  /** Called when the user clicks Cancel, hits Escape, or onConfirm resolves. */
  onCancel: () => void;
  /** Element that opened the dialog — focus returns here on close. */
  triggerRef?: RefObject<HTMLElement | null>;
  title: string;
  /** Plain-English consequence sentence ("Bob won't be able to …"). */
  description: string;
  /** Verb-first action word ("Revoke", "Delete", "Block"). */
  confirmLabel: string;
  /** Override the default "Cancel" label. */
  cancelLabel?: string;
  /** Destructive = red; neutral = accent. Default: destructive. */
  variant?: "destructive" | "neutral";
  /**
   * Optional identifier the user sees inline for verification. Used
   * by the caller when they want to embed the target name in the
   * title ("Revoke invite for {invite.username}?") — kept as a
   * separate prop so the title remains free of string interpolation
   * at the call site. Today this is informational only; renders as a
   * monospace token under the description if present.
   */
  confirmedIdentifier?: string;
  /**
   * Optional content rendered between the description and the button row —
   * e.g. a safety-tier chip ("Write · confirm to apply") on a Tier-2
   * network/switch write. Purely additive: existing callsites omit it and
   * render exactly as before.
   */
  accessory?: ReactNode;
}

export function ConfirmDialog({
  open,
  onConfirm,
  onCancel,
  triggerRef,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  variant = "destructive",
  confirmedIdentifier,
  accessory,
}: ConfirmDialogProps) {
  const headingId = useId();
  const descId = useId();
  const [pending, setPending] = useState(false);

  const handleConfirm = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      await onConfirm();
      onCancel();
    } catch {
      // Intentionally swallowed here — the caller is responsible for
      // surfacing the error (typically a toast via friendly-errors).
      // We just stay open so the user can retry or back out.
    } finally {
      setPending(false);
    }
  }, [onConfirm, onCancel, pending]);

  // Confirm button styling differs by variant. Both resolve via the
  // `droplet-shell` scope the <Dialog> backdrop carries (WARP-1079):
  // `.btn danger` is the shell's destructive fill (#ef4444), already used
  // for system-wide destructive affordances (Block, delete, revoke).
  // Neutral uses the shell's `.btn primary` so positive confirms
  // (Unblock, Allow) read correctly.
  const confirmClass =
    variant === "destructive" ? "btn danger" : "btn primary";

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      triggerRef={triggerRef}
      labelledBy={headingId}
      describedBy={descId}
      maxWidth="sm"
      placement="center"
    >
      <div className="p-5 space-y-4">
        <div>
          <h2 id={headingId} className="type-headline" style={{ color: "var(--text)" }}>
            {title}
          </h2>
          <p
            id={descId}
            className="type-subheadline mt-1.5"
            style={{ color: "var(--text-muted)" }}
          >
            {description}
          </p>
          {confirmedIdentifier && (
            <p
              className="type-caption-1 font-mono mt-2 break-all"
              style={{ color: "var(--text-muted)" }}
            >
              {confirmedIdentifier}
            </p>
          )}
        </div>
        {accessory && <div>{accessory}</div>}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="btn ghost"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={pending}
            className={confirmClass}
            aria-busy={pending || undefined}
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
