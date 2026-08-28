/**
 * WARP-2483 — how "the key was actually removed" is put into words, once.
 *
 * ## Why this is a module and not two string literals
 *
 * WARP-2453 made Disconnect genuinely purge the credential and put the result
 * on the wire as `credentialsPurged`. ADR-041 §2 promises the owner that
 * disconnecting removes the key; until this module existed the promise was
 * true in Postgres and invisible to the person it was made to — `grep -rn
 * credentialsPurged apps/web-dashboard/src` returned nothing.
 *
 * Two surfaces have to say the same sentence — the hub tile's status pill
 * (WARP-2291) and `/integrations/credentials` (WARP-2275) — and they read the
 * fact from two different payloads (`IntegrationSummary.credentialsPurged` and
 * `SaasCredentialView.hasCredentials`). Copy that has to match across two
 * payloads is copy that drifts, so both call {@link disconnectedCredentialView}
 * and neither owns a string.
 *
 * ## The third case, which is the point
 *
 * `disconnected && credentialsPurged === undefined` returns `null`, and the
 * caller falls back to its existing neutral rendering. It does NOT default to
 * either sentence. Claiming "credential removed" for a payload that never said
 * so would be the dashboard asserting something false about the box — the same
 * refusal `credentialsPurgedFor` makes server-side, where a row DISABLED by a
 * build that predates the purge reports `false` rather than being assumed
 * clean (`apps/orchestrator/src/services/integrations.service.ts:347-356`).
 *
 * ## What this module deliberately does not carry
 *
 * No colour, no tone name, no icon. `purged` is the one bit; each surface maps
 * it onto its OWN existing state token — the hub onto `BadgeKind`, the
 * credentials page onto its `tone` union — so WARP-2483 introduces no token and
 * no vendor of its own into `design-and-style`.
 *
 * And no secret-presence signal beyond the booleans that already exist. This
 * module never sees, and can never render, a value, a length, or a prefix.
 */

/** The credential is gone. A finished, benign end state. */
export const CREDENTIAL_PURGED_LINE = "Disconnected · credential removed";

/** The connection is off but the key is still on the row — unfinished. */
export const CREDENTIAL_RETAINED_LINE =
  "Disconnected · credential still stored — reconnect or remove";

export interface DisconnectedCredentialView {
  /**
   * `true` — the box confirmed the credential material is gone.
   * `false` — the box confirmed it is still stored.
   *
   * There is no third value: "the box did not say" is `null` for the whole
   * view, not a third member here, so no caller can accidentally treat an
   * unanswered question as one of the two answers.
   */
  readonly purged: boolean;
  /** The canonical state line, verbatim on every surface that renders it. */
  readonly line: string;
}

/**
 * The two states a disconnected connection can be in, or `null`.
 *
 * `null` means "there is nothing to say here" and covers both reasons: the
 * connection is not disconnected at all, and the payload carried no purge fact.
 * Callers keep whatever they rendered before for `null`.
 *
 * @param disconnected the connection's EXPLICIT disconnected status — the
 *   `DISABLED` enum member, never a null credential standing in for one.
 * @param credentialsPurged the box's own answer, or `undefined` when it did
 *   not give one.
 */
export function disconnectedCredentialView(
  disconnected: boolean,
  credentialsPurged: boolean | undefined,
): DisconnectedCredentialView | null {
  if (!disconnected) return null;
  // `typeof`, not truthiness: `false` is an answer and must not fall through
  // with `undefined` into "we were told nothing".
  if (typeof credentialsPurged !== "boolean") return null;
  return credentialsPurged
    ? { purged: true, line: CREDENTIAL_PURGED_LINE }
    : { purged: false, line: CREDENTIAL_RETAINED_LINE };
}
