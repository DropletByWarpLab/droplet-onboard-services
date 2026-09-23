/**
 * WARP-456 — Atomic emitter for the signed activity log.
 *
 * `record({kind, severity, sourceIcon, what, sub?, refs?})` is the
 * single writer to `ActivityRow`. Every other surface (chat, MCP tool
 * dispatch, file indexer MQTT bridge, Matter writes, auth events,
 * network ops) calls into here — direct `prisma.activityRow.create`
 * calls outside this module are a bug per AC3.
 *
 * Chain integrity is enforced inside a Prisma `$transaction`:
 *   1. Take the constant transaction-scoped advisory lock
 *      `pg_advisory_xact_lock(hashtext('droplet:activity-chain-append'))`
 *      so concurrent emitters fully serialize (WARP-1026 — a tail-row
 *      `FOR UPDATE` does NOT serialize appends under READ COMMITTED and
 *      forked the chain).
 *   2. Read the current tail row's signature.
 *   3. Compute the new row's signature with the injected signer.
 *   4. INSERT the new row. The lock releases at COMMIT/ROLLBACK.
 *
 * The signer is injected so tests can use a fixed key and production
 * pulls from `/data/secrets/audit.key` via `getDefaultSigner()`.
 */
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  hashSignature,
  type ActivityActorTypeName,
  type ActivityKindName,
  type ActivityRowContent,
  type ActivityRowSigner,
  type ActivitySeverityName,
} from "./audit-signing.service.js";
import { createLogger } from "../lib/logger.js";
import { READ_COMMITTED_TX } from "../lib/prisma-tx.js";

const logger = createLogger("activity-recorder");

/** Canonical set of accepted kinds — must match the Prisma `ActivityKind`
 * enum verbatim. Duplicated as a Set for the runtime guard so a typo
 * from a future emitter caller fails fast instead of writing a row the
 * dashboard can't filter by. */
const KNOWN_KINDS: ReadonlySet<ActivityKindName> = new Set<ActivityKindName>([
  "chat",
  "tool_call",
  "file",
  "camera",
  "network",
  "smart_home",
  "email",
  "auth",
  "tool_run",
  "system",
  "voice",
]);

const KNOWN_SEVERITIES: ReadonlySet<ActivitySeverityName> =
  new Set<ActivitySeverityName>(["ok", "warn", "err", "info"]);

const KNOWN_ACTOR_TYPES: ReadonlySet<ActivityActorTypeName> =
  new Set<ActivityActorTypeName>(["user", "ai", "system", "anonymous"]);

/**
 * WARP-181: the canonical-content version the recorder writes. Bumped
 * whenever the signature-covered shape changes;
 * `canonicalizeRowContent` must learn every historical value.
 */
export const CURRENT_ACTIVITY_SCHEMA_VERSION = 2;

/**
 * WARP-181: who performed the action. Required on every record() call
 * so an emitter can't silently produce an unattributed row.
 *
 *   - `user` — an authenticated household member. `id` (canonical user
 *     UUID) is REQUIRED; the recorder throws without it.
 *   - `ai` — the agent loop / MCP tool dispatch. `id` is the
 *     on-behalf-of user UUID when it was already plumbed through,
 *     else null.
 *   - `system` — the box itself (boot, tickers, sweeps, purges).
 *   - `anonymous` — pre-auth surfaces (failed/throttled sign-ins);
 *     ip/username context stays in `refs` as before.
 */
export interface ActivityActor {
  type: ActivityActorTypeName;
  id?: string | null;
}

