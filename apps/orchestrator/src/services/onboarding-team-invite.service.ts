/**
 * Onboarding TEAM-invite service (PR #381 / docs/ONBOARDING_TEAM_ROLES.md +
 * #371 handoff §4).
 *
 * Backs the TEAM wizard step ("Bring in your team") and its
 * `POST /api/people/invite { email, role }` endpoint. The step lets the owner
 * invite teammates by EMAIL + ROLE, or skip ("I'll invite people later" — a
 * solo owner is a valid end state). This service is the single boundary that
 * turns one (email, role) pair into a `UserInvite` row.
 *
 * ── ROLE MODEL DECISION (the scaffold's OPEN fork, resolved) ──
 * docs/ONBOARDING_TEAM_ROLES.md flagged an open fork between a HOUSEHOLD model
 * (owner / admin / family / guest) and a BUSINESS model
 * (owner / manager / member / viewer / guest). The appliance is home-first
 * (ADR-002), and the household model is ALREADY THE SHIPPED CONTRACT:
 *   - the Prisma `Role` enum is owner / admin / family / guest / service
 *     (WARP-171, schema.prisma);
 *   - `UserInvite.role : Role` already persists it;
 *   - the existing `POST /api/auth/invites` route already validates against
 *     exactly `["owner","admin","family","guest"]` (auth.ts `inviteRoleField`).
 * So we use HOUSEHOLD here — re-using the live enum, NOT inventing a parallel
 * vocabulary. `service` is excluded: a service principal is env-var-minted
 * (SERVICE_TOKEN_*), never invited. The decision is FLAGGED for review in the
 * PR self-assessment; switching to business roles later is a Role-enum
 * migration + a separate ticket, not a silent widening here.
 *
 * ── EMAIL ──
 * The email is the LOGIN KEY for the email-keyed sign-in (#374 / ADR-012), so
 * it is normalized to lowercase + trimmed before it hits the store. We
 * canonicalize only — we never strip internal characters (a malformed address
 * is REJECTED with a typed error the route maps to a 400, not silently
 * rewritten).
 *
 * ── #386 COMPATIBILITY (do NOT re-implement) ──
 * Invite-ACCEPT-time argon2id `passwordHash` (so an invited member can sign in
 * on the email-keyed login) is owned by #386, a SEPARATE PR on `main`. This
 * service only CREATES the invite (the same `UserInvite` row #386's accept
 * path consumes), so the two are compatible. We do not touch accept here.
 */
import { type PrismaClient, type Role } from "@prisma/client";
import { generateInviteToken } from "./invite.service.js";

/**
 * The roles an onboarding invite may assign — the SHIPPED HOUSEHOLD model.
 * Mirrors `auth.ts`'s `inviteRoleField` enum 1:1 (and the Prisma `Role` enum
 * minus `service`). Declared as a string-literal tuple typed `satisfies
 * readonly Role[]` so any drift from the Prisma enum fails `tsc --noEmit`
 * (same compile-time cross-check `SETUP_STEPS` uses).
 */
export const INVITE_ROLES = [
  "owner",
  "admin",
  "family",
  "guest",
] as const satisfies readonly Role[];

/** A role an onboarding invite may carry. */
export type InviteRole = (typeof INVITE_ROLES)[number];

/** Default acceptance window for an onboarding invite (3 days). */
const DEFAULT_TTL_HOURS = 72;

/**
 * Pragmatic email shape. Not a full RFC 5322 validator (that's a footgun) — a
 * single `@`, a non-empty local part with no whitespace, and a dotted domain
 * whose final label is ≥ 2 chars. The same shape the dashboard checks inline,
 * so client + server agree on what bounces.
 */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/;

/** Allowed username characters (mirrors auth.ts `usernameField`). */
const USERNAME_ALLOWED = /[^a-zA-Z0-9._-]+/g;
const USERNAME_MIN_LEN = 2;
const USERNAME_MAX_LEN = 64;

/**
 * Canonical form of an invite email: trim + lowercase. Canonicalize ONLY — no
 * internal-character substitution (validation rejects bad input rather than
 * rewriting it). Same discipline `setup-org.service.normalizeSlug` uses.
 */
export function normalizeInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Is `email` a well-formed address? Expects (but does not require) a
 *  normalized value. */
