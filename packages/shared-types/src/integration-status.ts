/**
 * WARP-2639 — the ONE `IntegrationStatus`.
 *
 * The persisted lifecycle of a connector connection. It was FOUR hand-copied
 * TypeScript unions of the Prisma enum:
 *
 *  - `apps/orchestrator/src/services/integrations.service.ts` (`IntegrationStatusName`)
 *  - `apps/orchestrator/src/services/saas-credential.service.ts` (`IntegrationStatusName`)
 *  - `apps/web-dashboard/src/lib/erp-types.ts` (`IntegrationStatus`)
 *  - `apps/web-dashboard/src/app/reports/api.ts` (`IntegrationStatusName`)
 *
 * All four now re-export this one, under the names they already used, so no
 * consumer's import path or type name changed.
 *
 * ## Why this was worth doing when a drift test already existed
 *
 * WARP-2458's gate (`apps/orchestrator/src/__tests__/integration-status.schema.test.ts`)
 * set-compares against the Prisma enum, so the copies could not silently fall
 * behind the SCHEMA. What it could not do is make them agree with each OTHER
 * for free: it imports the two orchestrator unions and cannot import the two
 * dashboard ones (a test in `apps/orchestrator` cannot reach `apps/web-dashboard`),
 * so the dashboard pair was gated by nothing but two people editing four files
 * in the same commit. WARP-2623 is the proof it is a real cost — adding one
 * member meant four hand-edits, which is precisely the operation that produced
 * WARP-2517's defect on the neighbouring `SaasConnectionState` union.
 *
 * WARP-2633 established that a dashboard-consumed union CAN live here at no
 * bundle cost (`import type` is erased at compile). This is the same move for
 * the union next to it.
 *
 * ## Why an array and not just a union
 *
 * A union type has no runtime value, so nothing can iterate it and no test can
 * compare it to the Prisma enum. `INTEGRATION_STATUSES` is the single list;
 * `IntegrationStatus` is DERIVED from it. There is therefore no second place to
 * add a member and no way for the list and the type to disagree.
 *
 * ## Order
 *
 * Declared in the Prisma enum's order (`apps/orchestrator/prisma/schema.prisma`
 * → `enum IntegrationStatus`) so the two read the same way side by side.
 * Nothing depends on the order — the gate compares SETS, and the two surfaces
 * that order statuses do it by their own weight maps (`app/reports/connectors.ts`)
 * — but a diff between the two files is far easier to read when they agree.
 */
export const INTEGRATION_STATUSES = [
  /**
   * No connection has ever been configured for this provider. The default.
   * A provider with no row is reported as this EXPLICIT constant, never as a
   * derived-from-null value — the repo's "no guessing state" rule.
   */
  "NOT_CONFIGURED",
  /**
   * A credential is present and the connection is being established. A row may
   * NOT rest here after a completed probe — see `connect()`.
   */
  "PROVISIONING",
  /** Usable. The last probe against the vendor succeeded. */
  "CONNECTED",
  /**
   * WARP-2623 — usable, and ONE dataset is refused because of the account's
   * PLAN or the app's granted SCOPES. Not `ERROR` ("Can't connect" sends the
   * owner to repair a connection with nothing wrong with it) and not
   * `NEEDS_RECONNECT` (a new key changes nothing). Sync keeps running.
   */
  "CAPABILITY_LIMITED",
  /**
   * Transient sync failure. A health signal, not a request for human action —
   * nobody needs to go and paste anything.
   */
  "DEGRADED",
  /** The schema fingerprint changed and writes are frozen (invariant 9). */
  "DRIFT_LOCKED",
  /**
   * WARP-2458 — the stored credential no longer works (revoked, rotated, or
   * its author removed) and pasting a new one DOES fix it. ADR-041 §5 names it
   * mandatory. Kept distinguishable from `NOT_CONFIGURED` on purpose: the two
   * look identical to a "does a credential decrypt?" check and mean opposite
   * things to the person reading the dashboard.
   */
  "NEEDS_RECONNECT",
  /**
   * Something reconnecting will not fix — the configuration is wrong, the
   * vendor rejects the integration itself, the track is unbuildable.
   */
  "ERROR",
  /** The operator turned this connection off deliberately. */
  "DISABLED",
] as const;

/**
 * The persisted connection lifecycle, as a TypeScript union.
 *
 * Derived from `INTEGRATION_STATUSES` — never written out a second time. Two
 * surfaces render it through TOTAL `Record`s (`PILL` and `WEIGHT` in
 * `apps/web-dashboard/src/app/reports/connectors.ts`), which is what makes
 * `tsc` refuse to compile a surface that has not learned a new member.
 *
 * Re-exported as `IntegrationStatusName` by the three modules that used that
 * name for their copy; `apps/web-dashboard/src/lib/erp-types.ts` re-exports it
 * under this one.
 */
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];