/**
 * WARP-181: derive the actor for an emitter running inside an
 * Express handler.
 *
 *   - authenticated human → `user` with the canonical UUID;
 *   - service principal (`role: "service"` / `_service:*` id, e.g.
 *     the voice pipeline calling /api/llm/chat) → `system` with a
 *     null id. AC1 requires `actorId` to be a canonical user UUID,
 *     so principal strings must never land there under type `user`;
 *     and `ai` stays reserved for agent-loop-driven actions. Call
 *     sites that have the principal string keep it in `refs`
 *     (e.g. `refs.principal`);
 *   - no `req.user` (pre-auth surface) → `anonymous`.
 *
 * Deliberate divergence: `network-safety.service.ts` maps `_service:*`
 * principals to `ai` instead — network ops from service principals
 * arrive through the MCP/agent channel, which IS agent-loop-driven.
 * Do not "unify" the two mappings; each is surface-appropriate.
 */
export function actorFromRequest(req: {
  user?: { id: string; role?: string } | undefined;
}): ActivityActor {
  const user = req.user;
  if (!user?.id) return { type: "anonymous" };
  if (user.role === "service" || user.id.startsWith("_service:")) {
    return { type: "system", id: null };
  }
  return { type: "user", id: user.id };
}

export interface RecordParams {
  kind: ActivityKindName;
  severity: ActivitySeverityName;
  sourceIcon: string;
  what: string;
  sub?: string | null;
  refs?: Record<string, unknown> | null;
  /** WARP-181: required actor attribution — see `ActivityActor`. */
  actor: ActivityActor;
  /**
   * Optional override for the timestamp. The default is "now" so the
   * recorder controls the ordering in production; tests pass a fixed
   * time so the canonical JSON is deterministic.
   */
  at?: Date;
}

export interface RecordedActivityRow {
  id: bigint;
  at: Date;
  severity: ActivitySeverityName;
  sourceIcon: string;
  what: string;
  sub: string | null;
  kind: ActivityKindName;
  refs: Record<string, unknown> | null;
  signature: string;
  prevSignatureHash: string;
  actorType: ActivityActorTypeName | null;
  actorId: string | null;
  schemaVersion: number;
}

export interface ActivityRowRecorder {
  record(params: RecordParams): Promise<RecordedActivityRow>;
}

export interface ActivityRecorderDeps {
  prisma: PrismaClient;
  signer: ActivityRowSigner;
}

/**
 * The recorder's input checks, extracted (WARP-2977 P2b) so a caller that
 * appends inside its OWN transaction runs exactly the same guards. Throws —
 * a typo from a future emitter fails fast instead of writing a row the
 * dashboard can't filter by, or an unattributed one.
 */
export function validateRecordParams(params: RecordParams): void {
  if (!KNOWN_KINDS.has(params.kind)) {
    throw new Error(`unknown ActivityKind: ${String(params.kind)}`);
  }
  if (!KNOWN_SEVERITIES.has(params.severity)) {
    throw new Error(
      `unknown ActivitySeverity: ${String(params.severity)}`,
    );
  }
  if (!KNOWN_ACTOR_TYPES.has(params.actor?.type as ActivityActorTypeName)) {
    throw new Error(
      `unknown ActivityActorType: ${String(params.actor?.type)}`,
    );
  }
  const actorId = params.actor.id ?? null;
  if (params.actor.type === "user" && (!actorId || actorId.trim() === "")) {
    throw new Error(
      "actor of type 'user' requires a non-empty id (the caller's canonical user UUID)",
    );
  }
}

/**
 * The params as the chain will validate, sign and store them: every
 * `RecordParams` field read ONCE, by name, into a plain object, `at`
 * defaulting to `defaultAt` — the call time (WARP-2977 P2b). `record()` and `appendActivityRowInTx` both use it,
 * then validate THE COPY — so what is checked is what is signed and stored.
 *
 * Explicit reads, never a spread. The pre-split recorder (61fa4aebe) read
 * `params.what`, `params.actor.type`, `params.actor.id` … by name, so it saw
 * prototype getters, inherited and non-enumerable properties; `{...params}`
 * copies own enumerable ones only. A class implementing `ActivityActor` with
 * getters type-checks, and through a spread its actor became `{}` — the
 * append threw 'unknown ActivityActorType' (a silently dropped row behind
 * `recordSafely`), or a non-enumerable `ai` id was stored as NULL on a row
 * that still verified. A missing (null/undefined) actor stays missing, so
 * `validateRecordParams` reports it exactly as before.
 */
