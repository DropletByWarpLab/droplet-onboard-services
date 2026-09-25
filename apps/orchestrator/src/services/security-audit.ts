/**
 * WARP-2977 P2b (ADR-059 §3.4, §3.6) — the audit trail for Security changes.
 *
 * Every human change to the site mode, the opening hours or an area is an
 * ActivityRow written IN THE SAME TRANSACTION as the change
 * (`auditSecurityInTx`): if the row cannot be written, the change rolls back
 * and the route answers 503 `AUDIT_UNAVAILABLE`. A human change never
 * commits unaudited.
 *
 * The one system change — the opening hours taking over from a manual
 * override when it ends — is audited AFTER its commit through the throwing
 * cron recorder (`auditSecuritySystem`). A broken chain must never keep a
 * manual Open up alive, and `resolveMode` already ends it on read; the throw
 * reaches `safeRun`'s failure canary instead.
 *
 * Row shape, fixed: kind `system`, severity `info`, sourceIcon `shield`,
 * refs `{surface: 'security', action, …}`. NEVER kind `network`/`auth` and
 * never severity `warn`/`err`: the P2a threat mirror copies exactly those
 * into the Security feed as threats, and a person changing the opening hours
 * is not one.
 *
 * Route contract for an audited write (slices A and B):
 *   · open the transaction READ COMMITTED (lib/prisma-tx.ts's read-committed
 *     constant) — never serializable or repeatable read (the append refuses
 *     them: a later snapshot forks the chain);
 *   · pass the `tx` Prisma handed the callback — never the bare client nor a
 *     wrapper built around `tx` (the append refuses a handle without Prisma's
 *     transaction id: a 500);
 *   · run every CAS / row-locking write FIRST, then the audits (`Promise.all`
 *     over the audits only, or one at a time) — never a CAS after any audit
 *     in the same callback. The first audit takes the box-wide chain lock; a
 *     row lock taken after it inverts the lock order against every other
 *     audited writer and Postgres kills one of them with a deadlock (40P01 —
 *     measured on pg16 with `Promise.all` over per-item `[CAS; audit]`
 *     pairs, answered 500). So a bulk change CASes every item, checks every
 *     count, and only then audits. Audit only after a count of 1, and run
 *     NOTHING after the audits (no global-client audit — it self-deadlocks on
 *     the chain lock until the transaction times out). Several audits on one
 *     `tx` are serialised in-process and chain linearly;
 *   · let every rejection propagate out of the callback: `Promise.all` or
 *     sequential awaits, never `Promise.allSettled`. A rejection that reached
 *     the database (a failed statement) has aborted the whole Postgres
 *     transaction; swallowing it lets `$transaction` resolve while Postgres
 *     rolled everything back — the change AND the audits reported fulfilled;
 *   · map `isSecurityAuditUnavailable(err)` to 503 `AUDIT_UNAVAILABLE` — it
 *     covers the wrapped append failure AND Prisma's P2028. Under this
 *     contract a P2028 means "503, the change rolled back", whatever the
 *     cause (the chain-lock wait, a CAS row-lock wait, no pooled connection
 *     within `maxWait`);
 *   · expect the request to take as long as the chain-lock HOLDER, not the
 *     transaction `timeout`: Prisma expires the transaction on time, but the
 *     statement waiting on the lock keeps waiting in Postgres, and
 *     `$transaction` settles only when the lock frees (measured on pg16: three
 *     waiters with `timeout: 500` settled at 3036 ms, when the holder released
 *     at 3000 ms). The holder is another audited write or `record()`, each a
 *     few statements long, so this is only slow when the database is;
 *   · 400 user text that `chainSafeText` refuses BEFORE the transaction — a
 *     TypeError from here is a programming error (a 500), not an outage.
 */
import {
  ActivityChainPreconditionError,
  actorFromRequest,
  validateRecordParams,
  type ActivityActor,
  type ActivityAppendTx,
  type RecordedActivityRow,
  type RecordParams,
} from "./activity.service.js";
import { getActivityRecorder, recordActivityInTx } from "./activity.singleton.js";

