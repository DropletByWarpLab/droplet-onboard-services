"use client";
import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Dialog } from "@/components/Dialog";
import { StepUpDialog } from "@/components/auth/StepUpDialog";
import { ExtensionRequestError } from "@/lib/api";
import { HostedAppError } from "./api";
import { useHostedActionScope } from "./useHostedActionScope";

/** Uses the box's existing credential gate, including passkey-only accounts. */
export function useOwnerConfirmation({ actionLabel, onError, triggerRef, destructive = false }: {
  actionLabel: string; onError: (message: string) => void;
  triggerRef?: RefObject<HTMLElement | null>; destructive?: boolean;
}) {
  const scope = useHostedActionScope("owner-confirmation", ["owner"]);
  const heading = useId();
  const passwordRef = useRef<HTMLInputElement>(null);
  const [prompt, setPrompt] = useState<{ id: number; mode: "mfa" | "password"; action: (currentPassword?: string) => Promise<void>; isCurrent: () => boolean } | null>(null);
  const [password, setPassword] = useState("");
  const nextPrompt = useRef(0);
  const close = () => { setPrompt(null); setPassword(""); };
  useEffect(() => { setPrompt(null); setPassword(""); }, [scope.key]);
  const shown = prompt?.isCurrent() ? prompt : null;
  // StepUpDialog closes before onVerified; this render's prompt remains the
  // verified action, while a principal change or unmount invalidates its scope.
  const runVerified = async (currentPassword?: string) => {
    if (!prompt?.isCurrent()) return;
    close();
    await prompt.action(currentPassword);
  };
  const requestConfirmation = (error: unknown, action: (currentPassword?: string) => Promise<void>) => {
    const isCurrent = scope.capture();
    if (!isCurrent()) return false;
    const code = error instanceof ExtensionRequestError || error instanceof HostedAppError ? error.code : null;
    if (code === "mfa_required" || code === "mfa_stale" || code === "STEP_UP_PASSWORD_REQUIRED" || code === "INVALID_PASSWORD") {
      setPassword("");
      setPrompt({ id: ++nextPrompt.current, mode: code === "mfa_required" || code === "mfa_stale" ? "mfa" : "password", action, isCurrent });
      return true;
    }
    return false;
  };
  return { requestConfirmation, confirmingIdentity: shown !== null, confirmation: <>
    <StepUpDialog key={shown?.id ?? "closed"} open={shown?.mode === "mfa"} onClose={close} onVerified={() => runVerified()}
      onError={(message) => { if (prompt?.isCurrent()) onError(message); }} actionLabel={actionLabel} destructive={destructive} triggerRef={triggerRef} />
    <Dialog key={scope.key ?? "retired"} open={shown?.mode === "password"} onClose={close} triggerRef={triggerRef} initialFocusRef={passwordRef} labelledBy={heading} maxWidth="sm">
      <form className="flex flex-col gap-3" onSubmit={(event) => {
        event.preventDefault();
        void runVerified(password).catch((error) => { if (prompt?.isCurrent()) onError(error instanceof Error ? error.message : "The Droplet could not complete that."); });
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
