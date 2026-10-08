"use client";
import { useId, useRef, useState, type RefObject } from "react";
import { Dialog } from "@/components/Dialog";
import { StepUpDialog } from "@/components/auth/StepUpDialog";
import { ExtensionRequestError } from "@/lib/api";
import { HostedAppError } from "./api";

/** Uses the box's existing credential gate, including passkey-only accounts. */
export function useOwnerConfirmation({ actionLabel, onError, triggerRef, destructive = false }: {
  actionLabel: string; onError: (message: string) => void;
  triggerRef?: RefObject<HTMLElement | null>; destructive?: boolean;
}) {
  const heading = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<"mfa" | "password" | null>(null);
  const [password, setPassword] = useState("");
  const retry = useRef<((currentPassword?: string) => Promise<void>) | null>(null);
  const close = () => { setMode(null); setPassword(""); };
  const requestConfirmation = (error: unknown, action: (currentPassword?: string) => Promise<void>) => {
    const code = error instanceof ExtensionRequestError || error instanceof HostedAppError ? error.code : null;
    if (code === "mfa_required" || code === "mfa_stale" || code === "STEP_UP_PASSWORD_REQUIRED" || code === "INVALID_PASSWORD") {
      retry.current = action;
      setPassword("");
      setMode(code === "mfa_required" || code === "mfa_stale" ? "mfa" : "password");
      return true;
    }
    return false;
  };
  return { requestConfirmation, confirmingIdentity: mode !== null, confirmation: <>
    <StepUpDialog open={mode === "mfa"} onClose={close} onVerified={() => retry.current?.()}
      onError={onError} actionLabel={actionLabel} destructive={destructive} triggerRef={triggerRef} />
    <Dialog open={mode === "password"} onClose={close} triggerRef={triggerRef} initialFocusRef={passwordRef} labelledBy={heading} maxWidth="sm">
      <form className="flex flex-col gap-3" onSubmit={(event) => {
        event.preventDefault();
        const value = password; close();
        void retry.current?.(value);
      }}>
        <h2 id={heading} className="type-headline">Confirm it&apos;s you</h2>
        <p className="sub">Enter your current password to continue.</p>
        <label>Password<input ref={passwordRef} type="password" autoComplete="current-password" className="input w-full" required
          value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <div className="flex justify-end gap-2"><button type="button" className="btn" onClick={close}>Cancel</button>
          <button type="submit" className={destructive ? "btn danger" : "btn primary"}>{actionLabel}</button></div>
      </form>
    </Dialog>
  </> };
}