export function snapshotRecordParams(params: RecordParams, defaultAt: Date): RecordParams {
  // Field order = the order the pre-split recorder first touched them, so a
  // null `params` still fails on `kind`.
  return {
    kind: params.kind,
    severity: params.severity,
    sourceIcon: params.sourceIcon,
    what: params.what,
    sub: params.sub,
    refs: params.refs,
    actor: snapshotActor(params.actor),
    at: params.at ?? defaultAt,
  };
}

function snapshotActor(actor: ActivityActor): ActivityActor {
  return actor === null || actor === undefined ? actor : { type: actor.type, id: actor.id };
}

/**
 * The two things an append needs from a TRANSACTION handle — and never a bare
 * client. `& { $transaction?: never }` makes a `PrismaClient` a compile error
 * (a Prisma interactive-transaction client has no `$transaction`); the
 * runtime check in `appendActivityRowInTx` refuses one that got past the
 * types. On a bare client every statement autocommits, so the advisory lock
 * is released at the end of its own statement and serialises nothing: 24
 * concurrent bare-client appends were measured producing 19 forked links.
 *
 * The shape check is only the fast path. An object carrying just the bare
 * client's `$queryRawUnsafe` and `activityRow` — or a wrapper around the real
 * `tx` — type-checks and has no `$transaction`, so the append also requires
 * the transaction id Prisma puts on the interactive-transaction client (it
 * keys the per-transaction queue on it) and refuses a handle without one
 * before any statement. Under that, it compares `transaction_timestamp()`
 * across its lock and tail-read statements and refuses the call when they
 * ran in different transactions (autocommit, or a pool switch). A copy of
 * the handle (`{...tx}`, `Object.assign({}, tx)`, `{...tx, requestId}`)
 * type-checks and carries the id too (the spread copies the symbol key), but
 * not Prisma's methods — it is refused before any statement as well, as a
 * precondition, never as an outage.
 *
 * WHAT THESE CHECKS ASSUME: the real interactive-transaction handle, and ONE
 * instance of this module per process. They are in-process checks only. A
 * handle assembled on purpose from a real tx's id and raw method plus the
 * bare client's `activityRow` passes them all (the lock and the tail read run
 * in the tx, so the timestamps match), and its INSERT autocommits — the audit
 * row survives the caller's rollback (measured on pg16; the chain stays
 * linear only because the tx held the lock until then). A second copy of this
 * module (e.g. after `vi.resetModules`) keeps a second `appendQueues`, so
 * appends through the two copies on one transaction are not serialised
 * against each other. Neither happens in production code; a DB-side check
 * (a post-insert tail check, or a partial unique index on prevSignatureHash)
 * would be the defence in depth if it ever must be ruled out.
 */
export type ActivityAppendTx = Pick<Prisma.TransactionClient, "$queryRawUnsafe" | "activityRow"> & {
  $transaction?: never;
};

/**
 * The caller broke an append precondition (a bare client, a handle without
 * Prisma's transaction id, statements that ran outside one transaction, or a
 * transaction that is not READ COMMITTED). A
 * PROGRAMMING error, never an outage: the Security audit helper lets it
 * through unwrapped (a 500), instead of mapping it to 503 AUDIT_UNAVAILABLE.
 * Thrown before any row is written; the caller's transaction rolls back.
 */
export class ActivityChainPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivityChainPreconditionError";
  }
}

/**
 * Where Prisma's interactive-transaction client carries the id of ITS
 * transaction (Prisma 5.22 `_createItxClient`: one per `$transaction`
 * callback, the same through an `$extends` client). The bare client does not
 * carry it. activity.service.pg.test.ts pins both on the real client, so an
 * upgrade that drops or renames it fails closed there — every append refused —
 * instead of silently un-serialising them.
 */
