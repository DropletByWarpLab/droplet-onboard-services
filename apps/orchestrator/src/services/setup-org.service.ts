/**
 * Onboarding ORG step service (PR #380 / docs/ONBOARDING_ORG_OWNER.md +
 * #371 handoff §3).
 *
 * The org step names the single workspace (the "company brain") and reserves
 * its `droplet.local/<slug>` host. Everyone the owner later invites joins this
 * ONE workspace — there is no multi-tenant split, so the workspace is the
 * existing `Workspace` SINGLETON (id = 1, the same row `/api/settings/workspace`
 * flips Home↔Business on). This service EXTENDS that row with the org fields
 * rather than minting a second workspace table — one source of truth for "what
 * is this workspace called".
 *
 * CONTRACT
 *   - `slug` is validated `[a-z0-9-]` (no leading/trailing/double hyphen, not a
 *     reserved platform word) and is UNIQUE. It reserves `droplet.local/<slug>`.
 *     We never coerce a bad slug into a good one — validation REJECTS so the
 *     customer sees their own input, not a silent guess.
 *   - `industry` / `size` are OPTIONAL and used ONLY to pick LOCAL smart
 *     defaults (folder structure, example tools, camera policy). They are
 *     NEVER sent off the box (FEATURES.md §10). This service does no outbound
 *     I/O — it only writes the local singleton.
 *   - Completion is an EXPLICIT column (`orgConfigured`), never derived from
 *     `slug IS NULL` (CLAUDE.md no-guessing rule; WARP-218 / ClaimCodeState
 *     precedent).
 */
import { Prisma, type PrismaClient } from "@prisma/client";

/** The fixed primary key of the workspace singleton. Mirrors the
 *  `Workspace.id = 1` convention `settings-workspace.ts` already uses. */
export const WORKSPACE_SINGLETON_ID = 1;

/** The mDNS host the appliance answers on. A workspace slug reserves the
 *  `<host>/<slug>` path under it. */
export const WORKSPACE_HOST = "droplet.local";

/**
 * Slugs that would collide with platform routes / reserved hosts under
 * `droplet.local/…`, so they can't be taken as a workspace slug. Kept small
 * and explicit; extend deliberately (a slug check is cheap, a reserved-word
 * collision in production is not).
 */
export const RESERVED_SLUGS: readonly string[] = [
  "www",
  "api",
  "admin",
  "app",
  "setup",
  "login",
  "auth",
  "dashboard",
  "droplet",
  "local",
  "health",
  "static",
  "assets",
];

/** Lower-bound / upper-bound on slug length (DNS-label friendly). */
const SLUG_MIN_LEN = 1;
const SLUG_MAX_LEN = 63;

/** Only lowercase letters, digits, and single internal hyphens. */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Canonical form of a slug: trim surrounding whitespace + lowercase. We do
 * NOT substitute or strip internal characters — `isValidSlug` rejects bad
 * input rather than silently rewriting it, so "Acme HQ" stays "acme hq"
 * (which then fails validation) instead of becoming a surprise "acmehq".
 */
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

/**
 * Is `slug` a legal, non-reserved workspace slug? Expects the value to be
 * normalized already (callers pass `normalizeSlug(...)`), but re-checks case
 * via the shape regex so an un-normalized value can't slip through.
 */
export function isValidSlug(slug: string): boolean {
  if (slug.length < SLUG_MIN_LEN || slug.length > SLUG_MAX_LEN) return false;
  if (!SLUG_SHAPE.test(slug)) return false;
  if (RESERVED_SLUGS.includes(slug)) return false;
  return true;
}

/** The host a slug reserves, e.g. `droplet.local/acme`. */
export function reservedHostForSlug(slug: string): string {
  return `${WORKSPACE_HOST}/${slug}`;
}

/**
 * Thrown when the requested slug isn't a legal workspace slug. The route maps
 * this to a 400 with an inline-error code so the wizard can block continue and
 * show the field error without echoing a coerced value.
 */
