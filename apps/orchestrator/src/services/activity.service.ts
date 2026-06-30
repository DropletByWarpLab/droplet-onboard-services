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
 *   1. SELECT the most recent row's signature with FOR UPDATE so
 *      concurrent emitters serialize at the database boundary
 *      (otherwise two writers could both observe the same prev and
 *      produce a fork in the chain — AC7's tamper test would catch
 *      this on replay).
 *   2. Compute the new row's signature with the injected signer.
 *   3. INSERT the new row.
 *
 * The signer is injected so tests can use a fixed key and production
 * pulls from `/data/secrets/audit.key` via `getDefaultSigner()`.
 */
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import {
  hashSignature,
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
]);

const KNOWN_SEVERITIES: ReadonlySet<ActivitySeverityName> =
  new Set<ActivitySeverityName>(["ok", "warn", "err", "info"]);

export interface RecordParams {
  kind: ActivityKindName;
  severity: ActivitySeverityName;
  sourceIcon: string;
  what: string;
  sub?: string | null;
  refs?: Record<string, unknown> | null;
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

      const at = params.at ?? new Date();
      const content: ActivityRowContent = {
        at,
        severity: params.severity,
        sourceIcon: params.sourceIcon,
        what: params.what,
        sub: params.sub ?? null,
        kind: params.kind,
        refs: params.refs ?? null,
      };

      // Atomic SELECT-prev + INSERT. The Prisma transaction maps to a
      // single Postgres BEGIN/COMMIT; the FOR UPDATE on the existing
      // tail row ensures two concurrent calls serialize at the
      // database level. Without it, both could read the same `latest`
      // and produce two rows with the same prevSignatureHash — a
      // chain fork the verifier would flag.
      const inserted = await deps.prisma.$transaction(async (tx) => {
        // Lock the latest row (if any) so concurrent emitters wait
        // here. Using $queryRaw because Prisma's `findFirst` doesn't
        // expose row-level locking. Falls back to no lock when the
        // table is empty (no row exists to take the lock on; the
        // INSERT below races on the index, which is fine for a single
        // genesis row).
        //
        // `Prisma.sql` is used inline so the table name isn't
        // interpolated as user data — keeps the query plan-cached.
        const prevRows = await tx.$queryRawUnsafe<
          Array<{ signature: string }>
        >(
          // eslint-disable-next-line no-secrets/no-secrets
          'SELECT "signature" FROM "ActivityRow" ORDER BY "id" DESC LIMIT 1 FOR UPDATE',
        );
        const prevSig = prevRows[0]?.signature ?? "";
        const prevSignatureHash = prevSig === "" ? "" : hashSignature(prevSig);
        const signature = deps.signer.sign(content, prevSignatureHash);

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
        };
        const created = await tx.activityRow.create({ data });
        return created;
      });

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

// Prisma's namespace is imported at the top of the file (alongside the
// type-only PrismaClient) for runtime use of `Prisma.DbNull`. Tests that
// mock `@prisma/client` need to expose `Prisma.DbNull` in their stub.
export type { Prisma };
