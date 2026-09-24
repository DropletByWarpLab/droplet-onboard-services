/**
 * The `$transaction` isolation levels this app opens transactions at.
 *
 * ONE home for both, because they answer the same question and the answer
 * has to be picked deliberately each time. Prisma's interactive
 * `$transaction` does NOT default to anything safe: it inherits the database
 * default, which on Postgres is READ COMMITTED, where every statement takes
 * a fresh snapshot. Every call site therefore passes one of these
 * EXPLICITLY — the discipline `role-mutation-guard.service.ts` established
 * for writes (pr-reviewer #1229 B1) and WARP-1583 extended to reads.
 *
 * The string literals (rather than
 * `Prisma.TransactionIsolationLevel.Serializable`) keep this module free of
 * a RUNTIME `@prisma/client` import, while the `$transaction` options type
 * still checks them against the generated union — so a typo is a compile
 * error, not a silent downgrade.
 */

/**
 * SERIALIZABLE — for CHECK-THEN-WRITE mutations.
 *
 * The guard rails are read-then-decide-then-write (COUNT the surviving
 * owner∪admin rows, then demote / disable / delete in the same transaction).
 * Under READ COMMITTED two concurrent requests each removing one of the last
 * two operators BOTH read "one other operator remains", BOTH pass, and BOTH
 * commit — landing exactly the zero-operator state the rails exist to
 * prevent. Under SERIALIZABLE the loser aborts with P2034, which routes map
 * to CONCURRENT_MUTATION rather than a 500 (`isConcurrencyConflict`).
 *
 * Re-exported from `role-mutation-guard.service.ts`, where the full rail
 * contract is documented and where every existing call site imports it from.
 */
export const SERIALIZABLE_TX = { isolationLevel: "Serializable" } as const;

/**
 * REPEATABLE READ — for multi-statement READS that compose one answer.
 *
 * WARP-1583. A resolver that issues several reads and combines them needs
 * every read to see the same snapshot, or it can return a composition of
 * rows that never coexisted. `resolveEffectiveAccess` is the case that
 * forced this: it reads a user (with nested relation selects, which Prisma
 * emits as separate statements) and then a six-way `Promise.all`, and a role
 * re-base committing between two of those statements yields a mixed view —
 * a pre-change tier paired with post-change connector grants, which is WIDER
 * than either committed state because the connector axis has no
 * compose-time tier floor.
 *
 * REPEATABLE READ and not SERIALIZABLE, deliberately. A read-only
 * transaction has no write-write conflict to lose, but Postgres SSI can
 * still abort one to preserve serializability — turning a plain
 * authorization read into a P2034, and a 500 on every route the feature gate
 * protects. REPEATABLE READ gives the stable snapshot the composition needs
 * and cannot abort a transaction that writes nothing.
 *
 * The array form of `$transaction` is NOT a substitute: it is a batch, and
 * under READ COMMITTED each statement in it still takes its own snapshot.
 * Use the interactive form and thread the `tx` handle into every read,
 * including the ones that live in another service.
 */
export const REPEATABLE_READ_TX = { isolationLevel: "RepeatableRead" } as const;

/**
 * READ COMMITTED — for COMPARE-AND-SET writes on a version column.
 *
 * WARP-2977 P2b (the Security site mode, opening hours and areas). Every
 * write there is `updateMany({ where: { id, version: expected }, data: {
 * …, version: { increment: 1 } } })` and reads its `count`: 1 = this writer
 * won, 0 = somebody else moved the row first (a 409, or a skipped tick).
 * The CAS row lock is the serialisation point, and under READ COMMITTED
 * Postgres re-evaluates the `version` predicate against the row a concurrent
 * writer just committed (EvalPlanQual), so the loser deterministically sees
 * count 0 — no P2034 to map, no retry loop.
 *
 * Deliberately NOT SERIALIZABLE: SSI would also abort the loser, but as a
 * P2034 thrown from whichever statement tripped it (possibly the audit
 * append or the feed-row insert AFTER the CAS), turning a clean "someone
 * else changed it" into a 500-shaped error in the middle of the chain
 * writer. And NOT REPEATABLE READ: a concurrent update there raises a
 * serialization failure instead of re-checking the predicate.
 *
 * Named explicitly rather than relying on the database default, for the same
 * reason as the other two: every `$transaction` call site states its level.
 *
 * REQUIRED for any transaction that appends to the audit chain in-tx
 * (`appendActivityRowInTx`, `recordActivityInTx`, `auditSecurityInTx`): the
 * append reads the chain tail after waiting for the chain lock, and only READ
 * COMMITTED gives that read a fresh snapshot. The append checks the level and
 * throws on anything else — so a Security write that audits can NEVER use
 * SERIALIZABLE_TX or REPEATABLE_READ_TX. Order inside the callback: run every
 * CAS / row-locking write FIRST, then the audits (`Promise.all` over the
 * audits only, or one at a time) — never a CAS after any audit in the same
 * callback, which inverts the lock order (chain lock, then row lock) against
 * every other audited writer and deadlocks (40P01). Nothing may follow the
 * audits, least of all a global-client audit (it would self-deadlock on the
 * chain lock until the transaction times out). Several in-tx appends on one
 * transaction are serialised in-process and chain linearly — the advisory
 * lock cannot do that, it is re-entrant within the one connection — but that
 * covers appends only: a global-client audit must still never be interleaved
 * with them. Rejections must propagate out of the callback (`Promise.all` or
 * sequential awaits, never `Promise.allSettled`): a rejection that reached the
 * database has aborted the whole Postgres transaction, and swallowing it lets
 * `$transaction` resolve while everything was rolled back.
 */
export const READ_COMMITTED_TX = { isolationLevel: "ReadCommitted" } as const;
