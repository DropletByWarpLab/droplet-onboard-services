/**
 * WARP-3538 / ADR-041 — which Microsoft permissions a sign-in asks for, and which
 * a silent refresh may.
 *
 * Pure, with no import of config, MSAL or Prisma, so the auth service and its
 * tests can use it without loading the SDK. `entra-client.ts` re-exports the two
 * constants: that is where a reader looks for "what does the connector request".
 *
 * ## Two sets, and why they are not one list
 *
 *   - `M365_BASE_SCOPES` — what every connection has always asked for: mail,
 *     calendar, contacts, OneDrive. Unchanged in content and order.
 *   - `M365_SHAREPOINT_SCOPE` (`Sites.Read.All`) — what finding a person's
 *     SharePoint sites and document libraries needs (site search and followed
 *     sites list delegated `Sites.Read.All` as their least-privileged
 *     permission). NOT in the base set: `Files.ReadWrite.All` can read a drive
 *     but cannot FIND one.
 *
 * ## 🔴 A sign-in asks for SharePoint only if the person asked for SharePoint
 *
 * Under Microsoft's default consent setting — "Let Microsoft manage your consent
 * settings", the default for new tenants — users CANNOT consent to
 * `Files.Read.All`, `Files.ReadWrite.All`, `Sites.Read.All` or
 * `Sites.ReadWrite.All`, nor to the mail, calendar and contacts scopes: an
 * administrator must grant consent (manage-app-consent-policies, 2026-08-28).
 * Requesting a scope the administrator has not approved makes the WHOLE sign-in
 * fail with "Need admin approval" — mail and calendar included. So a person who
 * did not ask for SharePoint must never be asked for it, and a tenant that has
 * approved the base set but not `Sites.Read.All` keeps working for everyone who
 * leaves SharePoint off.
 *
 * ## 🔴 A refresh asks only for what the connection already HOLDS
 *
 * Silent refresh redeems the stored refresh token for an access token. If it asks
 * for a scope that was never consented — the person turned SharePoint on after
 * connecting and has not signed in again — Entra answers with an interaction or
 * consent error, and the connection would be pushed into NEEDS_RECONNECT by a
 * switch the person only flipped. So a refresh requests `offline_access` plus
 * the members of the full requested set that appear in the stored
 * `grantedScopes`, and nothing else.
 *
 * It keeps requesting EVERY scope that is held, including `Sites.Read.All` after
 * the person switches SharePoint off: what comes back from a refresh is stored
 * over `grantedScopes`, so asking for a subset would silently shrink what the
 * grant is recorded as holding — and switching SharePoint back on would then
 * look like it needs consent again.
 */

/** What every Microsoft 365 connection asks for (ADR-041 / WARP-2115 v1). */
export const M365_BASE_SCOPES: readonly string[] = [
  "offline_access",
  "User.Read",
  "Mail.ReadWrite",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Contacts.ReadWrite",
  "Files.ReadWrite.All",
];

/** The one permission SharePoint discovery adds. */
export const M365_SHAREPOINT_SCOPE = "Sites.Read.All";

/** The scopes an interactive sign-in requests: the base set, plus SharePoint's only when the person opted in. */
export function scopesForSignIn(sharePointEnabled: boolean): string[] {
  return sharePointEnabled ? [...M365_BASE_SCOPES, M365_SHAREPOINT_SCOPE] : [...M365_BASE_SCOPES];
}

/** A scope as Entra compares it: the part after the last `/`, case-insensitively. Scopes arrive short (`Mail.Read`) or resource-qualified (`<resource>/Mail.Read`). */
function scopeKey(scope: string): string {
  return scope.slice(scope.lastIndexOf("/") + 1).toLowerCase();
}

/**
 * The scopes a silent refresh may request, given what Microsoft granted.
 *
 * `grantedScopes` is the space-separated string stored on the connection. Null,
 * empty or blank (a row that predates the column being filled) is the BASE set:
 * that is what such a connection was signed in with. Otherwise: `offline_access`
 * first, then the members of the base set and SharePoint's scope that the grant
 * names, in a stable order — never a scope the grant does not hold, and never one
 * outside our own set that the grant happens to carry.
 */
export function scopesForRefresh(grantedScopes: string | null | undefined): string[] {
  const held = new Set((grantedScopes ?? "").split(/\s+/).filter(Boolean).map(scopeKey));
  if (held.size === 0) return [...M365_BASE_SCOPES];
  const requested = [...M365_BASE_SCOPES, M365_SHAREPOINT_SCOPE].filter((s) => s !== "offline_access");
  return ["offline_access", ...requested.filter((s) => held.has(scopeKey(s)))];
}