const PRISMA_TX_ID = Symbol.for("prisma.client.transaction.id");

/**
 * The handle's transaction id, or ActivityChainPreconditionError before any
 * statement. Also refuses a handle whose `$queryRawUnsafe` or
 * `activityRow.create` is not a function: a spread / `Object.assign` copy of
 * the real tx carries the id (own enumerable symbol) but not Prisma's
 * methods, and would otherwise fail on its first statement with a TypeError
 * that the Security routes report as an outage (503 AUDIT_UNAVAILABLE)
 * instead of the programming error it is (500).
 */
function transactionIdOf(tx: ActivityAppendTx): string {
  const id: unknown = (tx as unknown as Record<symbol, unknown>)[PRISMA_TX_ID];
  if (typeof id !== "string" || id === "") {
    throw new ActivityChainPreconditionError(
      "activity chain append needs the interactive-transaction client Prisma handed the $transaction callback (it carries the transaction id the append queue is keyed on) — not the bare client, and not a wrapper built around the tx",
    );
  }
  const handle = tx as unknown as { $queryRawUnsafe?: unknown; activityRow?: { create?: unknown } | null };
  if (typeof handle.$queryRawUnsafe !== "function" || typeof handle.activityRow?.create !== "function") {
    throw new ActivityChainPreconditionError(
      "activity chain append needs the transaction client itself — this handle carries a transaction id but not Prisma's $queryRawUnsafe / activityRow.create (a {...tx} or Object.assign copy of the tx drops them): pass tx as Prisma handed it to the callback",
    );
  }
  return id;
}

/**
 * The appends waiting on each other, per TRANSACTION (WARP-2977 P2b).
 *
 * `pg_advisory_xact_lock` is re-entrant within one backend, so it serialises
 * nothing between two appends running concurrently on the SAME transaction:
 * both hold the lock at once, read the same tail and fork the chain (measured
 * on pg16: `Promise.all` of three Security audits on one tx committed with two
 * rows sharing a predecessor, and audit-verify broke for good). Before `record()`
 * had an in-tx sibling this could not happen, because every append opened its
 * own transaction on its own connection.
 *
 * So each append on a transaction waits until the previous one has SETTLED
 * (fulfilled or rejected) before it takes the lock and reads the tail.
 *
 * Keyed on Prisma's transaction id (`PRISMA_TX_ID`), NOT on the handle object:
 * a wrapper built per call around the real `tx` (`{ $queryRawUnsafe:
 * tx.$queryRawUnsafe.bind(tx), activityRow: tx.activityRow }`) type-checks,
 * has no `$transaction`, reports READ COMMITTED and the same
 * transaction_timestamp — and, keyed by object, got a queue of its own per
 * call: `Promise.all` over three such wrappers forked the chain on pg16. A
 * handle without the id is refused before any statement (so is the bare
 * client, and any object-shaped one); a wrapper that forwards the id queues
 * with every other handle on that transaction.
 *
 * "Does not block the next" holds for a rejection that stayed in JS (a signer
 * failure, a precondition). A rejection that REACHED the database (a failed
 * statement) aborts the whole Postgres transaction: every later append on it
 * fails 25P02, and the caller's transaction must reject. Hence the route
 * contract: `Promise.all` or sequential awaits, never `Promise.allSettled` —
 * swallowing the rejections lets `$transaction` resolve while Postgres rolled
 * everything back, including appends reported as fulfilled.
 *
 * The stored value never rejects, so a failed append cannot wedge the ones
 * queued behind it, and the entry is dropped as soon as the last queued
 * append settles (a Map of strings, so nothing outlives the queue).
 */
const appendQueues = new Map<string, Promise<unknown>>();

