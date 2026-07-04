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
import {
  CLAIM_RESULT_CLAIMED,
  CLAIM_RESULT_NAME_TAKEN,
  CLAIM_RESULT_RENAME_UNSUPPORTED,
  type ClaimBoxNameResult,
} from "./tls-issuance.service.js";

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

/**
 * WARP-980 — drive a name CLAIM against HQ via device-auth PoP. Given the RAW
 * owner-entered name, this is `tls-issuance.claimBoxName` (bound with the box's
 * device-id + HQ client + device-identity signer). Injected so the service
 * unit-tests with a fake; in production the route composes the real one.
 */
export type BoxNameClaimer = (raw: string) => Promise<ClaimBoxNameResult>;

export interface SetBoxNameDeps {
  persist: BoxNamePersister;
  claim: BoxNameClaimer;
}

export interface SetBoxNameResult {
  slug: string;
  fqdn: string;
  /**
   * Whether the name is AUTHORITATIVE — HQ device-auth-confirmed it belongs to
   * this box (claimed/owned) OR authoritatively rejected it as taken. FALSE when
   * we could only fall back (device not registered yet / a transient failure);
   * the wizard uses this to be honest about whether the address is truly locked.
   */
  authoritative: boolean;
  /** TRUE when HQ said the name is taken by ANOTHER device. The wizard shows
   *  the conflict + any `suggestions`. */
  taken: boolean;
  /** WARP-984 — TRUE when HQ said THIS box already holds a (different) name and
   *  rename isn't supported yet; distinct from `taken` so the wizard can say
   *  "factory reset releases it" instead of the false "that name is taken". */
  renameUnsupported: boolean;
  /** WARP-984 — the name this box already holds at HQ (when the worker sent
   *  `current_name` on the rename-unsupported 409). */
  currentName?: string;
  /** Alternate names HQ offered on a taken name (empty otherwise). */
  suggestions: string[];
  /** The raw claim result, for callers that want the exact outcome. */
  claim: ClaimBoxNameResult;
}

/**
 * WARP-980 — the authoritative "set the box name" flow the rename endpoint runs:
 *
 *   1. Validate + PERSIST the chosen name (DROPLET_BOX_NAME) — same as
 *      `persistBoxName`. An invalid name throws `BoxNameInvalidError` BEFORE any
 *      write or claim (never persist/claim a bad name).
 *   2. Drive the device-auth CLAIM (`droplet-claim:v1` PoP) so HQ makes the name
 *      AUTHORITATIVE. The subsequent issuance path then issues UNDER the claimed
 *      name (it already sends `requested_name`; the claim makes HQ honor it).
 *
 * The claim is NON-FATAL to persistence — `claimBoxName` never throws, so a
 * device-not-registered / transient failure still persists the name locally and
 * simply reports `authoritative:false` (issuance falls back to opaque/bootstrap
 * and re-claims on the next tick). A 409 name-taken is surfaced as `taken:true`
 * with `suggestions` so the wizard shows the real availability.
 *
 * The persist runs first so the name is durable even if HQ is briefly
 * unreachable; the claim result then refines what the wizard is told.
 */
export async function setBoxName(
  raw: string,
  deps: SetBoxNameDeps,
): Promise<SetBoxNameResult> {
  const v = validateBoxName(raw);
  if (!v.ok) {
    throw new BoxNameInvalidError(v.reason ?? "empty", v.slug);
  }
  // 1. Persist the validated slug (best-effort host .env write-back).
  await deps.persist(v.slug);

  // 2. Device-auth claim with the RAW owner-entered name (HQ slugs it). Never
  //    throws — branch on the typed outcome.
  const claim = await deps.claim(raw);
  const taken = claim.outcome === CLAIM_RESULT_NAME_TAKEN;
  const renameUnsupported = claim.outcome === CLAIM_RESULT_RENAME_UNSUPPORTED;
  return {
    // Prefer HQ's canonical slug/fqdn when it confirmed the claim; otherwise
    // fall back to the locally-derived slug so the wizard can still show the
    // chosen name (issuance will re-claim it later).
    slug: claim.outcome === CLAIM_RESULT_CLAIMED && claim.slug ? claim.slug : v.slug,
    fqdn:
      claim.outcome === CLAIM_RESULT_CLAIMED && claim.fqdn
        ? claim.fqdn
        : boxNameToFqdn(v.slug),
    authoritative: claim.authoritative,
    taken,
    renameUnsupported,
    ...(renameUnsupported && claim.currentName
      ? { currentName: claim.currentName }
      : {}),
    suggestions: claim.suggestions ?? [],
    claim,
  };
}
