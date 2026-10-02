/**
 * Process-wide activity recorder singleton for WARP-456.
 *
 * Emitter call sites (chat route, MCP dispatch, file-indexer MQTT
 * bridge, Matter writes, auth events, network ops) import
 * `recordActivity()` from here and stay decoupled from the recorder's
 * construction. The signer + Prisma client are wired once at app
 * boot via `initActivityRecorder(prisma)`; before that call,
 * `recordActivity` is a no-op that returns null, so import order in
 * tests doesn't matter.
 *
 * Mirrors the `mcp-client.singleton.ts` shape so the orchestrator's
 * shutdown path can teardown both via the same pattern.
 */
import type { PrismaClient } from "@prisma/client";
import {
  appendActivityRowInTx,
  createActivityRecorder,
  recordSafely,
  type ActivityAppendTx,
  type ActivityRowRecorder,
  type RecordedActivityRow,
  type RecordParams,
} from "./activity.service.js";
import {
  auditKeyId,
  createHmacSigner,
  loadAuditKeyFromDisk,
  loadRetiredAuditKeys,
  type ActivityRowSigner,
  type AuditKeyEpoch,
} from "./audit-signing.service.js";

let recorder: ActivityRowRecorder | null = null;
let signer: ActivityRowSigner | null = null;

// WARP-3165: the current key sits behind `signer`, a stable delegating
// object, so a rotation swaps what every holder (the recorder, in-tx
// appends, the verify routes) signs with, in one assignment. Signing runs
// under the chain-append lock, so rows are signed in chain order and the
// chain carries exactly one switch point: every row before it signed by the
// old key, every row after by the new one (the epoch rule verifies that).
let current: AuditKeyEpoch | null = null;
let retired: AuditKeyEpoch[] = [];

function delegatingSigner(): ActivityRowSigner {
  return {
    sign: (content, prev) => current!.signer.sign(content, prev),
    verify: (content, prev, sig) => current!.signer.verify(content, prev, sig),
  };
}

function epochFor(key: Buffer): AuditKeyEpoch {
  return { keyId: auditKeyId(key), signer: createHmacSigner(key) };
}

/**
 * Initialise the singleton at boot. Throws if the signing key can't be
 * loaded — by design, an orchestrator that can't sign the audit chain
 * must fail closed rather than emit unsigned rows.
 *
 * Idempotent: subsequent calls are no-ops so a test that wires the
 * recorder once doesn't have to teardown between cases.
 */
export function initActivityRecorder(prisma: PrismaClient): void {
  if (recorder) return;
  current = epochFor(loadAuditKeyFromDisk());
  retired = loadRetiredAuditKeys().filter((k) => k.keyId !== current!.keyId);
  signer = delegatingSigner();
  recorder = createActivityRecorder({ prisma, signer });
}

/**
 * Emit a row. Swallows recorder failures with a logged warning — the
 * caller MUST NOT depend on the row landing for its own control flow.
 *
 * Returns the inserted row on success or `null` on failure / before
 * `initActivityRecorder` ran.
 */
export async function recordActivity(
  params: RecordParams,
): Promise<RecordedActivityRow | null> {
  if (!recorder) return null;
  return recordSafely(recorder, params);
}

/**
 * Append a row INSIDE the caller's transaction (WARP-2977 P2b), so a change
 * and its audit row commit or roll back together. Unlike `recordActivity`
 * this THROWS — when the recorder has not been initialised as well as when
 * the append fails — because its callers are human changes that must never
 * commit unaudited: the throw rolls the caller's transaction back.
 *
 * The caller's transaction MUST be opened READ COMMITTED (lib/prisma-tx.ts's
 * read-committed constant) — never serializable or repeatable read — and `tx`
 * must be the interactive-transaction client Prisma handed the callback,
 * never the bare one nor a wrapper built around it (it carries the
 * transaction id the append queue is keyed on); all are refused with
 * ActivityChainPreconditionError (see `appendActivityRowInTx`).
 *
 * Takes the chain-append advisory lock, held until the caller COMMITS. Run
 * every CAS / row-locking write FIRST, then the audits (`Promise.all` over the
 * audits only, or one at a time) — never a CAS after any audit in the same
 * callback: it inverts the lock order against every other audited writer and
 * Postgres answers with a deadlock. After the audits, NOTHING else may run in
 * the callback — above all no global-client audit (`recordActivity`,
 * `getActivityRecorder().record`, `auditSecuritySystem`): that waits on this
 * same lock from another connection until the transaction times out, and the
 * change is lost.
 *
 * Several appends on the same transaction (a `Promise.all`) are serialised
 * in-process, in call order, and chain linearly. A rejection that did not
 * reach the database (a signer failure, a precondition) does not block the
 * next; one that DID (a failed statement) aborts the whole Postgres
 * transaction, and every later statement on it fails. So the rejections must
 * propagate out of the callback — `Promise.all` or sequential awaits, never
 * `Promise.allSettled`, which would let `$transaction` resolve while Postgres
 * rolled everything back. The serialisation covers in-tx appends only — a
 * global-client audit must still never be interleaved with them.
 */