/**
 * Append one signed row to the chain INSIDE the caller's transaction
 * (WARP-2977 P2b). This is the recorder's transaction body (`appendNow`):
 * `record()` below is `validateRecordParams` + a params snapshot stamped with
 * the call time + `$transaction(tx => appendActivityRowInTx(…))`, so there is
 * ONE code path that signs and inserts. activity.service.test.ts pins its
 * output to literals computed from the pre-split recorder (61fa4aebe).
 *
 * Why a caller would want it: a security change and its audit row must
 * commit together — if the audit cannot be written, the change must not
 * happen either.
 *
 * PRECONDITIONS — enforced, not advisory:
 *   · `tx` is the interactive-transaction client Prisma handed the callback
 *     (`prisma.$transaction(async (tx) => …)`) — it carries the transaction
 *     id the append queue is keyed on. The bare client, an object-shaped
 *     client and a wrapper built around `tx` do not, and are refused with
 *     ActivityChainPreconditionError before any statement.
 *   · That transaction is READ COMMITTED — open it with `READ_COMMITTED_TX`
 *     (lib/prisma-tx.ts), never SERIALIZABLE_TX or REPEATABLE_READ_TX. Under
 *     REPEATABLE READ / SERIALIZABLE the tail read below uses the snapshot the
 *     caller took at its FIRST statement (before it waited for the lock), so
 *     it misses rows committed during the wait and chains from a stale
 *     predecessor — a permanent fork that SSI does not abort, because the
 *     other writer (`record()`) runs at READ COMMITTED. The isolation level is
 *     read in the same round-trip as the lock and refused with
 *     ActivityChainPreconditionError before anything is written.
 *   · Its statements run in ONE transaction. `transaction_timestamp()` rides
 *     the lock and the tail-read round-trips and must match — a second layer
 *     under the transaction-id check: a handle whose statements autocommit
 *     (even one that somehow carries an id) is refused with
 *     ActivityChainPreconditionError before anything is written. No extra
 *     round-trip.
 *   · Call it LAST in the callback: run every CAS / row-locking write FIRST,
 *     then the audits (`Promise.all` over the audits only, or one at a time)
 *     — never a CAS after any audit in the same callback. The chain-append
 *     advisory lock is transaction-scoped, so it is held until the CALLER
 *     commits, and every other audit writer on the box waits on it; a row
 *     lock taken after it inverts the lock order against every other audited
 *     writer, and Postgres kills one of the two with a deadlock (40P01; on
 *     pg16 a `Promise.all` over per-item `[CAS; audit]` pairs did exactly
 *     that). After the audits NOTHING else may run in the callback — in
 *     particular no global-client audit (`recordActivity`,
 *     `getActivityRecorder().record`, `auditSecuritySystem`): it would wait
 *     for this very lock, on another connection, until the interactive
 *     transaction times out (P2028), and Postgres cannot see that deadlock.
 *     The change would be lost.
 *   · Rejections propagate out of the callback: `Promise.all` or sequential
 *     awaits, never `Promise.allSettled`. A rejection that reached the
 *     database has aborted the whole Postgres transaction (see
 *     `appendQueues`).
 *
 * Appends on ONE transaction are serialised in-process, in call order
 * (`appendQueues`, keyed on Prisma's transaction id): `Promise.all` of several
 * audits on one `tx` produces a linear chain, and a rejection that did not
 * reach the database does not block the next one. It serialises appends only:
 * a global-client audit must still never run in, or be interleaved with, a
 * callback that appends in-tx.
 *
 * A rolled-back append leaves a gap in the `ActivityRow.id` sequence, and that
 * is harmless: `verifyActivityChain` walks rows in id order but links each one
 * to its predecessor by signature (`prevSignatureHash` = hash of the previous
 * row's signature), never by id adjacency. Do not add a "contiguous ids" check
 * to the verifier.
 *
 * Every check above assumes the REAL handle Prisma handed the callback and
 * ONE instance of this module in the process — see `ActivityAppendTx` for
 * what a handle assembled on purpose, or a second module copy, can still get
 * past. They catch mistakes; they are not a boundary against deliberate misuse.
 */