export class SlugInvalidError extends Error {
  public readonly code = "ORG_SLUG_INVALID";
  public readonly slug: string;
  constructor(slug: string) {
    super(
      `Workspace URL "${slug}" is invalid. Use lowercase letters, numbers, and hyphens (e.g. "acme-hq").`,
    );
    this.name = "SlugInvalidError";
    this.slug = slug;
  }
}

/**
 * Thrown when the slug is already reserved by another workspace. The route
 * maps this to a 409 with an inline-error code so the wizard blocks continue
 * and shows "that URL is taken".
 */
export class SlugTakenError extends Error {
  public readonly code = "ORG_SLUG_TAKEN";
  public readonly slug: string;
  constructor(slug: string) {
    super(`Workspace URL "${slug}" is already taken. Pick another.`);
    this.name = "SlugTakenError";
    this.slug = slug;
  }
}

/** Fields the org step submits. `name` is the workspace display name; the
 *  rest mirror the WizOrg form. `industry`/`size` are LOCAL-only hints. */
export interface OrgInput {
  name: string;
  slug: string;
  tz: string;
  industry?: string | null;
  size?: string | null;
  /** Stored logo path (the upload itself is handled separately; this is the
   *  on-NVMe path the dashboard renders). Optional — the logo is optional. */
  logoPath?: string | null;
}

/** What the route returns to the wizard on success. */
export interface OrgResult {
  slug: string;
  /** The reserved `droplet.local/<slug>` host. */
  reservedHost: string;
}

/**
 * Persist the workspace org settings onto the singleton row.
 *
 * Flow:
 *   1. Normalize + validate the slug. Invalid → `SlugInvalidError` (no write).
 *   2. Uniqueness pre-check: a *different* workspace row holding this slug →
 *      `SlugTakenError`. (With a true singleton this only fires if the slug is
 *      already on a row whose id isn't ours; kept so the contract holds
 *      independent of row identity.)
 *   3. Upsert the singleton with the org fields + the EXPLICIT
 *      `orgConfigured = true` flag. A concurrent claimer that slips past the
 *      pre-check and hits the DB unique index throws Prisma P2002, which we
 *      translate to `SlugTakenError` (no check-then-act gap leaks a 500).
 *
 * Industry / size are written verbatim as local hints; NO outbound call is
 * made (FEATURES.md §10 — nothing off the box).
 */
export async function persistOrg(
  prisma: PrismaClient,
  input: OrgInput,
): Promise<OrgResult> {
  const slug = normalizeSlug(input.slug);
  if (!isValidSlug(slug)) {
    throw new SlugInvalidError(input.slug.trim());
  }

  // Uniqueness pre-check. The DB unique index is the authoritative guard
  // (handled in the catch below); this gives a clean 409 in the common case
  // without relying on the exception path.
  const existing = await prisma.workspace.findFirst({ where: { slug } });
  if (existing && existing.id !== WORKSPACE_SINGLETON_ID) {
    throw new SlugTakenError(slug);
  }

  try {
    await prisma.workspace.upsert({
      where: { id: WORKSPACE_SINGLETON_ID },
      create: {
        id: WORKSPACE_SINGLETON_ID,
        // WARP-1341: business-only build — the org step IS the moment the
        // workspace comes into being, and it is always a business one.
        type: "BUSINESS",
        displayName: input.name,
        slug,
        tz: input.tz,
        industry: input.industry ?? null,
        size: input.size ?? null,
        logoPath: input.logoPath ?? null,
        orgConfigured: true,
      },
      update: {
        type: "BUSINESS",
        displayName: input.name,
        slug,
        tz: input.tz,
        // `?? null` (not `?? undefined`) so re-submitting without an optional
        // field clears it rather than silently preserving a stale value —
        // same convention settings-workspace.ts uses for displayName.
        industry: input.industry ?? null,
        size: input.size ?? null,
        logoPath: input.logoPath ?? null,
        orgConfigured: true,
      },
    });
  } catch (err) {
    // P2002 — the unique constraint on `slug` lost a race (two requests both
    // passed the pre-check, the loser collides at the DB). Surface it as the
    // same inline-error the pre-check would have.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      throw new SlugTakenError(slug);
    }
    throw err;
  }

  return { slug, reservedHost: reservedHostForSlug(slug) };
}
