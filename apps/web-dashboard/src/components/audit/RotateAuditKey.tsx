"use client";

/**
 * WARP-3180 — owner-only "Rotate audit signing key" on the Audit log page.
 *
 * Calls POST /api/activity/rotate-key (WARP-3165, PR #2417): owner only, an
 * MFA sign-in less than 60 s old, rate-limited, audited. The server is the
 * gate; hiding the control from admins and members is presentation only.
 *
 * Two confirms, both red: the first explains why and what happens, the
 * second is the step-up itself. The step-up is the dashboard's existing one:
 * sign in again with password + two-factor code (the login stamps
 * `lastMfaAt` into the new session cookie), then call the route at once so
 * it lands inside the 60 s window.
 */
import { useId, useRef, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import { authFetch, useAuth } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Dialog } from "@/components/Dialog";

export const ROTATE_EXPLAINER =
  "Rotate the key if an audit bundle exported by an earlier Droplet version left the box: those bundles carried the signing key. New entries are signed with a new key right away. Earlier entries stay verifiable, because the old key is kept on the box for checking only. This is recorded in the audit log.";

type Outcome = { kind: "ok"; newKeyId: string } | { kind: "error"; message: string };

/** Plain-English copy for each refusal the route can answer. */
export function rotateErrorMessage(status: number, body: { error?: string; code?: string }): string {
  if (status === 401) {
    return "The box needs a two-factor sign-in from the last minute. If your account has no two-factor code yet, turn it on in Settings first, then try again.";
  }
  if (status === 403) return "Only the owner can rotate the audit signing key.";
  if (status === 429) return "Too many attempts. Wait a few minutes, then try again.";
  if (body.code === "RETIRED_KEY_DIR_MISSING") {
    return "This box needs its latest update applied before the key can be rotated. Nothing changed.";
  }
  if (body.code === "HOST_HELPER_UNAVAILABLE") {
    return "This box can't rotate the key from the dashboard. Run scripts/rotate-audit-key.sh on the box instead. Nothing changed.";
  }
  return body.error ?? "The key could not be rotated. Nothing changed.";
}

export function RotateAuditKey({ onRotated }: { onRotated?: () => void }) {
  const { user, login } = useAuth();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();

  if (user?.role !== "owner") return null;

  function closeStepUp() {
    setStepUpOpen(false);
    setPassword("");
    setCode("");
    setStepUpError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setStepUpError(null);
    try {
      try {
        await login(email, password, { totp: code.trim() });
      } catch {
        setStepUpError("That didn't match. Check your email, password and code, then try again.");
        return;
      }
      const res = await authFetch("/api/activity/rotate-key", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        newKeyId?: string;
      };
      setOutcome(
        res.ok && body.newKeyId
          ? { kind: "ok", newKeyId: body.newKeyId }
          : { kind: "error", message: rotateErrorMessage(res.status, body) },
      );
      closeStepUp();
      if (res.ok) onRotated?.();
    } catch {
      setStepUpError("We couldn't reach your Droplet. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div className="type-headline" style={{ color: "var(--text)" }}>
            Audit signing key
          </div>
          <p className="type-footnote" style={{ color: "var(--text-muted)", marginTop: 2 }}>
            Rotate it if an old audit export left the box. Owner only.
          </p>
        </div>
        <button
          ref={triggerRef}
          type="button"
          className="btn sm danger"
          onClick={() => {
            setOutcome(null);
            setConfirmOpen(true);
          }}
        >
          <KeyRound size={13} aria-hidden />
          Rotate audit signing key
        </button>
      </div>

      {outcome?.kind === "ok" && (
        <p role="status" className="type-footnote" style={{ marginTop: 10, color: "var(--text)" }}>
          Key rotated. New key ID: <code>{outcome.newKeyId}</code>
        </p>
      )}
      {outcome?.kind === "error" && (
        <p role="alert" className="type-footnote" style={{ marginTop: 10, color: "var(--danger)" }}>
          {outcome.message}
        </p>
      )}

      <ConfirmDialog
        open={confirmOpen}
        triggerRef={triggerRef}
        title="Rotate the audit signing key?"
        description={ROTATE_EXPLAINER}
        confirmLabel="Continue"
        variant="destructive"
        onConfirm={() => setStepUpOpen(true)}
        onCancel={() => setConfirmOpen(false)}
      />

      <Dialog
        open={stepUpOpen}
        onClose={closeStepUp}
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
            Sign in again with your two-factor code. The key rotates as soon as you do.
          </p>
          <label className="block type-footnote">
            Email
            <input
              className="w-full"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="block type-footnote">
            Password
            <input
              className="w-full"
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
              className="w-full"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          {stepUpError && (
            <p role="alert" className="type-footnote" style={{ color: "var(--danger)" }}>
              {stepUpError}
            </p>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" className="btn" onClick={closeStepUp} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn danger" disabled={busy}>
              {busy ? "Rotating…" : "Rotate key"}
            </button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