export async function appendActivityRowInTx(
  tx: ActivityAppendTx,
  signer: ActivityRowSigner,
  params: RecordParams,
): Promise<RecordedActivityRow> {
  // Snapshot FIRST, stamped with the call time like record()'s, then validate
  // the snapshot: what is checked is exactly what is signed and stored. The
  // append may wait behind an earlier one on this transaction, and must use
  // what the caller passed when it called, not what its params object holds
  // by the time its turn comes.
  const p = snapshotRecordParams(params, new Date());
  validateRecordParams(p);
  if ("$transaction" in tx) {
    throw new ActivityChainPreconditionError(
      "activity chain append needs an interactive-transaction client, not the bare Prisma client (the advisory lock would serialise nothing)",
    );
  }
  const txId = transactionIdOf(tx);
  const before = appendQueues.get(txId);
  const mine = before === undefined ? appendNow(tx, signer, p) : before.then(() => appendNow(tx, signer, p));
  const settled = mine.then(
    () => undefined,
    () => undefined,
  );
  appendQueues.set(txId, settled);
  try {
    return await mine;
  } finally {
    if (appendQueues.get(txId) === settled) appendQueues.delete(txId);
  }
}

/** The append itself — lock, precondition checks, tail read, sign, insert. Only via the queue above. */
async function appendNow(
  tx: ActivityAppendTx,
  signer: ActivityRowSigner,
  params: RecordParams,
): Promise<RecordedActivityRow> {
  const actorId = params.actor.id ?? null;

  const at = params.at ?? new Date();
  const content: ActivityRowContent = {
    at,
    severity: params.severity,
    sourceIcon: params.sourceIcon,
    what: params.what,
    sub: params.sub ?? null,
    kind: params.kind,
    refs: params.refs ?? null,
    actorType: params.actor.type,
    actorId,
    // Explicit — never a DB default. The migration backfilled
    // pre-upgrade rows to 1; everything the recorder writes is
    // the current version.
    schemaVersion: CURRENT_ACTIVITY_SCHEMA_VERSION,
  };

  // Atomic SELECT-prev + INSERT, serialized by a transaction-scoped
  // advisory lock (WARP-1026).
  //
  // Why NOT `SELECT ... FOR UPDATE` on the tail row (the pre-WARP-1026
  // approach): under READ COMMITTED a second writer whose SELECT
  // starts while the first holds the tail lock blocks, then resumes
  // with its ORIGINAL statement snapshot — EvalPlanQual re-checks only
  // the locked row, it does NOT re-scan for the newer, higher-id row
  // the first writer just committed. Both writers then chain from the
  // same predecessor and fork the chain (permanent "Chain broken" on
  // /admin/audit). FOR UPDATE also does nothing for two concurrent
  // genesis writers on an empty table.
  //
  // `pg_advisory_xact_lock` (blocking variant — an append must wait,
  // not skip; contrast cron-runtime.service.ts's try-variant) is held
  // until COMMIT/ROLLBACK and released by Postgres on the acquiring
  // backend, so a throwing signer can't leak it. Constant key: every
  // appender in every orchestrator process contends on the same lock,
  // which IS the serialization the chain needs. Appliance-scale cost
  // is one extra round-trip per append.
  //
  // `pg_advisory_xact_lock` returns `void`, which Prisma's raw-query
  // deserializer rejects (P2010, "cannot deserialize column of type
  // void"). Wrapping in `IS NULL` yields a real boolean column and
  // is a no-op on the locking behaviour; the recorder ignores the
  // returned value.
  //
  // The isolation level rides the same round-trip (WARP-2977 P2b): the
  // precondition costs no extra statement, and it is read INSIDE the
  // transaction, so it reports the caller's real level whatever the
  // database default is. `record()` opens its transaction with
  // READ_COMMITTED_TX, so it passes whatever the client's or the database's
  // default is (pinned by activity.service.pg.test.ts).
  //
  // So does `transaction_timestamp()`, and the tail read below selects it
  // again: equal values prove both statements ran in ONE transaction — a
  // second layer under the transaction-id check in appendActivityRowInTx. A
  // handle whose statements autocommit passes the shape check and reports
  // 'read committed' too, but each of its statements is its own transaction
  // with its own start time. As text, not a Date: text keeps the
  // microseconds. The tail read is one row even on an empty table (the
  // signature is a scalar subquery, NULL at genesis) so the check always has
  // both values; the subquery is the same index scan the plain SELECT was.
  const lockRows = await tx.$queryRawUnsafe<Array<{ locked: boolean; iso: string; txts: string }>>(
    "SELECT (pg_advisory_xact_lock(hashtext('droplet:activity-chain-append')) IS NULL) AS locked, current_setting('transaction_isolation') AS iso, transaction_timestamp()::text AS txts",
  );
  const iso = lockRows[0]?.iso;
  if (iso !== "read committed") {
    throw new ActivityChainPreconditionError(
      `activity chain append needs a READ COMMITTED transaction (READ_COMMITTED_TX), got ${JSON.stringify(iso ?? null)}: a later snapshot would chain from a stale tail and fork the chain`,
    );
  }
  const prevRows = await tx.$queryRawUnsafe<Array<{ txts: string; signature: string | null }>>(
    'SELECT transaction_timestamp()::text AS txts, (SELECT "signature" FROM "ActivityRow" ORDER BY "id" DESC LIMIT 1) AS signature',
  );
  const lockTxts = lockRows[0]?.txts;
  if (typeof lockTxts !== "string" || lockTxts === "" || prevRows[0]?.txts !== lockTxts) {
    throw new ActivityChainPreconditionError(
      "activity chain append ran its lock and its tail read in different transactions (an autocommitting handle, e.g. the bare client's methods on another object): the advisory lock would serialise nothing",
    );
  }
  const prevSig = prevRows[0]?.signature ?? "";
  const prevSignatureHash = prevSig === "" ? "" : hashSignature(prevSig);
  const signature = signer.sign(content, prevSignatureHash);

  // refs is JSON; Prisma's Json input is structurally typed so
  // we cast to its expected shape. `undefined` would cause
  // Prisma to omit the field; we want explicit null.
  const data: Prisma.ActivityRowCreateInput = {
    at,
    severity: params.severity,
    sourceIcon: params.sourceIcon,
    what: params.what,
    sub: params.sub ?? null,
    kind: params.kind,
    refs:
      content.refs === null
        ? Prisma.DbNull
        : (content.refs as Prisma.InputJsonValue),
    signature,
    prevSignatureHash,
    actorType: content.actorType,
    actorId: content.actorId,
    schemaVersion: content.schemaVersion,
  };
  const inserted = await tx.activityRow.create({ data });

  return {
    id: inserted.id,
    at: inserted.at,
    severity: inserted.severity as ActivitySeverityName,
    sourceIcon: inserted.sourceIcon,
    what: inserted.what,
    sub: inserted.sub,
    kind: inserted.kind as ActivityKindName,
    refs:
      inserted.refs === null
        ? null
        : (inserted.refs as Record<string, unknown>),
    signature: inserted.signature,
    prevSignatureHash: inserted.prevSignatureHash,
    actorType: inserted.actorType as ActivityActorTypeName | null,
    actorId: inserted.actorId,
    schemaVersion: inserted.schemaVersion,
  };
}

