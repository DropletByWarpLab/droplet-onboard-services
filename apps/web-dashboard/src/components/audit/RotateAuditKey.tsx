"use client";

/**
 * WARP-3180 — owner-only "Rotate audit signing key" on the Audit log page.
 *
 * Calls POST /api/activity/rotate-key (WARP-3165, PR #2417): owner only, an
 * MFA confirmation less than 60 s old, rate-limited, audited. The server is
 * the gate; hiding the control from admins and members is presentation only.
 *
 * Two red confirms: the first explains why and what happens, the second is
 * the step-up (<StepUpDialog>: password + code for THIS session, via
 * POST /api/auth/step-up), after which the rotation is called at once.
 */
import { useRef, useState } from "react";
import { KeyRound } from "lucide-react";
import { authFetch, useAuth } from "@/lib/auth";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { StepUpDialog } from "@/components/auth/StepUpDialog";

export const ROTATE_EXPLAINER =
  "Rotate the key if an audit bundle exported by an earlier Droplet version left the box: those bundles carried the signing key. New entries are signed with a new key right away. Earlier entries stay verifiable, because the old key is kept on the box for checking only. This is recorded in the audit log.";

type Outcome =
  | { kind: "running" }
  | { kind: "ok"; newKeyId: string }
  | { kind: "error"; message: string };

/** Plain-English copy for each refusal the route can answer. */
export function rotateErrorMessage(status: number, body: { error?: string; code?: string }): string {
  if (status === 401 && (body.error === "mfa_stale" || body.error === "mfa_required")) {
    return "The confirmation expired before the key could rotate. Try again.";
  }
  if (status === 401) return "Your session ended. Sign in again, then try again. Nothing changed.";
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
  const { user } = useAuth();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (user?.role !== "owner") return null;

  async function rotate() {
    setOutcome({ kind: "running" });
    try {
      const res = await authFetch("/api/activity/rotate-key", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        code?: string;
        newKeyId?: string;
      };
      if (res.ok && body.newKeyId) {
        setOutcome({ kind: "ok", newKeyId: body.newKeyId });
        onRotated?.();
      } else {
        setOutcome({ kind: "error", message: rotateErrorMessage(res.status, body) });
      }
    } catch {
      setOutcome({ kind: "error", message: "We couldn't reach your Droplet. Nothing changed." });
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
          disabled={outcome?.kind === "running"}
          onClick={() => {
            setOutcome(null);
            setConfirmOpen(true);
          }}
        >
          <KeyRound size={13} aria-hidden />
          Rotate audit signing key
        </button>
      </div>

      {outcome?.kind === "running" && (
        <p role="status" className="type-footnote" style={{ marginTop: 10, color: "var(--text-muted)" }}>
          Rotating the key…
        </p>
      )}
      {outcome?.kind === "ok" && (
        <p role="status" className="type-footnote" style={{ marginTop: 10, color: "var(--text)" }}>
          Key rotated. New key ID: <code>{outcome.newKeyId}</code>
        </p>
      )}
      {outcome?.kind === "error" && (
        <p role="alert" className="type-footnote" style={{ marginTop: 10, color: "var(--danger-ink)" }}>
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

      <StepUpDialog
        open={stepUpOpen}
        onClose={() => setStepUpOpen(false)}
        onVerified={rotate}
        onError={(message) => setOutcome({ kind: "error", message })}
        actionLabel="Rotate key"
        destructive
        triggerRef={triggerRef}
      />
    </div>
  );
}
