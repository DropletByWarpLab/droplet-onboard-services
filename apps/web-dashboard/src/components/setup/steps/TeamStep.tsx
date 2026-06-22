"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, Plus, Users, X } from "lucide-react";
import { getEnabledSsoProviders, postTeamInvite, InviteError } from "@/lib/api";
import type { TeamInviteRole } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";
import { ScrollRegion } from "@/components/setup/ScrollRegion";

/**
 * Wizard step — Team (PR #381), the LAST onboarding step. Slots near the END:
 * welcome → … → ai → TEAM → done.
 *
 * "You're set up — now bring people in." The owner invites teammates by email +
 * role, or notes the directory-sync (SSO) alternative. Per the spec + #371
 * handoff §4 + OnbWizard.jsx `WizTeam`.
 *
 * Team IS skippable ("I'll invite people later" — a solo owner is a valid end
 * state), so this step takes BOTH an `onComplete` (Send invites & continue) and
 * an `onSkip`, the same contract the other skippable steps use.
 *
 * PR #384 — reflowed into the shared aurora-rail `StepShell` (was a bespoke
 * centered column with in-body CTAs). `StepShell current="team"` owns the
 * "Step N" kicker, the "Bring in your team" title + sub, the container fade,
 * and the footer primary ("Send invites & continue") + skip ("I'll invite
 * people later"). The body below is the SSO card + invite UI. Functional
 * behavior is unchanged.
 *
 * Structure (mirrors the WizTeam design):
 *   - Directory-sync (SSO) note card — the bulk alternative (OIDC / Okta /
 *     Entra / Google Workspace), stays on the LAN.
 *   - Invite row: email input + role select + Add. Each Add POSTs
 *     /api/people/invite and, on success, appends the invitee to the pending
 *     list and clears the email for the next one.
 *   - Pending invitee list: neutral initials avatar + email + role chip +
 *     remove control.
 *
 * Edge cases:
 *   - Invalid email (client-side shape check) → inline error on the email
 *     field; NO network call, invitee not added.
 *   - Server-rejected invite (InviteError) → inline error; invitee not added.
 *
 * ── ROLE MODEL (the scaffold's OPEN fork, resolved → HOUSEHOLD) ──
 * The role select offers the SHIPPED HOUSEHOLD model (owner / admin / family /
 * guest) — the Prisma `Role` enum + the existing `/auth/invites` route already
 * ship it, and the appliance is home-first (ADR-002). The business fork
 * (manager / member / viewer) is NOT offered; switching is a Role-enum
 * migration + a separate ticket. Decision flagged in the PR self-assessment.
 *
 * Token mappings (no hardcoded hex): SSO card → `bg-accent-subtle` +
 * `text-accent`; inputs → `dp-input`; primary CTA → `dp-btn-primary`; secondary
 * Add → `dp-btn-secondary`; the role CHIP uses the neutral `dp-status-chip`
 * treatment (border-separator / surface-tertiary / label-secondary) because the
 * design system has no `--role-family` color token — see the PR self-assessment
 * (token gap flagged for UI/UX). Motion: the StepShell container fade the
 * other steps share, plus a restraint-first `animate-fade-rise` on each
 * newly-added invitee row.
 */

/** Roles the invite select offers — the shipped household model. Value is the
 *  wire role; label is the human name. */
const ROLE_OPTIONS: ReadonlyArray<{ value: TeamInviteRole; label: string }> = [
  { value: "admin", label: "Admin" },
  { value: "family", label: "Member" },
  { value: "guest", label: "Guest" },
  { value: "owner", label: "Owner" },
];

