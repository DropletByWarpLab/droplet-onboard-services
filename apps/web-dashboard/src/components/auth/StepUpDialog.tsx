"use client";

/**
 * WARP-3180 — the MFA step-up for sensitive actions.
 *
 * Asks for the signed-in person's password and two-factor code and calls
 * POST /api/auth/step-up, which re-proves THIS session (no account field,
 * same session id) and stamps a fresh `lastMfaAt`. `onVerified` then runs
 * the protected call straight away, inside its 60 s window.
 *
 * Plain `fetch`, not `authFetch`: authFetch answers any 401 with a refresh
 * and a retry, which would replay the password and burn the single-use code.
 * Both fields are cleared after every attempt.
 */
import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { Dialog } from "@/components/Dialog";

export function stepUpErrorMessage(status: number, code?: string): string {
  if (status === 401 && code === "STEP_UP_INVALID") return "Wrong password or code. Try again.";
  if (status === 401) return "Your session ended. Sign in again.";
  if (status === 409 && code === "TOTP_NOT_ENROLLED") {
    return "Turn on two-factor sign-in in Settings first, then try again.";
  }
  if (status === 409) return "This account signs in through your identity provider, so it can't confirm here.";
  if (status === 429) return "Too many attempts. Wait a few minutes, then try again.";
  return "We couldn't confirm it's you. Try again.";
}

export interface StepUpDialogProps {
  open: boolean;
  onClose: () => void;
  /**
   * Runs right after a successful step-up. The dialog has already closed
   * (`onClose` ran first), so the caller shows its own progress, and a
   * protected call that asks for MFA again can simply reopen it.
   */
  onVerified: () => Promise<void> | void;
  /** Gets `onVerified`'s error message after the dialog has closed. */
  onError: (message: string) => void;
  /** Submit button label, e.g. "Rotate key". */
  actionLabel: string;
  /** Red submit for destructive actions. */
  destructive?: boolean;
  triggerRef?: RefObject<HTMLElement | null>;
}

export function StepUpDialog({
  open,
  onClose,
  onVerified,
  onError,
  actionLabel,
  destructive = false,
  triggerRef,
}: StepUpDialogProps) {
  const headingId = useId();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set when the dialog is dismissed (Cancel, Escape, backdrop) while a
  // step-up is in flight: the protected action must then NOT run.
  const cancelledRef = useRef(false);

  function close() {
    cancelledRef.current = true;
    setPassword("");
    setCode("");
    setError(null);
    onClose();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    cancelledRef.current = false;
    const body = JSON.stringify({ password, totp: code.trim() });
    setPassword("");
    setCode("");
    try {
      const res = await fetch("/api/auth/step-up", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        if (!cancelledRef.current) setError(stepUpErrorMessage(res.status, data.code));
        setBusy(false);
        return;
      }
    } catch {
      if (!cancelledRef.current) setError("We couldn't reach your Droplet. Try again.");
      setBusy(false);
      return;
    }
    setBusy(false);
    // Dismissed while the step-up was in flight: the person said no, so the
    // protected action doesn't run. (The fresh stamp just expires.)
    if (cancelledRef.current) return;
    // Close first, then run: the action's progress and result are the
    // caller's to show, and its failure is handed over with its own message
    // instead of reading as a network problem.
    close();
    try {
      await onVerified();
    } catch (err) {
      onError(err instanceof Error && err.message ? err.message : "That didn't work. Try again.");
    }
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      triggerRef={triggerRef}
      labelledBy={headingId}
      maxWidth="sm"
      placement="center"
    >
      <form onSubmit={(e) => void submit(e)} className="space-y-3">
        <h2 id={headingId} className="type-headline" style={{ color: "var(--text)" }}>
          Confirm it&apos;s you
        </h2>
        <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
          Enter your password and the code from your authenticator app.
        </p>
        <label className="block type-footnote">
          Password
          <input
            className="input w-full"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label className="block type-footnote">
          Two-factor code
          <input
            className="input w-full"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="type-footnote" style={{ color: "var(--danger-ink)" }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className={destructive ? "btn danger" : "btn primary"} disabled={busy}>
            {busy ? "Working…" : actionLabel}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
