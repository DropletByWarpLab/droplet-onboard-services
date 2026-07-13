/**
 * WARP-1014 — dual-shape chunk-owner resolution for `search_content`.
 *
 * The WARP-493 cutover left `FileContentChunk.userId` deliberately split
 * by source: brain-sourced rows key on the local `User.id` UUID, while
 * nextcloud-watcher rows stay keyed by Nextcloud username
 * (`services/file-indexer/watcher.py` derives owners from filesystem
 * paths — by design, do not "fix"). The caller key reaching this process
 * is single-shape, and WHICH shape depends on the transport:
 *
 *   - stdio — `_meta.userId` = `req.user.username`, forwarded by the
 *     orchestrator (`routes/llm.ts` toolCallContext).
 *   - http  — `claims.sub` = the `User.id` UUID (WARP-485 JWTs).
 *
 * Either way, half the corpus would be invisible with a single-key
 * `WHERE "userId" = $1`. This is the query-site half of the WARP-1014
 * decision (Option 1, dual-shape reads; precedent: the ChatSession
 * transition note in the orchestrator's `routes/llm.ts`): resolve the
 * counterpart key via the User row and search with both. The rejected
 * alternative — unifying the watcher on UUIDs — would push an
 * auth-directory dependency into the indexer's path-derived bookkeeping
 * for no read-side gain.
 */
import type { PrismaClient } from "@prisma/client";

/**
 * UUID-shaped (8-4-4-4-12) test, version-agnostic. Mirrors the WARP-493
 * migrator's UUID_REGEX in
 * `apps/orchestrator/src/services/brain-memory.service.ts` (duplicated —
 * the mcp-server is a standalone process, same rationale as the
 * file-search.service mirror).
 */
const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve every `FileContentChunk.userId` key shape for one caller.
 *
 * Returns the incoming key first (so single-shape callers keep the
 * historical `$1` binding), then the counterpart from the User row,
 * deduplicated. The lookup is shape-routed onto ONE unique column
 * (UUID → `User.id`, otherwise `User.username`) — never a cross-column
 * OR, so one caller can never resolve into another user's key set.
 *
 * Unknown keys (service principals, the auth-disabled dev stub, rows
 * orphaned from the directory) return the incoming key alone — exactly
 * the pre-WARP-1014 single-shape scope.
 */
export async function resolveChunkOwnerIds(
  prisma: PrismaClient,
  userId: string,
): Promise<string[]> {
  const row = UUID_SHAPE.test(userId)
    ? await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true },
      })
    : await prisma.user.findUnique({
        where: { username: userId },
        select: { id: true, username: true },
      });
  if (!row) return [userId];
  return [...new Set([userId, row.username, row.id])];
}
