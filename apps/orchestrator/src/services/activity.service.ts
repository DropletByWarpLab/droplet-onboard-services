/**
 * WARP-456 — Atomic emitter for the signed activity log.
 *
 * `record({kind, severity, sourceIcon, what, sub?, refs?})` is the
 * single writer to `ActivityRow`. Every other surface (chat, MCP tool
 * dispatch, file indexer MQTT bridge, Matter writes, auth events,
 * network ops) calls into here — direct `ActivityRow` inserts outside
 * this module are a bug per AC3.
 *
 * Chain integrity is enforced inside a Prisma `$transaction`:
 *   1. Take the constant transaction-scoped advisory lock
 *      `pg_advisory_xact_lock(hashtext('droplet:activity-chain-append'))`
 *      so concurrent emitters fully serialize (WARP-1026 — a tail-row
 *      `FOR UPDATE` does NOT serialize appends under READ COMMITTED and
 *      forked the chain).
 *   2. Read the current tail row's signature.
 *   3. Compute the new row's signature with the injected signer.
 *   4. INSERT the new row, `refs` bound as the exact canonical text the
 *      signer signed (WARP-3011). The lock releases at COMMIT/ROLLBACK.
 *
 * The signer is injected so tests can use a fixed key and production
 * pulls from `/data/secrets/audit.key` via `getDefaultSigner()`.
 */
import type { PrismaClient } from "@prisma/client";
import {
  canonicalRefsJson,
  hashSignature,
  type ActivityActorTypeName,
  type ActivityKindName,
  type ActivityRowContent,
  type ActivityRowSigner,
  type ActivitySeverityName,
} from "./audit-signing.service.js";
import { createLogger } from "../lib/logger.js";

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
 * WARP-3011: the append's INSERT — raw SQL, never `tx.activityRow.create`.
 *
 * Prisma 5.22's Json WRITE keeps 16 significant digits, so a refs number
 * whose shortest form needs 17 was stored as a different value while the
 * signature covers the original, and verification failed on that row (and
 * so on the whole chain after it) forever. That is not only `0.1 + 0.2`:
 * an openWakeWord float32 score widened to a double needs 17 digits about
 * one time in four, and routes/voice.ts puts it in refs. `$7` is the
 * canonical refs text the signer signed (`canonicalRefsJson`), so the
 * column holds exactly that: jsonb keeps numbers as exact decimals and
 * Prisma's read path is exact (activity.service.pg.test.ts pins both).
 *
 * `$1` is ISO-8601 text: casting text to `timestamp(3)` ignores the `Z`,
 * which stores the UTC wall-clock time Prisma's own DateTime writes store,
 * with no dependence on the session TimeZone.
 */
const INSERT_ACTIVITY_ROW_SQL =
  'INSERT INTO "ActivityRow" ("at", "severity", "sourceIcon", "what", "sub", "kind", "refs", "signature", "prevSignatureHash", "actorType", "actorId", "schemaVersion") ' +
  'VALUES ($1::timestamp(3), $2::"ActivitySeverity", $3::text, $4::text, $5::text, $6::"ActivityKind", $7::jsonb, $8::text, $9::text, $10::"ActivityActorType", $11::text, $12::integer) ' +
  'RETURNING "id"';

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
 * Build a recorder bound to a Prisma client + signer. One instance per
 * orchestrator process; multiple call sites share it.
 */
export function createActivityRecorder(
  deps: ActivityRecorderDeps,
): ActivityRowRecorder {
  return {
    async record(params) {
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
      const inserted = await deps.prisma.$transaction(async (tx) => {
        // `pg_advisory_xact_lock` returns `void`, which Prisma's raw-query
        // deserializer rejects (P2010, "cannot deserialize column of type
        // void"). Wrapping in `IS NULL` yields a real boolean column and
        // is a no-op on the locking behaviour; the recorder ignores the
        // returned value.
        await tx.$queryRawUnsafe(
          "SELECT (pg_advisory_xact_lock(hashtext('droplet:activity-chain-append')) IS NULL) AS locked",
        );
        const prevRows = await tx.$queryRawUnsafe<
          Array<{ signature: string }>
        >('SELECT "signature" FROM "ActivityRow" ORDER BY "id" DESC LIMIT 1');
        const prevSig = prevRows[0]?.signature ?? "";
        const prevSignatureHash = prevSig === "" ? "" : hashSignature(prevSig);
        const signature = deps.signer.sign(content, prevSignatureHash);

        // WARP-3011: see INSERT_ACTIVITY_ROW_SQL. Absent refs stay SQL NULL
        // (a null `$7`), never the JSON value `null`.
        const refsJson = canonicalRefsJson(content.refs);
        const insertedRows = await tx.$queryRawUnsafe<Array<{ id: bigint }>>(
          INSERT_ACTIVITY_ROW_SQL,
          at.toISOString(),
          content.severity,
          content.sourceIcon,
          content.what,
          content.sub,
          content.kind,
          refsJson,
          signature,
          prevSignatureHash,
          content.actorType,
          content.actorId,
          content.schemaVersion,
        );
        const id = insertedRows[0]?.id;
        if (typeof id !== "bigint") {
          throw new Error("ActivityRow INSERT returned no id");
        }
        return { id, signature, prevSignatureHash, refsJson };
      });

      return {
        id: inserted.id,
        at,
        severity: content.severity,
        sourceIcon: content.sourceIcon,
        what: content.what,
        sub: content.sub,
        kind: content.kind,
        // The refs the column now holds: the signed text, parsed.
        refs:
          inserted.refsJson === null
            ? null
            : (JSON.parse(inserted.refsJson) as Record<string, unknown>),
        signature: inserted.signature,
        prevSignatureHash: inserted.prevSignatureHash,
        actorType: content.actorType,
        actorId: content.actorId,
        schemaVersion: content.schemaVersion,
      };
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
