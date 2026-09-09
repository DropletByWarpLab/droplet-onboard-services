"use client";

/**
 * /invite/[token] — public invite-acceptance page.
 *
 * Flow (mirrors WARP-217 acceptance):
 *   1. Fetch invite metadata via getInvite(token). 404/410 → friendly
 *      "no longer valid" screen.
 *   2. Render password + confirm form. Same dp-input + Lock icon idiom as
 *      /login so the auth surface feels consistent.
 *   3. Submit → acceptInvite(token, password). On success the orchestrator
 *      sets cookies and we cross-fade into <WelcomeFlourish />, which
 *      handles its own redirect to "/".
 *
 * Errors are translated to plain language (no raw status codes). Username
 * + display name are read-only — the admin pre-claimed them.
 */

import { useCallback, useEffect, useId, useState, use } from "react";
import Link from "next/link";
import { Lock, User as UserIcon, Eye, EyeOff } from "lucide-react";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { WelcomeFlourish } from "@/components/auth/WelcomeFlourish";
import { PasswordRulesChecklist } from "@/components/auth/PasswordRulesChecklist";
import { validatePassword } from "@droplet/auth-policy";
import { getInvite, acceptInvite } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import type { InvitePublicInfo } from "@/lib/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "invalid"; reason: "missing" | "used" | "expired" }
  | { kind: "ready"; info: InvitePublicInfo }
  | { kind: "accepted"; displayName: string | null };

interface PageProps {
  params: Promise<{ token: string }>;
}

export default function InviteAcceptPage(props: PageProps) {
  const params = use(props.params);
  const { token } = params;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // WARP-650: label/input associations for the invite-acceptance form.
  const usernameId = useId();
  const displayNameId = useId();
  const passwordId = useId();
  const confirmId = useId();

  const loadInvite = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const info = await getInvite(token);
      setState({ kind: "ready", info });
    } catch (err: any) {
      const status: number | undefined = err?.status;
      const code: string | undefined = err?.code;
      if (status === 410 && code === "USED") {
        setState({ kind: "invalid", reason: "used" });
      } else if (status === 410 && code === "EXPIRED") {
        setState({ kind: "invalid", reason: "expired" });
      } else {
        setState({ kind: "invalid", reason: "missing" });
      }
    }
  }, [token]);

  useEffect(() => {
    loadInvite();
  }, [loadInvite]);

  const handleSubmit = async () => {
    setError(null);
    if (!validatePassword(password).ok) {
      setError("Password doesn't meet the requirements yet.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setSubmitting(true);
    try {
      await acceptInvite(token, password);
      const displayName =
        state.kind === "ready" ? state.info.displayName : null;
      setState({ kind: "accepted", displayName });
    } catch (err: any) {
      setError(translateError(err, "invite"));
    } finally {
      setSubmitting(false);
    }
  };

  // ── Accepted: hand the moment off to <WelcomeFlourish /> ──
  if (state.kind === "accepted") {
    return (
      <div className="min-h-screen bg-surface-primary flex items-center justify-center p-6">
        <WelcomeFlourish
          displayName={state.displayName ?? undefined}
          subtitle="You're now part of this Droplet."
        />
      </div>
    );
  }

  // ── Invalid invite: friendly "no longer valid" screen ──
  if (state.kind === "invalid") {
    const headline =
      state.reason === "used"
        ? "This invite has already been used"
        : state.reason === "expired"
          ? "This invite has expired"
          : "This invite is no longer valid";
    const subline =
      state.reason === "used"
        ? "Looks like someone already accepted this invite. If that wasn't you, ask the admin who invited you."
        : state.reason === "expired"
          ? "Invites are time-limited for safety. Ask the admin who invited you to send a fresh link."
          : "We couldn't find this invite. It may have been revoked or the link copied incorrectly.";

    return (
      <AuthLayout title={headline} subtitle={subline}>
        <Link href="/login" className="dp-btn-primary w-full">
          Go to sign in
        </Link>
      </AuthLayout>
    );
  }

  // ── Loading: small placeholder so the page never flashes empty ──
  if (state.kind === "loading") {
    return (
      /* Neutral title on purpose — we don't yet know the invite is valid,
         and "You've been invited" flipping to "This invite has expired"
         a beat later reads as a bait-and-switch. */
      <AuthLayout
        title="Checking your invite"
        subtitle="One moment while we look this up."
      >
        {null}
      </AuthLayout>
    );
  }

  // ── Ready: invite is valid; render the password form ──
  const { info } = state;
  return (
    <AuthLayout
      title="You've been invited"
      subtitle="Set a password to join this Droplet."
      footer="Your password is stored on this box — it never leaves your local network."
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor={usernameId}
            className="type-footnote font-semibold text-label-secondary block mb-1.5"
          >
            Username
          </label>
          <div className="relative">
            <UserIcon
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              id={usernameId}
              type="text"
              value={info.username}
              readOnly
              aria-readonly
              className="dp-input pl-10 cursor-not-allowed"
            />
          </div>
        </div>

        {info.displayName && (
          <div>
            <label
              htmlFor={displayNameId}
              className="type-footnote font-semibold text-label-secondary block mb-1.5"
            >
              Display name
            </label>
            <input
              id={displayNameId}
              type="text"
              value={info.displayName}
              readOnly
              aria-readonly
              className="dp-input cursor-not-allowed"
            />
          </div>
        )}

        <div>
          <label
            htmlFor={passwordId}
            className="type-footnote font-semibold text-label-secondary block mb-1.5"
          >
            Choose a password
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              id={passwordId}
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create a password"
              autoComplete="new-password"
              className="dp-input pl-10 pr-10"
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
            <button
              type="button"
              onClick={() => setShowPassword((s) => !s)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-label-tertiary hover:text-label-secondary"
              aria-label={showPassword ? "Hide password" : "Show password"}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>

        <div>
          <label
            htmlFor={confirmId}
            className="type-footnote font-semibold text-label-secondary block mb-1.5"
          >
            Confirm password
          </label>
          <div className="relative">
            <Lock
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
            <input
              id={confirmId}
              type={showPassword ? "text" : "password"}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Type it again"
              autoComplete="new-password"
              className="dp-input pl-10"
              onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            />
          </div>
        </div>

        <PasswordRulesChecklist password={password} confirm={confirm} />

        {error && (
          <p className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            {error}
          </p>
        )}

        <button
          onClick={handleSubmit}
          disabled={submitting}
          className="dp-btn-primary w-full"
        >
          {submitting ? "Accepting…" : "Accept invite"}
        </button>
      </div>
    </AuthLayout>
  );
}
