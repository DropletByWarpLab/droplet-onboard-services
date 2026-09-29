/**
 * Leaf module: imports nothing, so any service can depend on it without
 * joining an import cycle (WARP-3193 ARCH-1 — this used to live in
 * `integrations.service.ts`, and `saas-credential.service.ts` importing it from
 * there closed the runtime cycle erp-provider → saas-credential →
 * integrations → erp-provider).
 */

/**
 * WARP-2453 — has this connection's credential material actually been removed?
 *
 * True only for a row that is explicitly DISABLED **and** holds neither
 * credential blob. Both halves are required: DISABLED alone is what
 * `origin/stage` gave a caller who clicked Disconnect while the key stayed
 * decryptable in Postgres, and an empty credential column alone is just an
 * unconfigured connection.
 *
 * WARP-2489 — module scope and EXPORTED, because it is now the one derivation
 * every surface reads. `buildCredentialView` in `saas-credential.service.ts`
 * calls this exact function rather than answering the question a second time
 * from `hasCredentials`, which asks something else: `hasCredentials` is an
 * `every()` over the descriptor's DECLARED secrets, so a provider with two of
 * them and one stored reports `false` while that one is still sealed on the
 * row. Two derivations of "was the key removed" are two chances to tell an
 * owner opposite things on two pages of the same product, and the half that
 * drifted was the reassuring one.
 *
 * Both credential columns are REQUIRED parameters rather than optional ones. A
 * caller that narrowed its `select` and dropped `apiCredentialsEnc` would
 * otherwise read `undefined` as "no blob" and claim a purge because the column
 * was never loaded. That has to be a compile error, not a rendered sentence.
 */
export function credentialsPurgedFor(row: {
  status: string;
  apiCredentialsEnc: string | null;
  providerTokensEnc: string | null;
}): boolean {
  return row.status === "DISABLED" && !row.apiCredentialsEnc && !row.providerTokensEnc;
}
