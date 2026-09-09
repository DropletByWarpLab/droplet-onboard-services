/**
 * WARP-2707 / ADR-046 §1 — the profile registry, and the dispatch that makes a
 * REST vendor a lookup rather than a factory registration.
 *
 * Mirrors the export-drop track EXACTLY, which is the precedent ADR-046 cites:
 * `vendorFromExportProvider(provider)` returns a vendor or `null`, and
 * `connectorFactoryFor` consults it before the static factory map. Here
 * `restProfileFor(provider)` plays the same role. That symmetry is the point —
 * adding a vendor touches this file, its descriptor, its egress entry and its
 * setup guide, and nothing else.
 *
 * ## Every profile is validated AT MODULE LOAD
 *
 * `assertValidRestProfile` runs over the whole table below the moment this
 * module is imported, not on first use. A structurally impossible profile is a
 * bug in a build, not a bug in one customer's connection — so it should fail
 * the process that ships it rather than the connection that meets it.
 */
import { assertValidRestProfile, type RestVendorProfile } from "./profile.js";
import { CALCOM_PROFILE, CALCOM_PROVIDER } from "./vendors/calcom.js";
import { SQUARE_PROFILE, SQUARE_PROVIDER } from "./vendors/square.js";

/**
 * Every vendor served by the declarative track.
 *
 * 🔴 Ordering is alphabetical by provider id and carries no meaning. Hub
 * ordering is `catalog.order` on the descriptor; nothing should read a
 * position here.
 */
export const REST_VENDOR_PROFILES: readonly RestVendorProfile[] = [CALCOM_PROFILE, SQUARE_PROFILE];

// Fail the BUILD, not a customer's connection.
for (const profile of REST_VENDOR_PROFILES) assertValidRestProfile(profile);

const BY_PROVIDER = new Map(REST_VENDOR_PROFILES.map((p) => [p.provider, p]));

/**
 * The profile for a provider key, or `null` when the declarative track does not
 * serve it.
 *
 * `null` rather than `undefined`, matching `vendorFromExportProvider`'s
 * signature — the two are read at the same call site and a reader should not
 * have to remember which absence each uses.
 */
export function restProfileFor(provider: string): RestVendorProfile | null {
  return BY_PROVIDER.get(provider) ?? null;
}

/** Every provider id the declarative track serves. */
export function restProviderIds(): readonly string[] {
  return REST_VENDOR_PROFILES.map((p) => p.provider);
}

export { CALCOM_PROVIDER, SQUARE_PROVIDER };