export type SecurityAuditAction =
  | "mode.close"
  | "mode.open"
  | "mode.away"
  | "mode.resume"
  /** System actor only: the opening hours took over from an expired manual mode. */
  | "mode.expire"
  | "hours.set"
  | "hours.clear"
  | "exception.set"
  | "exception.delete"
  | "zone.create"
  | "zone.update"
  | "zone.archive"
  | "zone.unarchive"
  /** refs `{zoneId, added: string[], removed: string[], reactivated: string[]}`. */
  | "zone.links"
  /**
   * WARP-2978 (ADR-059 P3 §6.9). A person acknowledged / resolved an incident
   * (in-tx, last). refs `{incidentId, ackId, severity, codes, visibleCodes,
   * state}`: `codes` incident-wide, `visibleCodes` the ones the actor could
   * see (review b7e1). Never the resolve note (user text stays off the chain).
   */
  | "incident.acknowledge"
  | "incident.resolve"
  /** System actor, after the notices commit. refs `{incidentId, notices: [{userId, outcome, reason}]}`. */
  | "incident.alerted"
  /** A person chose who is told about alerts (in-tx, last). refs `{userId, state, eligibleReceivers}`. */
  | "alert_routing.set"
  /**
   * WARP-2980 (ADR-059 P5 PR-B). A person added expected activity (in-tx,
   * last). refs `{suppressionId, target: {kind, zoneId | camera}, label, days,
   * hourFrom, hourCount, codes, expiresAt}` — never the reason (user text
   * stays off the chain).
   */
  | "suppression.create"
  /** A person removed expected activity (in-tx, last). refs `{suppressionId}`. */
  | "suppression.remove"
  /** System actor, after its commit: expected activity passed its expiresAt (the baseline tick). refs `{suppressionId}`. */
  | "suppression.expire"
  /**
   * WARP-2980 PR-B. A person marked an incident Expected / Not expected
   * (in-tx, last). refs `{incidentId, verdict, from, codes, incidentCodes}`:
   * `codes` what they judged (`verdictCodes`), `incidentCodes` the incident's
   * counted codes.
   */
  | "incident.verdict";

/** A JSON value exactly as the chain signs and stores it. */
export type SecurityRefValue =
  | string
  | number
  | boolean
  | null
  | SecurityRefValue[]
  | { [key: string]: SecurityRefValue };

export interface SecurityAuditEntry {
  action: SecurityAuditAction;
  /** e.g. `Security: closed up`. Plain copy; shown on /admin/audit. Must pass `chainSafeText`. */
  what: string;
  /** Must pass `chainSafeText` when set. */
  sub?: string | null;
  /** Merged under `{surface: 'security', action}` — which always win. Ids as strings, times as ISO strings, numbers safe integers only (see `securityRefs`). */
  refs?: Record<string, unknown>;
}

/**
 * The audit append failed inside a route transaction. The route catches THIS
 * (via `isSecurityAuditUnavailable`, not every error) and answers 503
 * `{error: {code: 'AUDIT_UNAVAILABLE'}}`; the transaction has already rolled
 * the change back.
 */
