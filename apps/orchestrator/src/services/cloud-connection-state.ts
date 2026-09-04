/**
 * WARP-2458 — the ADR-041 §5 connection-state mapping.
 *
 * ADR-041 §5 fixes one connection-state vocabulary for every cloud connector —
 * `disconnected`, `pending_consent`, `connected`, `needs_reconnect`, `error` —
 * and requires it be an EXPLICIT enum, "never inferred from a missing token".
 * This module is where that vocabulary meets the persisted `IntegrationStatus`
 * enum, and it is the only place the two are related.
 *
 * ## Why a table and not a switch at each call site
 *
 * Before WARP-2458 the persisted enum had no `NEEDS_RECONNECT` member at all,
 * so the sync runner carried the fact in a separate boolean and the API
 * emitted `status: "CONNECTED", needsReconnect: true`. Any surface reading only
 * `status` — the hub's pill is one — rendered a revoked credential as healthy.
 * That is precisely the "looks connected and quietly syncs nothing" failure
 * ADR-041 §5 exists to prevent, one field away from happening.
 *
 * A `Record` typed by the closed source union rather than a `switch` with a
 * `default`, because the `default` is the bug: a state added to a connector and
 * not mapped here would silently take whichever branch the default names, and
 * the default that reads as healthy is the one that hides a broken connection.
 * Typed this way, a new member of either union fails `tsc` at this file.
 *
 * ## Why the failure classifier keys on `code`, not on the error class
 *
 * Every connector error in `@droplet/erp-connector` carries a `readonly code`
 * string, and the four cloud tracks already AGREE on the important one:
 * Stripe, HubSpot, Mailchimp and QuickBooks Online all throw
 * `REAUTHORIZE_REQUIRED` for "only a person pasting a new credential fixes
 * this". Keying on the code means this module contains no vendor knowledge and
 * no `instanceof` chain over twelve exported classes — a fifth vendor that
 * throws the same code is classified correctly the day it lands, without an
 * edit here. Comparing `provider` against a vendor key would be the defect.
 */
import type { CloudConnectionState } from "@droplet/erp-connector";

import type { IntegrationStatusName } from "./integrations.service.js";

/**
 * ADR-041 §5's canonical vocabulary → the persisted `IntegrationStatus`.
 *
 * TOTAL over the source union and with no `default`, so a state added to
 * `CloudConnectionState` cannot reach the database as whatever the fallthrough
 * happened to be.
 *
 * `pending_consent` maps to `PROVISIONING` rather than to a state of its own:
 * the persisted enum already has exactly one "in flight, not usable yet"
 * member and inventing a second would split a state nothing distinguishes.
 */
export const INTEGRATION_STATUS_BY_CLOUD_STATE: Readonly<
  Record<CloudConnectionState, IntegrationStatusName>
> = {
  disconnected: "NOT_CONFIGURED",
  pending_consent: "PROVISIONING",
  connected: "CONNECTED",
  needs_reconnect: "NEEDS_RECONNECT",
  error: "ERROR",
};

/**
 * The error codes a cloud connector's `health()` can reject with, and what each
 * one means for the row.
 *
 * The three-way split is the whole point, and each line is a claim about what
 * the OWNER should do:
 *
 *  • `NEEDS_RECONNECT` — go and paste a new credential. The stored one is
 *    dead or was never usable. ADR-041 calls this routine, not an error.
 *  • `DEGRADED` — nothing to do; it clears on its own. A rate limit resets in
 *    a second, a metered budget resets with its period. Telling an owner to
 *    re-paste a working key because we were throttled wastes their time and
 *    teaches them to ignore the state.
 *  • `CAPABILITY_LIMITED` — the connection WORKS and one dataset is refused.
 *    Nothing about the credential is wrong and nothing is broken; the vendor's
 *    plan or the app's scope grant excludes a single resource. WARP-2623.
 *  • `ERROR` — reconnecting will NOT fix it. An access policy that refuses this
 *    appliance's address, a base URL that is not the vendor's. A new key
 *    changes none of them.
 *
 * `STRIPE_ACCESS_POLICY` is the sharpest of these and the connector's own
 * docstring makes the argument: the key is fine, the permissions are fine, and
 * "telling the merchant to make a new key would waste their time and not fix
 * it". It is an `ERROR` carrying its own remediation, never a reconnect.
 *
 * ## Why the capability codes left `ERROR` (WARP-2623)
 *
 * They were here, and it was the wrong four lines in this table. `ERROR` is
 * rendered as "Can't connect" on both the hub tile and `/integrations/
 * credentials`, so a Basic-plan Shopify store — orders, products, inventory
 * and fulfilment all reading correctly, only customer identities withheld —
 * and a Mailchimp account whose plan excludes one resource were both drawn as
 * BROKEN connections. That is wrong twice over: it sends the owner to repair
 * something that is working, and it hides the plan or scope change that is the
 * only thing they can actually do. Sync stopped too, because `ERROR` is not a
 * pollable status, so a working store also silently stopped reading the
 * datasets it CAN read.
 */
