"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  UserPlus,
  Users,
} from "lucide-react";
import { getEnabledSsoProviders, postTeamInvite, createUser, InviteError } from "@/lib/api";
import { generateTempPassword } from "@droplet/auth-policy";
import { ssoProviderName } from "@/lib/sso-providers";
import type { TeamInviteRole } from "@/lib/types";
import { useAuth } from "@/lib/auth";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";
import { ScrollRegion } from "@/components/setup/ScrollRegion";
import { Dialog } from "@/components/Dialog";
import { ThemedSelect } from "@/components/ui/ThemedSelect";

/** Invite people or create local accounts. Both paths persist immediately; SSO provider discovery reports sign-in availability, not directory sync. */

/** Roles the invite select offers — the shipped household model. Value is the
 *  wire role; label is the human name. */
const ROLE_OPTIONS: ReadonlyArray<{ value: TeamInviteRole; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "family", label: "Member" },
  { value: "guest", label: "External guest" },
  { value: "owner", label: "Owner" },
];

/**
 * WARP-1049 — role rank, mirroring the orchestrator's `ROLE_RANK`
 * (auth-groups / jwt.service). The server's `roleOutranks(role, caller)` guard
 * rejects any assignment whose rank exceeds the caller's own, so the picker
 * must never OFFER a role the caller cannot actually grant (offer-then-reject
 * is a worse experience than not offering it). Kept in sync with the server by
 * value; the server remains the authority (this is defense-in-depth + UX).
 */
const ROLE_RANK: Record<TeamInviteRole, number> = {
  guest: 0,
  family: 1,
  admin: 2,
  owner: 3,
};

/**
 * The role options a caller of `callerRole` may actually assign — everything at
 * or below their own rank, matching the server's `roleOutranks` cap. When the
 * caller's role is unknown (a pre-WARP-279 cached profile with no `role`), fall
 * back to the full list and let the server guard be the sole authority rather
 * than over-restricting a legitimate owner/admin — the picker is a convenience,
 * never the security boundary.
 */
function roleOptionsForCaller(
  callerRole: TeamInviteRole | undefined,
): ReadonlyArray<{ value: TeamInviteRole; label: string }> {
  if (!callerRole) return ROLE_OPTIONS;
  const cap = ROLE_RANK[callerRole];
  return ROLE_OPTIONS.filter((o) => ROLE_RANK[o.value] <= cap);
}

/** Client-side email shape — mirrors onboarding-team-invite.service's EMAIL_SHAPE
 *  so the wizard blocks an obviously-bad address before the round-trip. The
 *  server is authoritative. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/;

/** A locally-tracked pending member (post-create).
 *
 * `kind` distinguishes the two paths the wizard offers:
 *   - "invite": an emailed/linked invitation (postTeamInvite) — the member
 *     sets their own password when they accept.
 *   - "account": a local account created NOW (createUser, WARP-1049) with a
 *     temporary password the operator hands off; the member is forced to
 *     choose their own at first sign-in by the WARP-824 password-change gate.
 */
interface PendingInvite {
  email: string;
  role: TeamInviteRole;
  kind: "invite" | "account";
  sendStatus?: "sent" | "failed";
}

/** Two-letter initials from an email local-part, for the avatar. */
function initialsFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  const parts = local.split(/[._+-]+/).filter(Boolean);
  const letters =
    parts.length >= 2
      ? `${parts[0][0]}${parts[1][0]}`
      : local.slice(0, 2);
  return letters.toUpperCase();
}

/** Human label for a wire role (falls back to the raw value). */
function roleLabel(role: TeamInviteRole): string {
  return ROLE_OPTIONS.find((o) => o.value === role)?.label ?? role;
}