/**
 * Build a recorder bound to a Prisma client + signer. One instance per
 * orchestrator process; multiple call sites share it.
 *
 * `record()` validates BEFORE opening the transaction, so a bad call never
 * takes the chain lock; `appendActivityRowInTx` validates again for the
 * callers that come to it directly.
 *
 * The default timestamp is taken HERE, at call time, exactly where the
 * pre-split recorder took it — not inside the transaction, where it would
 * land only after Prisma had checked out a pooled connection and sent BEGIN
 * (up to `maxWait` later under load). The append gets `snapshotRecordParams`'
 * copy — every field read once, by name, the actor's `type` and `id` too —
 * stamped with that time, and it is the COPY that is validated. So a caller
 * reassigning a field of its params or of its actor after the call cannot
 * change the stored row or make the append throw, and a getter-based or
 * inherited field is read the way the pre-split recorder read it: the row is
 * what that recorder, which read everything at call time by name, wrote.
 * (Nested `refs` are shared, as they always were, and are read once for both
 * the signature and the insert.)
 *
 * The snapshot comes before the validation here too, not after: an `actor.id`
 * getter is then read ONCE for both the check and the row, as 61fa4aebe read
 * it once into `actorId` — validating the original and then copying would
 * read it twice.
 */
export function createActivityRecorder(
  deps: ActivityRecorderDeps,
): ActivityRowRecorder {
  return {
    async record(params) {
      const p = snapshotRecordParams(params, new Date());
      validateRecordParams(p);
      // READ COMMITTED stated, never inherited (lib/prisma-tx.ts: every call
      // site states its level): the append refuses any other level, so on a
      // client built with `transactionOptions: {isolationLevel: 'Serializable'}`
      // or a database whose default is not READ COMMITTED, inheriting would
      // refuse EVERY record() — and behind recordSafely / recordActivity each
      // refusal is a silently dropped audit row. 61fa4aebe always wrote.
      return deps.prisma.$transaction(
        (tx) => appendActivityRowInTx(tx, deps.signer, p),
        READ_COMMITTED_TX,
      );
    },
  };
}

