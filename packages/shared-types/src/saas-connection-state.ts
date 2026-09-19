/**
 * WARP-2633 — the ONE `SaasConnectionState`.
 *
 * What the credentials configurator tells a person about a connection. It was
 * two hand-maintained copies — `apps/orchestrator/src/services/saas-credential.service.ts`
 * and `apps/web-dashboard/src/lib/api.ts` — with nothing asserting they agreed.
 * Both now import from here.
 *
 * The failure that shape produces is not hypothetical and not gradual: the
 * dashboard renders this union through a total `Record` (`STATE_COPY` in
 * `SaasCredentialsSection.tsx`), so a member the box can send and the
 * dashboard's copy lacks makes `STATE_COPY[view.state]` `undefined` and takes
 * the page down — on exactly the rows the page exists to repair. That is the
 * WARP-2517 defect, and WARP-2623 had to add `CAPABILITY_LIMITED` to both
 * copies by hand for the same reason.
 *
 * ## Why the array and not just a union
 *
 * A union type has no runtime value, so nothing can iterate it and no test can
 * compare it to the Prisma enum. `SAAS_CONNECTION_STATES` is the single list;
 * `SaasConnectionState` is DERIVED from it. There is therefore no second place
 * to add a member and no way for the type and the list to disagree — the
 * property the two copies could never have.
 *
 * ## Relationship to the Prisma `IntegrationStatus` enum
 *
 * These are two vocabularies for one fact, and today they have identical
 * member sets. `saasConnectionState()` in `saas-credential.service.ts` maps
 * every persisted status to the state of the same name, with two derivations
 * layered on top that use no member the enum lacks:
 *
 *  - `DISABLED` wins over everything (an operator turned it off);
 *  - a row with NO stored credential reports `NOT_CONFIGURED` whatever the
 *    status column says, and `NOT_CONFIGURED` / `PROVISIONING` WITH one report
 *    `PROVISIONING`.
 *
 * `NON_CONNECTION_INTEGRATION_STATUSES` below names the statuses that are
 * deliberately NOT in this union. It is empty today, and it is stated
 * explicitly rather than left to be inferred from a set difference — "no
 * member is excluded" and "somebody forgot a member" look identical to a
 * reader and to a test that derives the exclusion by absence.
 *
 * The parity gate is `apps/orchestrator/src/__tests__/integration-status.schema.test.ts`,
 * which reads `schema.prisma` (the orchestrator is the only workspace that
 * has it) and set-compares both ways.
 *
 * ## Order
 *
 * Declared in the Prisma enum's order so the two lists read the same way side
 * by side. Nothing depends on it — the gate compares SETS — but a diff between
 * the two files is a great deal easier to read when they agree.
 */
export const SAAS_CONNECTION_STATES = [
  /** No credential is stored for this provider. The default. */
  "NOT_CONFIGURED",
  /** A credential is held and has not yet been proved to work. */
  "PROVISIONING",
  /** The last probe against the vendor succeeded. */
  "CONNECTED",
  /**
   * WARP-2623 — the connection WORKS and ONE dataset is refused, because of
   * the account's plan or the app's granted scopes. Not `ERROR` ("Can't
   * connect" sends the owner to repair a credential with nothing wrong with
   * it) and not `NEEDS_RECONNECT` (a new key changes nothing).
   */
  "CAPABILITY_LIMITED",
  /** Connected, with recent transient failures. A health signal. */
  "DEGRADED",
  /** The vendor's schema fingerprint changed and writes are frozen. */
  "DRIFT_LOCKED",
  /**
   * WARP-2458 — the stored credential no longer works and pasting a new one
   * DOES fix it. Distinguishable from `DISCONNECTED`/`NOT_CONFIGURED` on
   * purpose: the two look identical to a "does a token decrypt?" check and
   * mean opposite things to a human.
   */
  "NEEDS_RECONNECT",
  /**
   * Something reconnecting will NOT fix — a vendor-side refusal such as an IP
   * access policy. Kept apart from `NEEDS_RECONNECT` so the copy never tells
   * an admin to mint keys until one of them works.
   */
  "ERROR",
  /** The operator turned this connection off deliberately. */
  "DISABLED",
] as const;

/**
 * What the configurator tells a person about a connection.
 *
 * Derived from `SAAS_CONNECTION_STATES` — never written out a second time.
 * Consumers render it through a TOTAL `Record`, which is what makes `tsc`
 * refuse to compile a surface that has not learned a new member.
 */
export type SaasConnectionState = (typeof SAAS_CONNECTION_STATES)[number];

/**
 * `IntegrationStatus` members that are deliberately NOT connection states.
 *
 * Empty today: every persisted status has a state of the same name, because
 * every one of them is something the credentials page has to be able to say.
 *
 * It exists anyway, and it is the point of the exercise. The parity gate
 * asserts `SAAS_CONNECTION_STATES ∪ this === IntegrationStatus`, so the next
 * status added to Prisma fails that gate until somebody DECIDES: either it is
 * a state a person is shown (add it here to `SAAS_CONNECTION_STATES` and give
 * the dashboard's `STATE_COPY` a row) or it is internal (add it here, with the
 * sentence explaining why a person never sees it). What must not happen is the
 * decision being made by omission — a member missing from one list because
 * nobody noticed reads exactly like a member excluded on purpose, and that is
 * the "no guessing state" rule applied to a union instead of a column.
 *
 * Typed `readonly string[]` rather than `as const`: the orchestrator's
 * `IntegrationStatusName` cannot be imported here (this package is a LEAF —
 * the orchestrator depends on it, not the other way round), and the parity
 * gate that compares this to the Prisma enum is where a bogus entry is caught.
 */
export const NON_CONNECTION_INTEGRATION_STATUSES: readonly string[] = [];