export function TeamStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  // WARP-1049: cap the role picker to what the CALLER can actually grant. The
  // server's roleOutranks guard is the authority (it rejects an over-rank
  // assignment with 403 ROLE_RANK_EXCEEDED regardless of what the client
  // sends); filtering the options here is defense-in-depth + right-first-time
  // UX so an admin never sees "Owner" as a selectable option only to be
  // rejected. `useAuth` is already in scope for sibling wizard steps.
  const { user } = useAuth();
  const callerRole = user?.role as TeamInviteRole | undefined;
  const roleOptions = useMemo(
    () => roleOptionsForCaller(callerRole),
    [callerRole],
  );
  // A role the caller cannot grant must never be the initial/selected value.
  // "family" is the natural default and is available to every rank except a
  // guest caller; clamp to the highest option the caller CAN grant when the
  // default isn't offered (a guest can only ever create a guest).
  const defaultRole: TeamInviteRole = useMemo(() => {
    if (roleOptions.some((o) => o.value === "family")) return "family";
    return roleOptions[roleOptions.length - 1]?.value ?? "guest";
  }, [roleOptions]);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamInviteRole>(defaultRole);
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // Provider discovery is best-effort; invitations remain available if it fails.
  const [ssoProviders, setSsoProviders] = useState<string[] | null>(null);
  const [ssoError, setSsoError] = useState(false);
  useEffect(() => {
    let alive = true;
    // A failed read is distinct from an explicitly empty provider list.
    void (async () => {
      try {
        const providers = await getEnabledSsoProviders();
        if (alive) setSsoProviders(providers);
      } catch {
        if (alive) {
          setSsoProviders([]);
          setSsoError(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const ssoLoading = ssoProviders === null;
  const ssoConnected = !ssoLoading && ssoProviders.length > 0;

  const normalizedEmail = useMemo(() => email.trim().toLowerCase(), [email]);

  const handleAdd = useCallback(async () => {
    if (adding) return;
    setEmailError(null);
    if (!normalizedEmail || !EMAIL_SHAPE.test(normalizedEmail)) {
      setEmailError("Enter a valid email address (e.g. name@acme.co).");
      return;
    }

    setAdding(true);
    try {
      const result = await postTeamInvite({ email: email.trim(), role });
      // Use the server-normalized email + role so the list matches what was
      // actually stored.
      setInvites((prev) => [
        ...prev,
        { email: result.email, role: result.role, kind: "invite", sendStatus: result.send_status },
      ]);
      setEmail("");
      // Return focus to the email field for fast successive invites.
      emailRef.current?.focus();
    } catch (err) {
      if (err instanceof InviteError && err.roleInvalid) {
        setEmailError(err.message);
      } else if (err instanceof InviteError) {
        // Email-invalid or generic — both surface on the email field (the only
        // free-text input the customer can correct).
        setEmailError(err.message);
      } else {
        setEmailError(
          err instanceof Error
            ? err.message
            : "Couldn't send that invite. Try again in a moment.",
        );
      }
    } finally {
      setAdding(false);
    }
  }, [adding, email, normalizedEmail, role]);

  // ── WARP-1049: "Create local account" dialog ──
  // The setup person mints a member NOW with an auto-generated temporary
  // password (show-once + copy + regenerate). The account is created
  // immediately (POST /auth/users, mustChangePassword=true); the member signs
  // in at the normal login page with the temp password and is FORCED to set
  // their own before touching anything (the WARP-824 requirePasswordChangeGate).
  const [showAccountDialog, setShowAccountDialog] = useState(false);
  const [acctEmail, setAcctEmail] = useState("");
  const [acctName, setAcctName] = useState("");
  const [acctRole, setAcctRole] = useState<TeamInviteRole>(defaultRole);
  // The generated temp password is created fresh each time the dialog opens (and
  // on Regenerate). It is a real secret — crypto.getRandomValues via
  // @droplet/auth-policy — and is shown ONCE, then handed off out-of-band.
  const [acctPassword, setAcctPassword] = useState("");
  const [acctError, setAcctError] = useState<string | null>(null);
  const [acctCreating, setAcctCreating] = useState(false);
  const [acctCopied, setAcctCopied] = useState(false);
  // Post-create hand-off phase: the operator gives the member the email +
  // temp password. `null` = the form; a value = the hand-off view.
  const [acctCreated, setAcctCreated] = useState<{
    email: string;
    password: string;
    role: TeamInviteRole;
  } | null>(null);
  const createAccountTriggerRef = useRef<HTMLButtonElement>(null);

  const openAccountDialog = useCallback(() => {
    setAcctEmail("");
    setAcctName("");
    setAcctRole(defaultRole);
    setAcctPassword(generateTempPassword());
    setAcctError(null);
    setAcctCreated(null);
    setAcctCopied(false);
    setShowAccountDialog(true);
  }, [defaultRole]);

  const closeAccountDialog = useCallback(() => {
    setShowAccountDialog(false);
  }, []);

  const regeneratePassword = useCallback(() => {
    setAcctPassword(generateTempPassword());
    setAcctCopied(false);
  }, []);

  const copyPassword = useCallback(async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setAcctCopied(true);
      setTimeout(() => setAcctCopied(false), 2000);
    } catch {
      // Clipboard can be blocked in an insecure context; the value stays
      // visible so the operator can select it manually.
    }
  }, []);

  const handleCreateAccount = useCallback(async () => {
    if (acctCreating) return; // double-submit guard
    setAcctError(null);
    const normalized = acctEmail.trim().toLowerCase();
    if (!normalized || !EMAIL_SHAPE.test(normalized)) {
      setAcctError("Enter a valid email address (e.g. name@acme.co).");
      return;
    }

    setAcctCreating(true);
    try {
      await createUser(
        acctEmail.trim(),
        acctPassword,
        acctName.trim() || undefined,
        true, // mustChangePassword — hard-wired; the member sets their own first
        acctRole,
      );
      // Track the member in the pending list AND flip to the hand-off phase.
      setInvites((prev) => [
        ...prev,
        { email: normalized, role: acctRole, kind: "account" },
      ]);
      setAcctCreated({ email: normalized, password: acctPassword, role: acctRole });
    } catch (err) {
      const code = (err as { code?: string })?.code;
      if (code === "EMAIL_TAKEN") {
        setAcctError("That email address is already in use.");
      } else if (code === "ROLE_RANK_EXCEEDED") {
        setAcctError("You can't create an account with a role higher than your own.");
      } else if (code === "WEAK_PASSWORD") {
        // Should be unreachable — the generator always meets policy — but never
        // strand the operator on a silent failure.
        setAcctError("The temporary password didn't meet the requirements. Regenerate it and try again.");
      } else {
        // WARP-1049 defensive default: every code THIS route emits today is
        // mapped above to calm human copy, so this branch is only reached by an
        // unmapped (e.g. future) code. Surface a calm generic message rather
        // than the raw `err.message` so a technical/typed string can never
        // reach a home user — the mapped branches above still render their
        // tailored copy.
        setAcctError("Couldn't create that account. Try again in a moment.");
      }
    } finally {
      setAcctCreating(false);
    }
  }, [acctCreating, acctEmail, acctName, acctPassword, acctRole]);

  return (
    <StepShell
      current="team"
      title="Bring in your team"
      subtitle="Invite people and choose their roles — they map to what the AI is allowed to do on their behalf."
      primary={{
        label: "Continue",
        onClick: onComplete,
        disabled: adding || acctCreating,
      }}
      skip={adding || acctCreating ? undefined : { label: "I'll invite people later", onClick: onSkip }}
    >
      {/* Configured team sign-in providers. */}
      <div
        data-testid="directory-sync-panel"
        className={`flex items-center gap-3.5 rounded-xl border px-4 py-3.5 mb-[clamp(16px,3vh,24px)] ${
          ssoConnected
            ? "border-accent/20 bg-accent-subtle"
            : "border-separator bg-surface-secondary"
        }`}
      >
        <Users
          size={20}
          className={`flex-shrink-0 ${ssoConnected ? "text-accent" : "text-label-tertiary"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="type-footnote font-semibold text-label-primary">
            {ssoLoading
              ? "Team sign-in"
              : ssoConnected
                ? "Team sign-in is available"
                : ssoError
                  ? "Team sign-in couldn’t be checked"
                  : "Team sign-in isn’t configured"}
          </p>
          <p className="type-caption-1 text-label-tertiary mt-0.5">
            {ssoLoading
              ? "Checking whether team sign-in is configured…"
              : ssoConnected
                ? `People can sign in with ${ssoProviders
                    .map(ssoProviderName)
                    .join(", ")}. Each person authorizes sign-in with the provider.`
                : "Invite people by email below or create a local account. An administrator can configure team sign-in separately."}
          </p>
        </div>
        {ssoConnected && (
          <span className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-system-green/15 px-3 py-1.5 type-caption-1 font-semibold text-system-green">
            <Check size={13} aria-hidden="true" />
            Available
          </span>
        )}
      </div>

      {/* Invite row: email + role + Add */}
      <div className="flex items-end gap-3">
        <label htmlFor="team-email" className="min-w-0 flex-1">
          <span className="type-footnote font-medium text-label-secondary mb-1.5 block">
            Invite by email
          </span>
          <input
            id="team-email"
            ref={emailRef}
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError(null);
            }}
            placeholder="name@acme.co"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={emailError !== null}
            className={[
              "dp-input",
              emailError ? "ring-2 ring-system-red/40" : "",
            ].join(" ")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !adding) {
                e.preventDefault();
                void handleAdd();
              }
            }}
          />
        </label>
        <label htmlFor="team-role" className="w-36 flex-shrink-0">
          <span className="type-footnote font-medium text-label-secondary mb-1.5 block">
            Role
          </span>
          <div className="relative">
            <ThemedSelect
              id="team-role"
              value={role}
              onChange={(e) => setRole(e.target.value as TeamInviteRole)}
              className="dp-input appearance-none pr-9"
            >
              {roleOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </ThemedSelect>
          </div>
        </label>
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={adding}
          className="dp-btn-secondary flex flex-shrink-0 items-center gap-1.5"
        >
          <Plus size={15} aria-hidden="true" />
          Add
        </button>
      </div>

      {emailError && (
        <p
          role="alert"
          className="type-caption-1 text-system-red mt-1.5 flex items-start gap-1.5"
        >
          <AlertCircle size={13} className="mt-px flex-shrink-0" />
          <span>{emailError}</span>
        </p>
      )}

      {/* WARP-1049 — the second path: create a local account NOW with a
          temporary password, for people who don't have (or don't check) email.
          Kept as a quieter secondary affordance so the email-invite row stays
          the primary path; both share the same role vocabulary + pending list. */}
      <button
        ref={createAccountTriggerRef}
        type="button"
        onClick={openAccountDialog}
        className="mt-3 inline-flex items-center gap-1.5 type-footnote font-medium text-accent transition-colors duration-200 ease-smooth hover:text-accent/80"
      >
        <UserPlus size={14} aria-hidden="true" />
        Or create a local account with a temporary password
      </button>

      {/* Pending invitee list. WARP-820: this list grows without bound as the
          owner adds people, so it lives in a <ScrollRegion> (the wizard's
          single scroll surface) — the invite row + the CTA stay pinned while
          only the list scrolls once it's long. */}
      {invites.length > 0 && (
        <ScrollRegion aria-label="Pending invitations" className="mt-4">
          <ul className="overflow-hidden rounded-xl border border-separator">
            {invites.map((invite, i) => (
              <li
                key={invite.email}
                className={[
                  "flex items-center gap-3 px-3.5 py-3 animate-fade-rise",
                  i > 0 ? "border-t border-separator" : "",
                ].join(" ")}
              >
                <span
                  aria-hidden="true"
                  className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent-subtle type-caption-2 font-semibold text-accent"
                >
                  {initialsFromEmail(invite.email)}
                </span>
                <span className="min-w-0 flex-1 truncate type-footnote text-label-primary">
                  {invite.email}
                </span>
                <span className="dp-status-chip !h-7 !px-2.5">
                  {roleLabel(invite.role)}
                </span>
                <span className="type-caption-1 text-label-tertiary">
                  {invite.kind === "account"
                    ? "Account ready"
                    : invite.sendStatus === "failed"
                      ? "Email not sent"
                      : invite.sendStatus === "sent"
                        ? "Email sent"
                        : "Invitation created"}
                </span>
              </li>
            ))}
          </ul>
        </ScrollRegion>
      )}

      <p className="type-caption-1 text-label-tertiary mt-4 leading-relaxed">
        {invites.length > 0
          ? "Invitations and accounts are created immediately. Manage them and change roles from People after setup."
          : "Roles can be changed anytime in People → Roles."}
      </p>
      {invites.some((invite) => invite.sendStatus === "failed") && (
        <p role="alert" className="type-footnote text-system-orange mt-2">
          An invitation was created, but its email wasn’t sent. Retry delivery from People after setup.
        </p>
      )}


      <LearnMoreCard helpAnchor="roles">
        <p>
          Each role maps to what Droplet&rsquo;s AI may do on that
          person&rsquo;s behalf — an <span className="font-semibold">Admin</span>{" "}
          can manage people and the network, a{" "}
          <span className="font-semibold">Member</span> works with cameras,
          files, and chat, and an{" "}
          <span className="font-semibold">External guest</span> is scoped to
          their own sessions.
        </p>

        <p>
          {ssoConnected ? (
            <>
              Your identity provider is configured for sign-in. Each person
              signs in with that provider; this does not import everyone in
              its directory.
            </>
          ) : (
            <>
              Team sign-in is separate from connecting a personal Google or
              Microsoft account. Invite people here, or create local accounts
              so they can sign in without a provider.
            </>
          )}
        </p>
      </LearnMoreCard>

      {/* WARP-1049 — Create-local-account dialog. Reuses the canonical Dialog
          primitive so it gets ARIA + focus-trap + scroll-lock + the shared
          restraint-first fade/scale motion for free. Two phases: the form, then
          a hand-off view once the account exists. */}
      <Dialog
        open={showAccountDialog}
        onClose={closeAccountDialog}
        triggerRef={createAccountTriggerRef}
        labelledBy="create-account-title"
        describedBy="create-account-sub"
        maxWidth="md"
      >
        {/* Body padding comes from the <Dialog> primitive (WARP-1153). */}
        <div>
          {acctCreated === null ? (
            <>
              <div className="mb-4 flex items-start gap-3">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-accent-subtle text-accent">
                  <UserPlus size={17} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2
                    id="create-account-title"
                    className="type-headline font-semibold text-label-primary"
                  >
                    Create a local account
                  </h2>
                  <p
                    id="create-account-sub"
                    className="type-footnote text-label-tertiary mt-0.5"
                  >
                    They&rsquo;ll sign in with a temporary password, then choose
                    their own on first sign-in.
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <label htmlFor="acct-name" className="block">
                  <span className="type-footnote font-medium text-label-secondary mb-1.5 block">
                    Name <span className="text-label-tertiary font-normal">(optional)</span>
                  </span>
                  <input
                    id="acct-name"
                    type="text"
                    value={acctName}
                    onChange={(e) => setAcctName(e.target.value)}
                    placeholder="Alex Rivera"
                    autoComplete="off"
                    className="dp-input"
                  />
                </label>

                <label htmlFor="acct-email" className="block">
                  <span className="type-footnote font-medium text-label-secondary mb-1.5 block">
                    Email
                  </span>
                  <input
                    id="acct-email"
                    type="email"
                    value={acctEmail}
                    onChange={(e) => {
                      setAcctEmail(e.target.value);
                      if (acctError) setAcctError(null);
                    }}
                    placeholder="name@acme.co"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={acctError !== null}
                    className={[
                      "dp-input",
                      acctError ? "ring-2 ring-system-red/40" : "",
                    ].join(" ")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !acctCreating) {
                        e.preventDefault();
                        void handleCreateAccount();
                      }
                    }}
                  />
                  <span className="type-caption-1 text-label-tertiary mt-1 block">
                    Used to sign in — it doesn&rsquo;t need to receive mail.
                  </span>
                </label>

                <label htmlFor="acct-role" className="block">
                  <span className="type-footnote font-medium text-label-secondary mb-1.5 block">
                    Role
                  </span>
                  <div className="relative">
                    <ThemedSelect
                      id="acct-role"
                      value={acctRole}
                      onChange={(e) => setAcctRole(e.target.value as TeamInviteRole)}
                      className="dp-input appearance-none pr-9"
                    >
                      {roleOptions.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </ThemedSelect>
                  </div>
                </label>

                {/* Generated temporary password — show-once, copy, regenerate. */}
                <div>
                  <span className="type-footnote font-medium text-label-secondary mb-1.5 block">
                    Temporary password
                  </span>
                  <div className="flex items-center gap-2">
                    <div className="dp-input flex min-w-0 flex-1 items-center gap-2 !py-2">
                      <KeyRound
                        size={14}
                        className="flex-shrink-0 text-label-tertiary"
                        aria-hidden="true"
                      />
                      <input
                        aria-label="Temporary password"
                        readOnly
                        value={acctPassword}
                        className="min-w-0 flex-1 bg-transparent font-mono type-footnote text-label-primary outline-none"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyPassword(acctPassword)}
                      className="dp-btn-secondary flex flex-shrink-0 items-center gap-1.5"
                      aria-label="Copy temporary password"
                    >
                      {acctCopied ? <Check size={14} /> : <Copy size={14} />}
                      {acctCopied ? "Copied" : "Copy"}
                    </button>
                    <button
                      type="button"
                      onClick={regeneratePassword}
                      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-label-tertiary transition-colors duration-200 ease-smooth hover:bg-surface-tertiary hover:text-label-secondary"
                      aria-label="Regenerate temporary password"
                    >
                      <RefreshCw size={15} />
                    </button>
                  </div>
                  <span className="type-caption-1 text-label-tertiary mt-1 block">
                    You&rsquo;ll see this once — copy it now to hand off.
                  </span>
                </div>
              </div>

              {acctError && (
                <p
                  role="alert"
                  className="type-caption-1 text-system-red mt-3 flex items-start gap-1.5"
                >
                  <AlertCircle size={13} className="mt-px flex-shrink-0" />
                  <span>{acctError}</span>
                </p>
              )}

              <div className="mt-5 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={closeAccountDialog}
                  className="dp-btn-secondary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreateAccount()}
                  disabled={acctCreating}
                  className="dp-btn-primary flex items-center gap-1.5"
                >
                  {acctCreating ? "Creating…" : "Create account"}
                </button>
              </div>
            </>
          ) : (
            /* Hand-off phase — the account exists; give the member these
               credentials out-of-band. */
            <>
              <div className="mb-4 flex items-start gap-3">
                <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-system-green/15 text-system-green">
                  <Check size={18} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                  <h2
                    id="create-account-title"
                    className="type-headline font-semibold text-label-primary"
                  >
                    Account ready
                  </h2>
                  <p
                    id="create-account-sub"
                    className="type-footnote text-label-tertiary mt-0.5"
                  >
                    Give {acctCreated.email} this email and temporary password.
                    They&rsquo;ll be asked to choose their own at first sign-in.
                  </p>
                </div>
              </div>

              <div className="rounded-xl border border-separator overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="type-caption-1 text-label-tertiary">Email</span>
                  <span className="min-w-0 truncate type-footnote text-label-primary">
                    {acctCreated.email}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-3 border-t border-separator px-4 py-3">
                  <span className="type-caption-1 text-label-tertiary">
                    Temporary password
                  </span>
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate font-mono type-footnote text-label-primary">
                      {acctCreated.password}
                    </span>
                    <button
                      type="button"
                      onClick={() => void copyPassword(acctCreated.password)}
                      className="flex flex-shrink-0 items-center gap-1 type-caption-1 font-medium text-accent transition-colors duration-200 ease-smooth hover:text-accent/80"
                      aria-label="Copy temporary password"
                    >
                      {acctCopied ? <Check size={13} /> : <Copy size={13} />}
                      {acctCopied ? "Copied" : "Copy"}
                    </button>
                  </div>
                </div>
              </div>

              <div className="mt-5 flex items-center justify-end">
                <button
                  type="button"
                  onClick={closeAccountDialog}
                  className="dp-btn-primary"
                >
                  Done
                </button>
              </div>
            </>
          )}
        </div>
      </Dialog>
    </StepShell>
  );
}