export function isValidEmail(email: string): boolean {
  if (typeof email !== "string") return false;
  if (email.length === 0 || email.length > 200) return false;
  return EMAIL_SHAPE.test(email);
}

/** Is `role` one of the shipped household invite roles? */
export function isInviteRole(role: unknown): role is InviteRole {
  return (
    typeof role === "string" &&
    (INVITE_ROLES as readonly string[]).includes(role)
  );
}

/**
 * Derive a NOT-NULL username from an email local-part for the `UserInvite`
 * row (which requires `username`; the onboarding surface is email-first, so it
 * has no separate username field). Strip to the allowed charset and clamp to
 * the length bounds. A too-short result (e.g. a 1-char local part) is padded so
 * the derived value always satisfies the username contract. This is a
 * placeholder identity — #386's accept flow is keyed on the email, and the
 * invitee can pick a display name then.
 */
export function deriveUsernameFromEmail(email: string): string {
  const local = normalizeInviteEmail(email).split("@")[0] ?? "";
  const cleaned = local.replace(USERNAME_ALLOWED, "-").replace(/^-+|-+$/g, "");
  const padded = cleaned.length >= USERNAME_MIN_LEN ? cleaned : `${cleaned}user`;
  return padded.slice(0, USERNAME_MAX_LEN);
}

/** Thrown when the invite email is malformed. Route → 400 INVITE_EMAIL_INVALID. */
export class InvalidInviteEmailError extends Error {
  public readonly code = "INVITE_EMAIL_INVALID";
  public readonly email: string;
  constructor(email: string) {
    super(`"${email}" is not a valid email address.`);
    this.name = "InvalidInviteEmailError";
    this.email = email;
  }
}

/** Thrown when the invite role isn't a shipped household role. Route → 400
 *  INVITE_ROLE_INVALID. */
export class InvalidInviteRoleError extends Error {
  public readonly code = "INVITE_ROLE_INVALID";
  public readonly role: string;
  constructor(role: string) {
    super(
      `"${role}" is not a valid role. Expected one of: ${INVITE_ROLES.join(", ")}.`,
    );
    this.name = "InvalidInviteRoleError";
    this.role = role;
  }
}

/** Input to {@link createTeamInvite}. */
export interface TeamInviteInput {
  email: string;
  role: string;
  /** Username of the issuing owner/admin (for the audit `createdBy` column). */
  createdBy: string;
  /** Acceptance window in hours (defaults to 72). */
  ttlHours?: number;
}

/** What {@link createTeamInvite} returns to the route. */
export interface TeamInviteResult {
  /** The UserInvite row id — needed by BUG-11 to drive the email-send state. */
  id: string;
  token: string;
  email: string;
  role: InviteRole;
  expiresAt: Date;
}

/**
 * Create a single onboarding team invite.
 *
 * Flow:
 *   1. Normalize + validate the email. Invalid → InvalidInviteEmailError (no
 *      write).
 *   2. Validate the role against the shipped household model. Invalid →
 *      InvalidInviteRoleError (no write).
 *   3. Mint a token (WARP-217 generator) and create the UserInvite row with the
 *      normalized email, validated role, and a username derived from the email.
 *
 * No outbound I/O here — issuing the invite is a local write; actually emailing
 * the link is the Off-LAN "Outbound email" channel's job (FEATURES.md §8), wired
 * separately. #386 owns accept-time passwordHash.
 */
export async function createTeamInvite(
  prisma: PrismaClient,
  input: TeamInviteInput,
): Promise<TeamInviteResult> {
  const email = normalizeInviteEmail(input.email);
  if (!isValidEmail(email)) {
    throw new InvalidInviteEmailError(input.email.trim());
  }
  if (!isInviteRole(input.role)) {
    throw new InvalidInviteRoleError(String(input.role));
  }

  const ttlHours = input.ttlHours ?? DEFAULT_TTL_HOURS;
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const token = generateInviteToken();
  const username = deriveUsernameFromEmail(email);

  const created = await prisma.userInvite.create({
    data: {
      token,
      username,
      email,
      role: input.role,
      createdBy: input.createdBy,
      expiresAt,
    },
  });

  return {
    id: created.id,
    token: created.token,
    email,
    role: input.role,
    expiresAt: created.expiresAt,
  };
}