export class SecurityAuditUnavailableError extends Error {
  readonly code = "AUDIT_UNAVAILABLE" as const;
  constructor(cause: unknown) {
    super(`security audit unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "SecurityAuditUnavailableError";
  }
}

/**
 * Whether a failed audited write should answer 503 `AUDIT_UNAVAILABLE`:
 *   · a `SecurityAuditUnavailableError` (the in-tx append failed), or
 *   · Prisma P2028 — the interactive transaction expired (or could not
 *     start). It surfaces from `$transaction` itself, OUTSIDE
 *     `auditSecurityInTx`, so the route has to classify it here.
 *
 * Keyed on the code alone, deliberately: for a route that follows the
 * contract above (every statement awaited inside the callback), P2028 means
 * "503, the change rolled back", whatever the cause — the box-wide chain lock
 * outlasting the transaction timeout (the usual one), a CAS row-lock wait
 * doing the same, or no pooled connection within `maxWait`. Not a timing
 * promise: the transaction expires at `timeout`, but the request returns only
 * when the statement waiting on the chain lock returns, i.e. when the lock's
 * holder commits. The one P2028 that does NOT mean "rolled back" is a `tx`
 * used after its callback resolved (an append that was not awaited) — the
 * change has committed without its row, which is why the contract forbids it.
 *
 * Anything else (a TypeError from bad input, ActivityChainPreconditionError)
 * is a programming error and stays a 500. That includes a deadlock (40P01)
 * outside the append, deliberately: under the contract above every audited
 * writer takes its row locks before the chain lock, so a deadlock means a
 * route broke the lock order, and it should fail loudly rather than read as
 * an outage. (It could not be classified reliably anyway: on Prisma 5.22 a
 * deadlocked raw statement is P2010 with `meta.code` 40P01, but a deadlocked
 * `updateMany` — the CAS — is a PrismaClientUnknownRequestError with the
 * SQLSTATE only inside its message text.) A deadlock whose victim is the
 * append's own lock statement is wrapped like any append failure.
 */
export function isSecurityAuditUnavailable(err: unknown): boolean {
  if (err instanceof SecurityAuditUnavailableError) return true;
  return (err as { code?: unknown } | null | undefined)?.code === "P2028";
}

/**
 * True when Postgres can store `s` in `text` and `jsonb` and it round-trips
 * byte-for-byte: no U+0000 (text refuses it with 22021, jsonb with 22P05) and
 * no lone surrogate (not valid UTF-8 at all). Routes run user text (area
 * names, exception notes) through this and answer 400 before the
 * transaction; `securityRefs` and `auditSecurityInTx` throw on it.
 */
export function chainSafeText(s: string): boolean {
  return !s.includes("\u0000") && isWellFormed(s);
}

/**
 * Characters person-controlled text shown on the Security surfaces (feed
 * rows, the mode card, /admin/audit) may not carry: C0/C1 controls, line and
 * paragraph separators, the bidi embeddings / overrides U+202A–U+202E and
 * isolates U+2066–U+2069 (they reorder everything after them on the line, and
 * an unclosed one runs into the fixed copy around the text), and U+FEFF.
 * Deliberately narrow: ZWNJ / ZWJ (Persian and Indic names, emoji) and the
 * LRM / RLM / ALM marks (they leave no open state behind) stay. Area names
 * have their own, stricter rule (`normaliseZoneName`) because they must also
 * be unique by sight.
 */
const DISPLAY_UNSAFE = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069\uFEFF]/u;
const DISPLAY_UNSAFE_ALL = new RegExp(DISPLAY_UNSAFE.source, "gu");

/** True when `s` holds a character `DISPLAY_UNSAFE` refuses (→ 400 for user input). */
export function hasUnsafeDisplayChars(s: string): boolean {
  return DISPLAY_UNSAFE.test(s);
}

/** `s` without the characters `DISPLAY_UNSAFE` refuses — for text that is not this request's input (a stored display name). */
export function stripUnsafeDisplayChars(s: string): string {
  return s.replace(DISPLAY_UNSAFE_ALL, "");
}

/** `String.prototype.isWellFormed` (Node 20+; the ES2022 lib does not type it). */
function isWellFormed(s: string): boolean {
  return (s as unknown as { isWellFormed(): boolean }).isWellFormed();
}

function assertChainSafeText(s: string, where: string): void {
  if (s.includes("\u0000")) {
    throw new TypeError(`security audit: U+0000 in ${where} (Postgres text and jsonb refuse it)`);
  }
  if (!isWellFormed(s)) {
    throw new TypeError(`security audit: lone UTF-16 surrogate in ${where} (not storable text)`);
  }
}

/** How deep refs may nest below the top-level object (Prisma's Json write gives up near 127). */
export const MAX_SECURITY_REFS_DEPTH = 32;

/**
 * Validate refs for the chain and return a plain deep copy.
 *
 * Throws a TypeError naming the path on anything the chain would not sign
 * and store identically: a Date signs as `{}` (and then reads back as a
 * string, so audit-verify fails FOREVER on that row), a BigInt makes the
 * insert throw, `undefined` (or an array hole) silently disappears from the
 * signed content, and functions, symbols, Maps/Sets/class instances and
 * cycles have no faithful JSON at all. Callers pass ids as strings and
 * instants as `.toISOString()`.
 *
 * Numbers: SAFE INTEGERS ONLY (`Number.isSafeInteger`). Security numbers are
 * minutes, versions and counts. JSON itself would round-trip any finite
 * double, but the chain does not: Prisma's Json WRITE keeps 16 significant
 * digits, so a double whose shortest form needs 17 (`0.1 + 0.2`,
 * `1.7976931348623157e308`) is stored as a different number — or as null —
 * while the signer signed the original, and audit-verify fails on that row
 * forever (measured on pg16 + Prisma 5.22: 689 of 3000 random 17-digit
 * doubles altered; safe integers exact). Fractions, and integers past 2^53,
 * go as strings. `-0` is normalised to `0` rather than refused: JSON has no
 * negative zero (it signs and stores as `0` either way), and the copy says so
 * explicitly instead of relying on that.
 *
 * Nesting deeper than MAX_SECURITY_REFS_DEPTH is refused too: past about 127
 * levels Prisma's Json write fails inside the transaction (a 503 for what is
 * a programming error), and a deep enough value overflows the stack.
 *
 * Also refused, at every depth:
 *   · an own `__proto__` key (JSON.parse — so express.json() — makes one from
 *     any request body). Assigned into a `{}` copy it would call the
 *     prototype SETTER: the signer (own keys only) would sign without it
 *     while Prisma (which serialises inherited enumerable properties) stored
 *     it, and audit-verify would fail on that row forever. The key is
 *     checked BEFORE anything is assigned, so the copy is only ever built
 *     from plain own data properties.
 *   · a key or string value that `chainSafeText` refuses — it would fail the
 *     insert, turning bad input into a 503 instead of a 400.
 */
export function securityRefs(obj: Record<string, unknown>): { [key: string]: SecurityRefValue } {
  const seen = new Set<object>();
  const walk = (v: unknown, path: string, depth: number): SecurityRefValue => {
    if (v === null) return null;
    switch (typeof v) {
      case "string":
        assertChainSafeText(v, `refs at ${path}`);
        return v;
      case "boolean":
        return v;
      case "number":
        if (!Number.isFinite(v)) throw new TypeError(`security audit refs: non-finite number at ${path}`);
        if (!Number.isSafeInteger(v)) {
          throw new TypeError(
            `security audit refs: ${v} at ${path} is not a safe integer (the stored Json keeps 16 significant digits; pass fractions and big numbers as strings)`,
          );
        }
        // -0 → 0: JSON has no negative zero; make the copy say what is signed and stored.
        return v === 0 ? 0 : v;
      case "undefined":
        throw new TypeError(`security audit refs: undefined at ${path} (omit the key or use null)`);
      case "bigint":
        throw new TypeError(`security audit refs: BigInt at ${path} (pass it as a string)`);
      case "function":
      case "symbol":
        throw new TypeError(`security audit refs: ${typeof v} at ${path}`);
    }
    if (v instanceof Date) throw new TypeError(`security audit refs: Date at ${path} (pass .toISOString())`);
    const o = v as object;
    if (seen.has(o)) throw new TypeError(`security audit refs: cycle at ${path}`);
    if (depth > MAX_SECURITY_REFS_DEPTH) {
      throw new TypeError(`security audit refs: nesting deeper than ${MAX_SECURITY_REFS_DEPTH} at ${path}`);
    }
    if (Array.isArray(o)) {
      seen.add(o);
      // Array.from, not map: a hole becomes `undefined` and is refused.
      const out = Array.from(o as unknown[], (x, i) => walk(x, `${path}[${i}]`, depth + 1));
      seen.delete(o);
      return out;
    }
    const proto = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`security audit refs: non-plain object at ${path}`);
    }
    seen.add(o);
    const out: { [key: string]: SecurityRefValue } = {};
    for (const [k, x] of Object.entries(o)) {
      const at = path === "" ? k : `${path}.${k}`;
      // BEFORE the assignment below — `out["__proto__"] = …` would re-parent the copy.
      if (k === "__proto__") throw new TypeError(`security audit refs: __proto__ key at ${at}`);
      assertChainSafeText(k, `a refs key at ${at}`);
      out[k] = walk(x, at, depth + 1);
    }
    seen.delete(o);
    return out;
  };
  return walk(obj, "", 0) as { [key: string]: SecurityRefValue };
}

function refsFor(entry: SecurityAuditEntry): { [key: string]: SecurityRefValue } {
  return securityRefs({ ...(entry.refs ?? {}), surface: "security", action: entry.action });
}

/** The row every Security audit writes. Throws (TypeError / Error) on bad input, before any I/O. */
function securityAuditParams(entry: SecurityAuditEntry, actor: ActivityActor): RecordParams {
  assertChainSafeText(entry.what, "what");
  const sub = entry.sub ?? null;
  if (sub !== null) assertChainSafeText(sub, "sub");
  const params: RecordParams = {
    kind: "system",
    severity: "info",
    sourceIcon: "shield",
    what: entry.what,
    sub,
    refs: refsFor(entry),
    actor,
  };
  validateRecordParams(params);
  return params;
}

/**
 * Audit a human change in the caller's transaction.
 *
 *   · The caller's transaction MUST be opened READ COMMITTED, and
 *     `tx` must be the interactive-transaction client Prisma handed the
 *     callback (never a wrapper around it) — anything else is refused with
 *     ActivityChainPreconditionError (rethrown as is: a 500).
 *   · Call it LAST, only after the change's CAS reported count 1 — never on
 *     `changed:false`, a 409 or a lost CAS. It takes the box-wide chain lock,
 *     held until commit: run every CAS / row-locking write FIRST, then the
 *     audits (`Promise.all` over the audits only, or one at a time) — never a
 *     CAS after any audit in the same callback (it inverts the lock order and
 *     deadlocks, 40P01). NOTHING may run in the callback after the audits (no
 *     global-client audit: it self-deadlocks on that lock).
 *   · Several calls on the same `tx` — `Promise.all` over the audits of a bulk
 *     change — are serialised in-process, in call order, and chain linearly
 *     (the advisory lock alone cannot: it is re-entrant within the one
 *     connection). Await every one of them inside the callback and let the
 *     rejections propagate (`Promise.all` or sequential awaits, never
 *     `Promise.allSettled`): a rejection that reached the database has
 *     aborted the whole Postgres transaction. That serialisation covers in-tx
 *     appends only; a global-client audit must still never be interleaved
 *     with them.
 *   · Input problems — the actor (e.g. a blank user id), `what`/`sub`, refs —
 *     are checked BEFORE the append and throw as they are (a programming
 *     error, a 500). Only a failure of the append itself becomes
 *     `SecurityAuditUnavailableError`, which rolls the transaction back.
 *   · Latency is bounded by whoever HOLDS the chain lock, not by the
 *     transaction `timeout`: a waiter's transaction expires on time, but its
 *     lock statement returns (and the error surfaces, P2028 as the cause)
 *     only when the holder commits. Either way the change has rolled back —
 *     `isSecurityAuditUnavailable` → 503.
 */
export async function auditSecurityInTx(
  tx: ActivityAppendTx,
  req: { user?: { id: string; role?: string } | undefined },
  entry: SecurityAuditEntry,
): Promise<RecordedActivityRow> {
  const params = securityAuditParams(entry, actorFromRequest(req));
  try {
    return await recordActivityInTx(tx, params);
  } catch (err) {
    if (err instanceof ActivityChainPreconditionError) throw err;
    throw new SecurityAuditUnavailableError(err);
  }
}

/**
 * Audit a system change after its commit, for the cron legs (the mode
 * ticker's `mode.expire`). THROWS when the recorder is not initialised or the
 * append fails, so `safeRun` logs it with its consecutive-failure canary —
 * never `recordActivity`'s swallow. Never call it from inside a transaction
 * callback that has appended in-tx (it waits on the chain lock that
 * transaction holds).
 */
export async function auditSecuritySystem(entry: SecurityAuditEntry): Promise<RecordedActivityRow> {
  const params = securityAuditParams(entry, { type: "system", id: null });
  const recorder = getActivityRecorder();
  if (!recorder) throw new Error("activity recorder not initialised — the security audit row was not written");
  return recorder.record(params);
}