export async function recordActivityInTx(
  tx: ActivityAppendTx,
  params: RecordParams,
): Promise<RecordedActivityRow> {
  if (!recorder || !signer) {
    throw new Error("activity recorder not initialised — refusing to commit an unaudited change");
  }
  return appendActivityRowInTx(tx, signer, params);
}

/**
 * Read the bound signer. Used by `POST /api/activity/export` so the
 * sealed bundle ships the same public bytes the live chain was signed
 * with.
 */
export function getActivitySigner(): ActivityRowSigner | null {
  return signer;
}

/**
 * Read the bound recorder itself (WARP-2218).
 *
 * `recordActivity` above wraps every emit in `recordSafely`, which swallows a
 * recorder failure so the CALLER's flow is never blocked by the audit table.
 * That is right for a chat turn — losing one audit row beats failing the
 * reply — and wrong for a background cron leg, where there is no user-facing
 * flow to protect and a silently-dropped row is simply an unaudited vendor
 * call. A cron handler wants the throw: `cron-runtime.service.ts`'s `safeRun`
 * turns it into a logged failure with the consecutive-failure canary attached,
 * which is what downstream alerting reads.
 *
 * Null before `initActivityRecorder` has run, exactly like `getActivitySigner`.
 */
export function getActivityRecorder(): ActivityRowRecorder | null {
  return recorder;
}

/**
 * WARP-3165: the whole keyring, OLDEST FIRST, the current key last. What
 * every verifier walks with (`createEpochVerifier`). Empty before init.
 */
export function getAuditKeyring(): AuditKeyEpoch[] {
  if (current) return [...retired, current];
  // A test that injected a bare signer: a one-key ring.
  return signer ? [{ keyId: "unknown", signer }] : [];
}

/** WARP-3165: the current key's id (never the key). Null before init. */
export function getCurrentAuditKeyId(): string | null {
  return current?.keyId ?? null;
}

/**
 * WARP-3165: make `newKey` the signing key and keep the old one for
 * verification only. The caller has already written `newKey` to disk and
 * archived the old key where `loadRetiredAuditKeys` finds it, so a restart
 * lands on the same keyring. Refuses a key that is already in the ring.
 */
export function adoptAuditKey(newKey: Buffer): { previousKeyId: string; newKeyId: string } {
  if (!current) throw new Error("activity recorder not initialised");
  const next = epochFor(newKey);
  if (next.keyId === current.keyId || retired.some((k) => k.keyId === next.keyId)) {
    throw new Error("the new audit key is already in the keyring; nothing was rotated");
  }
  const previous = current;
  retired = [...retired, previous];
  current = next;
  return { previousKeyId: previous.keyId, newKeyId: next.keyId };
}

/** Exposed only for tests. `keys` (raw bytes, oldest first, current last)
 *  wires a real keyring behind the delegating signer. */
export function _setActivityRecorderForTests(
  newRecorder: ActivityRowRecorder | null,
  newSigner: ActivityRowSigner | null,
): void {
  recorder = newRecorder;
  signer = newSigner;
  current = null;
  retired = [];
}

/** Exposed only for tests: init against explicit key bytes instead of disk. */
export function _initActivityRecorderWithKeysForTests(
  prisma: PrismaClient,
  keys: Buffer[],
): ActivityRowSigner {
  retired = keys.slice(0, -1).map(epochFor);
  current = epochFor(keys[keys.length - 1]!);
  signer = delegatingSigner();
  recorder = createActivityRecorder({ prisma, signer });
  return signer;
}
