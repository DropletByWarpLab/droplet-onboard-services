/**
 * WARP-979 — box-name (Secured address) service.
 *
 * The setup walkthrough's "Secured / name your box" step lets the owner choose
 * a name that becomes their box's publicly-trusted address
 * `<name>.droplet-us.com`. This service is the box-side half:
 *
 *   - `checkBoxName`   — format/reserved validation (shared ruleset) + a
 *                        best-effort availability answer. The AUTHORITATIVE
 *                        availability check is a device-authed HQ fleet-registry
 *                        call, which is a COUPLED fleet-hq follow-up (see the
 *                        note on `checkBoxName`); until that lands we return
 *                        format/reserved validity AS availability and flag it
 *                        `authoritative: false` so the caller can be honest.
 *   - `persistBoxName` — validate, then PERSIST the chosen name so the box's
 *                        tls-issuance requests `<name>.droplet-us.com`. Persisted
 *                        the SAME way DROPLET_PUBLIC_FQDN is written back — via
 *                        the device-bridge host `.env` writer (injected here so
 *                        it unit-tests with a fake).
 *
 * Validation is delegated to the SHARED `@droplet/shared-types` box-name util so
 * the dashboard's live client-side check and this server-side re-check can never
 * drift.
 */
import {
  validateBoxName,
  boxNameToFqdn,
  type BoxNameInvalidReason,
} from "@droplet/shared-types";

/** The `.env` key the chosen box name is persisted under (host `.env`,
 *  written back via the device-bridge — mirrors DROPLET_PUBLIC_FQDN). */
export const BOX_NAME_ENV_KEY = "DROPLET_BOX_NAME";

/** Thrown when the requested name isn't a legal box name. The route maps this
 *  to a 400 with an inline-error code so the wizard can block Continue and show
 *  the field error without echoing a coerced value. */
export class BoxNameInvalidError extends Error {
  public readonly code = "BOX_NAME_INVALID";
  public readonly reason: BoxNameInvalidReason;
  public readonly slug: string;
  constructor(reason: BoxNameInvalidReason, slug: string) {
    super(`Box name "${slug}" is invalid (${reason}).`);
    this.name = "BoxNameInvalidError";
    this.reason = reason;
    this.slug = slug;
  }
}

export interface BoxNameCheckResult {
  available: boolean;
  slug: string;
  fqdn: string;
  reason?: BoxNameInvalidReason;
  /**
   * Whether `available` reflects an authoritative fleet-registry answer. FALSE
   * today: HQ availability is a device-authed call that is a coupled fleet-hq
   * follow-up, so we currently answer availability from format/reserved
   * validity only. The dashboard surfaces this honestly.
   */
  authoritative: boolean;
}

/**
 * Validate a candidate name + report availability.
 *
 * MVP posture (per WARP-979): format + reserved validation is done server-side
 * from the shared ruleset. The AUTHORITATIVE "is this name free in the fleet?"
 * check is a device-authed HQ call — HQ owns the global name registry and only
 * it can answer reservation across the fleet. That endpoint + the box→HQ
 * device-auth handshake for it are a COUPLED fleet-hq follow-up (tracked
 * alongside the `requested_name` claim in tls-issuance; see
 * box-name-issuance.ts). Until it lands, a well-formed, non-reserved name is
 * reported `available: true` with `authoritative: false`.
 */
export function checkBoxName(raw: string): BoxNameCheckResult {
  const v = validateBoxName(raw);
  const fqdn = boxNameToFqdn(v.slug);
  if (!v.ok) {
    return {
      available: false,
      slug: v.slug,
      fqdn,
      reason: v.reason,
      authoritative: false,
    };
  }
  // Well-formed + non-reserved. Best-effort MVP: treat format-valid as
  // available. Not authoritative until the HQ device-authed registry check
  // lands (coupled fleet-hq follow-up).
  return { available: true, slug: v.slug, fqdn, authoritative: false };
}

/** Fire-and-forget host `.env` writer, injected so the service unit-tests with a
 *  fake. In production this is `createBridgeBoxNamePersister()` (device-bridge
 *  host write-back), the SAME transport DROPLET_PUBLIC_FQDN uses. */
export type BoxNamePersister = (name: string) => Promise<void>;

export interface PersistBoxNameResult {
  slug: string;
  fqdn: string;
}

/**
 * Validate then persist the chosen name. Invalid → `BoxNameInvalidError` (no
 * write). On success the persister writes `DROPLET_BOX_NAME=<slug>` to the host
 * `.env` so the next boot's tls-issuance ORDER carries `requested_name`.
 *
 * The persister is best-effort by its own contract (swallows + logs its errors),
 * but we still `await` it so a caller that injects a throwing persister (tests)
 * sees the failure.
 */
export async function persistBoxName(
  raw: string,
  persist: BoxNamePersister,
): Promise<PersistBoxNameResult> {
  const v = validateBoxName(raw);
  if (!v.ok) {
    throw new BoxNameInvalidError(v.reason ?? "empty", v.slug);
  }
  await persist(v.slug);
  return { slug: v.slug, fqdn: boxNameToFqdn(v.slug) };
}
