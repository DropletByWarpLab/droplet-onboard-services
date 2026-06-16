/**
 * WARP-287 — file-reindex service.
 *
 * Forces re-extraction of a single file end-to-end. Used to upgrade
 * legacy chunks (no `metadata.anchor`) to anchored ones without paying
 * for a global backfill, and to recover individual rows when an
 * extractor has been fixed since the original index pass.
 *
 * Concurrency: a per-file Postgres advisory lock prevents two reindex
 * requests from racing on the same row. The lock is acquired inside a
 * Prisma `$transaction` block via `pg_try_advisory_xact_lock(bigint)` so
 * it auto-releases on commit / rollback — no lifetime tracking on our
 * side. When the lock is held, the call throws an `INDEX_IN_PROGRESS`
 * error which the route surfaces as a 409.
 *
 * The actual re-extract + chunk + embed + DELETE-then-INSERT lives in
 * the file-indexer's `/reindex/:fileId` endpoint. This service is the
 * orchestrator-side gate; it never touches FileContentChunk directly.
 * The advisory lock guards the orchestrator-side critical section
 * (request fanout); the file-indexer's own transaction guards the
 * atomic chunk replacement.
 *
 * Prisma dependency: the orchestrator's PrismaClient is created in
 * `index.ts` and threaded through the app via `createApp(prisma)`. There
 * is no module-level singleton. `setPrismaForReindex` lets the bootstrap
 * inject the client once; service tests mock `reindexFile` directly via
 * `vi.mock`, so they don't need to wire prisma.
 */
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";

export interface ReindexFileParams {
  /** Opaque file identifier (Nextcloud fileId or BrainMemoryItem id). */
  fileId: string;
  /** Authenticated user id of the operator (for audit logging). */
  actor: string;
}

export interface ReindexResult {
  chunksWritten: number;
}

/** Marker code thrown when the per-file advisory lock is held. */
export const INDEX_IN_PROGRESS = "INDEX_IN_PROGRESS";

let _prisma: PrismaClient | null = null;

/**
 * Bootstrap-time injection. Called once from `createApp(prisma)` so the
 * service has a handle without making prisma a per-call argument (the
 * admin route signature stays clean and the unit tests can mock the
 * whole service without standing up prisma).
 */
export function setPrismaForReindex(client: PrismaClient): void {
  _prisma = client;
}

/**
 * Re-extract a single file and replace its chunks atomically.
 *
 * Throws `Error & { code: "INDEX_IN_PROGRESS" }` when another reindex
 * is in flight for the same fileId; the route surfaces that as a 409.
 * Any other thrown Error bubbles up as a 500.
 */
export async function reindexFile(
  params: ReindexFileParams,
): Promise<ReindexResult> {
  const { fileId } = params;
  if (!_prisma) {
    throw new Error("reindexFile: prisma not initialised — call setPrismaForReindex() at boot");
  }
  // Let `tx` infer as Prisma.TransactionClient (the interactive-tx
  // overload). Annotating it `PrismaClient` made TS reject the overload
  // (TransactionClient lacks $transaction/$connect/…) and fall back to
  // the batch-array overload, whose `any[]` return broke ReindexResult.
  return _prisma.$transaction(async (tx) => {
    const lockKey = hashFileId(fileId);
    const rows = (await (
      tx as unknown as {
        $queryRawUnsafe: (
          sql: string,
          ...params: unknown[]
        ) => Promise<Array<{ ok: boolean }>>;
      }
    ).$queryRawUnsafe(
      "SELECT pg_try_advisory_xact_lock($1) AS ok",
      lockKey,
    )) as Array<{ ok: boolean }>;
    const acquired = Array.isArray(rows) && rows[0]?.ok === true;
    if (!acquired) {
      const err: Error & { code?: string } = new Error(
        "advisory lock not acquired",
      );
      err.code = INDEX_IN_PROGRESS;
      throw err;
    }

    const result = await callFileIndexerReindex(fileId);
    return { chunksWritten: result.chunksWritten };
  });
}

/**
 * 64-bit FNV-1a of the file id, normalised into the signed int8 range
 * Postgres `pg_try_advisory_xact_lock(bigint)` accepts.
 *
 * No hashing library / crypto digest — FNV-1a is fast, dependency-free,
 * and (since the output is a lock key, not a secret) doesn't need
 * collision resistance. A collision just means two unrelated fileIds
 * serialise on the same advisory lock, which is harmless (the second
 * call gets INDEX_IN_PROGRESS and the client retries).
 */
export function hashFileId(fileId: string): bigint {
  const MASK = 0xffffffffffffffffn;
  const INT64_MAX = 0x7fffffffffffffffn;
  const INT64_MOD = 0x10000000000000000n;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < fileId.length; i++) {
    h ^= BigInt(fileId.charCodeAt(i));
    h = (h * 0x100000001b3n) & MASK;
  }
  return h > INT64_MAX ? h - INT64_MOD : h;
}

async function callFileIndexerReindex(
  fileId: string,
): Promise<{ chunksWritten: number }> {
  const base = config.FILE_INDEXER_URL;
  const url = `${base}/reindex/${encodeURIComponent(fileId)}`;
  const resp = await fetch(url, { method: "POST" });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`file-indexer returned ${resp.status}: ${body}`);
  }
  const json = (await resp.json()) as { chunksWritten?: unknown };
  const written =
    typeof json.chunksWritten === "number" ? json.chunksWritten : 0;
  return { chunksWritten: written };
}