/**
 * Process-singleton recorder. Lazy so tests that construct their own
 * recorder via `createActivityRecorder` don't pay the cost.
 *
 * Best-effort: when MQTT/Redis are down the orchestrator keeps
 * running, and so does the audit log — the signing key is the only
 * hard dependency. If `loadAuditKeyFromDisk` fails, the orchestrator
 * exits at startup (per `audit-signing.service.ts`'s contract); we
 * never silently degrade to unsigned rows.
 */
let cachedRecorder: ActivityRowRecorder | null = null;

export function getDefaultRecorder(
  prisma: PrismaClient,
  signer: ActivityRowSigner,
): ActivityRowRecorder {
  if (cachedRecorder) return cachedRecorder;
  cachedRecorder = createActivityRecorder({ prisma, signer });
  return cachedRecorder;
}

/** Exposed only for tests. */
export function _resetDefaultRecorderForTests(): void {
  cachedRecorder = null;
}

/**
 * Convenience wrapper that swallows recorder failures with a logged
 * warning. Use this from emitter call sites where the audit log is
 * desirable but the calling flow MUST NOT block on an audit-table
 * failure (e.g. chat /api/llm/chat — losing audit on one turn is
 * acceptable; failing the chat reply is not).
 *
 * The recorder is still synchronous from the caller's perspective —
 * callers `await` so the row lands before the next event for chain
 * ordering — but failures don't propagate. This mirrors the existing
 * `logNetworkCommand` swallow pattern in `network-safety.service.ts`.
 */
export async function recordSafely(
  recorder: ActivityRowRecorder,
  params: RecordParams,
): Promise<RecordedActivityRow | null> {
  try {
    return await recorder.record(params);
  } catch (err) {
    logger.warn(
      { err, kind: params.kind, what: params.what },
      "ActivityRow recorder failed (audit row dropped — caller continues)",
    );
    return null;
  }
}

// Prisma's namespace is imported at the top of the file (alongside the
// type-only PrismaClient) for runtime use of `Prisma.DbNull`. The shared test
// setup (`src/__tests__/setup.ts`) exports the three JSON-null sentinels as
// distinct objects, so a suite mocking `@prisma/client` gets a value that
// compares by identity rather than an `undefined` that silently matches
// everything (WARP-2484).
export type { Prisma };
