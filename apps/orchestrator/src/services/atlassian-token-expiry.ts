/**
 * WARP-2353 — the Atlassian API token's expiry, as an EXPLICIT status.
 *
 * ## What the ticket asked for, and what it gets instead
 *
 * The ticket says "add `deriveAtlassianApiTokenKey()` to
 * `column-crypto.service.ts`". **No per-vendor key derivation is added**, and
 * that is the correction rather than a shortcut: the ticket predates ADR-042,
 * which settled where a customer-supplied SaaS credential lives —
 * `IntegrationConnection.providerTokensEnc`, sealed with the existing
 * `deriveSaasCredentialKey()` under the AAD `saas-credential:<rowId>`
 * (`saasCredentialAad`). That seam is generic by design, holds no vendor
 * knowledge, and already fails closed when a blob is moved between rows.
 *
 * A per-vendor derivation would add a second key label with the same
 * properties, a second thing to rotate, and a second place for the AAD rule to
 * be got wrong — for no property the existing seam lacks. `saas-credential.service.ts`
 * states the doctrine ("a comparison of `provider` against any vendor's key
 * would be the defect") and this module honours it: nothing here touches
 * crypto at all.
 *
 * What DOES need building is the half the seam has no opinion about.
 *
 * ## The 365-day clock
 *
 * An Atlassian API token has a **maximum lifetime of 365 days**, and unlike
 * every other vendor on the ADR-042 §2 table it therefore has a hard stop the
 * customer must act on. When it passes, every call 401s and the box looks
 * broken.
 *
 * So expiry is an explicit status, and three repo rules shape it:
 *
 *  1. **Never `CONNECTED` inside the warning window.** A connection 12 days
 *     from a hard stop is not healthy, and rendering it green means the first
 *     signal the customer gets is the outage.
 *  2. **Never derived from `NULL`.** "No expiry date recorded" is its own
 *     status ({@link ATLASSIAN_TOKEN_EXPIRY_UNKNOWN}), not silence and not an
 *     optimistic default. A missing date means we cannot warn, which is a
 *     thing the operator needs told.
 *  3. **Rule 19.** Nothing here sees the token. The input is a date and a
 *     clock.
 */

/**
 * Atlassian's maximum API-token lifetime. Recorded because the guide and the
 * rotation reminder both quote it, and a number quoted in two places drifts.
 */
export const ATLASSIAN_TOKEN_MAX_LIFETIME_DAYS = 365;

/**
 * How far ahead a pending expiry becomes a status rather than a footnote.
 *
 * Thirty days is the ticket's number, and it is the right shape: creating a
 * replacement token is a customer-admin action in a console we do not control,
 * so the warning has to outlast a holiday, a handover and someone being on
 * leave.
 */
export const ATLASSIAN_TOKEN_EXPIRY_WARNING_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** No expiry date is recorded for this connection. Explicit — see rule 2. */
export const ATLASSIAN_TOKEN_EXPIRY_UNKNOWN = "EXPIRY_UNKNOWN" as const;

/**
 * The credential-side status of an Atlassian connection.
 *
 * A closed union, mirroring how `IntegrationStatus` is a closed enum: a new
 * value has to be classified by whoever adds it, and every reader has to
 * handle it.
 */
export type AtlassianTokenStatus =
  /** No token stored. Not an error — nothing has been connected yet. */
  | "NOT_CONFIGURED"
  /** Token stored, expiry recorded, and comfortably in the future. */
  | "CONNECTED"
  /** Token stored and valid, but no expiry date was recorded, so no warning
   *  can ever fire for it. */
  | typeof ATLASSIAN_TOKEN_EXPIRY_UNKNOWN
  /** Inside the warning window. Still working; needs action. */
  | "EXPIRING_SOON"
  /** Past its expiry. Every call will 401. */
  | "EXPIRED";

export interface AtlassianTokenExpiryInput {
  /**
   * Whether a credential is stored, as an explicit boolean read from the row.
   *
   * NOT inferred from `expiresAt` being absent: a token with no recorded
   * expiry and no token at all are different conditions, and collapsing them
   * is precisely the derivation the repo rule bans.
   */
  hasToken: boolean;
  /** The recorded expiry, or `null` when none was captured. */
  expiresAt: Date | null;
  /** Injected so this is a pure function. */
  now: Date;
  /** @default ATLASSIAN_TOKEN_EXPIRY_WARNING_DAYS */
  warningDays?: number;
}

export interface AtlassianTokenExpiryVerdict {
  status: AtlassianTokenStatus;
  /** Whole days until expiry; negative once past. `null` when unknown or when
   *  nothing is stored — never 0 as a stand-in. */
  daysRemaining: number | null;
  /** One line for an operator surface. Carries no credential material. */
  detail: string;
}

/**
 * Classify a connection's credential state.
 *
 * Pure: no clock, no database, no crypto. The caller supplies the row's two
 * explicit facts and the time.
 */
export function atlassianTokenExpiryStatus(
  input: AtlassianTokenExpiryInput,
): AtlassianTokenExpiryVerdict {
  if (!input.hasToken) {
    return {
      status: "NOT_CONFIGURED",
      daysRemaining: null,
      detail: "No Atlassian API token is stored on this box.",
    };
  }

  if (input.expiresAt === null) {
    return {
      status: ATLASSIAN_TOKEN_EXPIRY_UNKNOWN,
      daysRemaining: null,
      detail:
        "An Atlassian API token is stored but no expiry date was recorded, so " +
        `no warning can fire before it stops working. Atlassian tokens last at ` +
        `most ${ATLASSIAN_TOKEN_MAX_LIFETIME_DAYS} days — re-enter the token with ` +
        "its expiry date, or set a reminder.",
    };
  }

  const warningDays = input.warningDays ?? ATLASSIAN_TOKEN_EXPIRY_WARNING_DAYS;
  const daysRemaining = wholeDaysBetween(input.now, input.expiresAt);

  if (daysRemaining < 0) {
    return {
      status: "EXPIRED",
      daysRemaining,
      detail:
        `The Atlassian API token expired ${Math.abs(daysRemaining)} day(s) ago. ` +
        "Every call will be refused until a new token is created in Atlassian " +
        "and pasted into Droplet.",
    };
  }

  if (daysRemaining <= warningDays) {
    return {
      status: "EXPIRING_SOON",
      daysRemaining,
      // Deliberately NOT "CONNECTED": see rule 1 in the module header.
      detail:
        `The Atlassian API token expires in ${daysRemaining} day(s). It still ` +
        "works. Create a replacement in Atlassian and paste it in before then — " +
        "nobody can do it for you, and there is no grace period.",
    };
  }

  return {
    status: "CONNECTED",
    daysRemaining,
    detail: `The Atlassian API token expires in ${daysRemaining} day(s).`,
  };
}

/**
 * Whole days from `from` to `to`, floored.
 *
 * Floored rather than rounded so a token with 29.6 days left reports 29 and
 * lands inside a 30-day window. Rounding would round it to 30 and, at the
 * boundary, keep a connection green on its last day.
 */
function wholeDaysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY);
}