/** Client-side email shape — mirrors onboarding-team-invite.service's EMAIL_SHAPE
 *  so the wizard blocks an obviously-bad address before the round-trip. The
 *  server is authoritative. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/;

/** A locally-tracked pending invite (post-create). */
interface PendingInvite {
  email: string;
  role: TeamInviteRole;
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

/** Friendly names for the SSO provider IDs `getEnabledSsoProviders` returns
 *  (WARP-629). Unknown ids fall back to a capitalized id. */
const SSO_PROVIDER_LABELS: Record<string, string> = {
  google: "Google Workspace",
  okta: "Okta",
  entra: "Microsoft Entra",
  azuread: "Microsoft Entra",
  microsoft: "Microsoft Entra",
};

function ssoLabel(id: string): string {
  return (
    SSO_PROVIDER_LABELS[id.toLowerCase()] ??
    id.charAt(0).toUpperCase() + id.slice(1)
  );
}

export function TeamStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<TeamInviteRole>("family");
  const [invites, setInvites] = useState<PendingInvite[]>([]);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  // Directory-sync state, read from the real SSO discovery endpoint
  // (`GET /api/sso/oidc/providers`, the same WARP-629 surface the login page
  // uses). Best-effort: a rejection/timeout means "no directory configured" and
  // the card stays the informational local-first invite path — never a no-op
  // control. There is no in-wizard SSO *configuration* flow yet, so when none is
  // configured we show the option as a note rather than a button that does
  // nothing; when one IS configured we reflect that truthfully.
  const [ssoProviders, setSsoProviders] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    // Best-effort: ANY failure — a rejected/timed-out request, or the discovery
    // client simply being unavailable — leaves the local-first invite path
    // standing. The try wraps the call itself (not just the promise) so a
    // synchronous throw is caught too.
    void (async () => {
      try {
        const providers = await getEnabledSsoProviders();
        if (alive) setSsoProviders(providers);
      } catch {
        /* no directory configured */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  const ssoConnected = ssoProviders.length > 0;

  const normalizedEmail = useMemo(() => email.trim().toLowerCase(), [email]);

  const handleAdd = useCallback(async () => {
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
        { email: result.email, role: result.role },
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
  }, [email, normalizedEmail, role]);

  const handleRemove = useCallback((target: string) => {
    setInvites((prev) => prev.filter((i) => i.email !== target));
  }, []);

  return (
    <StepShell
      current="team"
      title="Bring in your team"
      subtitle="Invite people now or sync your whole directory. Roles map to what the AI is allowed to do on their behalf."
      primary={{
        label: invites.length > 0 ? "Send invites & continue" : "Continue",
        onClick: onComplete,
      }}
      skip={{ label: "I'll invite people later", onClick: onSkip }}
    >
      {/* Directory sync (SSO) — the bulk alternative. WARP-820: fluid bottom
          gap so the SSO card + invite row + pending list fit without scroll. */}
      <div className="flex items-center gap-3.5 rounded-xl border border-accent/20 bg-accent-subtle px-4 py-3.5 mb-[clamp(16px,3vh,24px)]">
        <Users size={20} className="flex-shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <p className="type-footnote font-semibold text-label-primary">
            {ssoConnected
              ? "Directory sync is on"
              : "Sync your directory instead"}
          </p>
          <p className="type-caption-1 text-label-tertiary mt-0.5">
            {ssoConnected
              ? `Your directory is mirrored over SSO (${ssoProviders
                  .map(ssoLabel)
                  .join(", ")}) — all on the LAN. New people sign in with your provider.`
              : "Mirror Google Workspace, Microsoft Entra, or Okta over SSO (OIDC) — stays on the LAN."}
          </p>
        </div>
        {ssoConnected && (
          <span className="inline-flex flex-shrink-0 items-center gap-1.5 rounded-full bg-system-green/15 px-3 py-1.5 type-caption-1 font-semibold text-system-green">
            <Check size={13} aria-hidden="true" />
            Synced
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
            <select
              id="team-role"
              value={role}
              onChange={(e) => setRole(e.target.value as TeamInviteRole)}
              className="dp-input appearance-none pr-9"
            >
              {ROLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <ChevronDown
              size={15}
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-label-tertiary"
            />
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
                  Pending
                </span>
                <button
                  type="button"
                  onClick={() => handleRemove(invite.email)}
                  aria-label={`Remove ${invite.email}`}
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-label-tertiary transition-colors duration-200 ease-smooth hover:bg-surface-tertiary hover:text-label-secondary"
                >
                  <X size={14} />
                </button>
              </li>
            ))}
          </ul>
        </ScrollRegion>
      )}

      <p className="type-caption-1 text-label-tertiary mt-4 leading-relaxed">
        {invites.length > 0
          ? `${invites.length} invite${invites.length === 1 ? "" : "s"} ready · roles can be changed anytime in People → Roles.`
          : "Roles can be changed anytime in People → Roles."}
      </p>

      {/* Primary "Send invites & continue" + the "I'll invite people later"
          skip live in the StepShell footer (Team IS skippable — a solo owner
          is a valid end state). */}
      <LearnMoreCard helpAnchor="roles">
        <p>
          Each role maps to what Droplet&rsquo;s AI may do on that
          person&rsquo;s behalf — an <span className="font-semibold">Admin</span>{" "}
          can manage people and the network, a{" "}
          <span className="font-semibold">Member</span> works with cameras,
          files, and chat, and a <span className="font-semibold">Guest</span> is
          scoped to their own sessions.
        </p>
        <p>
          Prefer to bring everyone in at once? Connect your identity provider
          over SSO and Droplet mirrors your directory — all on your own network,
          nothing sent off the box.
        </p>
      </LearnMoreCard>
    </StepShell>
  );
}