export const INTEGRATION_STATUS_BY_HEALTH_FAILURE_CODE: Readonly<
  Record<string, IntegrationStatusName>
> = {
  // ── the credential is dead: a person must paste a new one ────────────────
  // Shared verbatim by Stripe, HubSpot, Mailchimp and QuickBooks Online.
  REAUTHORIZE_REQUIRED: "NEEDS_RECONNECT",
  // HubSpot: the private app's creator lost super admin. The portal refuses
  // every call until a CURRENT super admin re-creates the app and the new
  // token is saved here — which is a re-paste, so it is the same state.
  USER_DOES_NOT_HAVE_PERMISSIONS: "NEEDS_RECONNECT",
  // The supplied value is not a credential this track can use at all. The row
  // holds something, so it is not NOT_CONFIGURED; a person retypes it.
  INVALID_STRIPE_CREDENTIAL: "NEEDS_RECONNECT",
  INVALID_HUBSPOT_CREDENTIAL: "NEEDS_RECONNECT",
  INVALID_MAILCHIMP_CREDENTIAL: "NEEDS_RECONNECT",

  // ── transient: clears without anyone doing anything ──────────────────────
  SEARCH_RATE_LIMITED: "DEGRADED",
  QUOTA_EXHAUSTED: "DEGRADED",
  REQUEST_TIMEOUT: "DEGRADED",

  // ── the connection works; ONE dataset is refused (WARP-2623) ─────────────
  // Four vendors, four spellings, one meaning: the account's plan or the app's
  // granted scopes exclude a resource. The fix is in the vendor's console and
  // it is not a credential. Keyed on the code like every other row here, so
  // the fifth vendor to throw one of these is classified the day it lands.
  //
  // Mailchimp: the plan does not include the resource.
  CAPABILITY_MISSING: "CAPABILITY_LIMITED",
  // HubSpot: the hub tier does not include the object (e.g. quotes needs Sales
  // Hub Professional).
  CAPABILITY_NOT_AVAILABLE: "CAPABILITY_LIMITED",
  // Shopify (WARP-2296): the app was never granted the scope the dataset
  // needs — `read_customers` for the customer dataset.
  SCOPE_MISSING: "CAPABILITY_LIMITED",
  // Shopify: protected customer data requires Shopify's own approval, which is
  // an application to the vendor, not a key.
  PROTECTED_CUSTOMER_DATA_DENIED: "CAPABILITY_LIMITED",

  // ── a new credential would not help, and nothing works ───────────────────
  STRIPE_ACCESS_POLICY: "ERROR",
  UNSAFE_BASE_URL: "ERROR",
};

/**
 * Nothing is wired: no credential resolved, so the track refused before
 * dialing. That is "not configured", not "broken" and emphatically not
 * "connected" — and it is the one probe outcome that is about the box's own
 * state rather than the vendor's answer.
 */
const BLOCKED_CODE = "CONNECTOR_BLOCKED";

/** Read a connector error's `code` without trusting its class identity across
 *  a package boundary. Returns undefined for anything that is not shaped like
 *  one, which the caller treats as an unclassifiable failure. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Classify a rejected `health()` probe into a persisted status.
 *
 * An UNRECOGNISED failure becomes `ERROR`, deliberately and not silently: we
 * do not know what went wrong, so we may not claim the connection is usable,
 * and we may not claim a new credential would fix it either. The one thing
 * that must never happen is a failure classified as healthy — which is why
 * there is no branch in this function that can return `CONNECTED`.
 */
export function integrationStatusForHealthFailure(err: unknown): IntegrationStatusName {
  const code = errorCode(err);
  if (code === undefined) return "ERROR";
  if (code === BLOCKED_CODE) return "NOT_CONFIGURED";
  return INTEGRATION_STATUS_BY_HEALTH_FAILURE_CODE[code] ?? "ERROR";
}

/**
 * The status a row takes after a COMPLETED probe.
 *
 * `undefined` means the probe resolved — `health()` returned — so the
 * connection is usable. Anything else is the rejection, classified.
 *
 * The function exists so no call site can write `PROVISIONING` after a probe:
 * there is no input to it that produces one. WARP-2466's acceptance criterion
 * — "never leave a row at PROVISIONING after a completed probe" — is a
 * property of this signature rather than a rule call sites must remember.
 */
export function statusAfterHealthProbe(failure?: unknown): IntegrationStatusName {
  return failure === undefined ? "CONNECTED" : integrationStatusForHealthFailure(failure);
}
