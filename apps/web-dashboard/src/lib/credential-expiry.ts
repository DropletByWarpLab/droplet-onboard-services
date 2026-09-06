/**
 * WARP-2659 — the ONE place a credential-expiry verdict becomes words.
 *
 * Two surfaces render it: the credential configurator's provider form
 * (`SaasCredentialsSection`) and the Integrations hub tile (`ConnectorCard`).
 * They must not describe one credential two ways, which is exactly the rule
 * `lib/credential-purge.ts` already exists to enforce for the *other* fact a
 * connection carries — see `disconnectedCredentialView`, shared by
 * `connector-visuals.tsx` and the same configurator. This is that pattern
 * applied to the expiry, at the moment a second reader appeared.
 *
 * The verdict itself is computed by the BOX (`integrations.service.ts`
 * `credentialExpiryFor` and `saas-credential.service.ts` both call
 * `credentialExpiryVerdict`), never here. This module only chooses the
 * sentence, so a rendering change can never move the day a warning fires.
 */

import type { CredentialExpiryVerdict } from "@droplet/shared-types";

export interface ExpiryCopy {
  label: string;
  /** Reuses the three-way tone union the configurator already had. No colour
   *  token is added for this. */
  tone: "warn" | "idle";
}

/**
 * What to tell a person about this credential's expiry, or `null` for the two
 * states that have nothing to say.
 *
 * `null` covers exactly two cases, and neither is a hedge:
 *
 *  • **No verdict at all** — `undefined` (a box that sent no such key) or
 *    `null` (the provider declares no {@link CredentialExpiryPolicy}, so this
 *    credential cannot expire). Every Stripe, HubSpot and Eaglesoft connection
 *    lands here, and a line for them would be a warning they can never clear.
 *  • **`VALID`** — a date comfortably beyond the window. The absence of a line
 *    is the good news; a "expires in 240 days" footnote on every tile is noise
 *    that trains an owner to ignore the one that matters.
 *
 * `EXPIRY_UNKNOWN` is emphatically NOT one of them. A credential IS stored and
 * no date was recorded, which means no warning can ever fire — a real state
 * with its own remedy, and one only the owner can fix.
 */
export function credentialExpiryCopy(
  verdict: CredentialExpiryVerdict | null | undefined,
): ExpiryCopy | null {
  if (!verdict) return null;
  const days = verdict.daysRemaining;
  switch (verdict.status) {
    case "VALID":
      return null;
    case "EXPIRY_UNKNOWN":
      return {
        label:
          "No expiry date recorded — Droplet can't warn you before this credential stops working.",
        tone: "idle",
      };
    case "EXPIRING_SOON":
      return {
        label: `Expires in ${days} day${days === 1 ? "" : "s"} — create a replacement and paste it in.`,
        tone: "warn",
      };
    case "EXPIRED": {
      // `Math.abs` on a null-safe zero: an EXPIRED verdict always carries a
      // number (the verdict only reaches this arm through a parsed date), but
      // the field is `number | null` for the UNKNOWN case and narrowing it
      // here beats asserting non-null.
      const ago = Math.abs(days ?? 0);
      return {
        label: `Expired ${ago} day${ago === 1 ? "" : "s"} ago — every call is being refused.`,
        tone: "warn",
      };
    }
  }
}
