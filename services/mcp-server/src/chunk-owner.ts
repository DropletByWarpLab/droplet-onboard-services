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
import { deptCorpusKeys, visibleDepartmentsFor } from "@droplet/tools-core";

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
 * the pre-WARP-1014 single-shape scope, and NO department corpora: an
 * unresolvable caller must never widen into shared content.
 *
 * 🔴 WARP-2821 — SHARED AND DEPARTMENT CORPORA. Until this ticket the
 * result was the caller's own two key shapes and nothing else, while the
 * file-indexer writes every groupfolder document under a sentinel owner
 * (`__household__`, or `__dept_<uuid>__` since WARP-1264). So the Files
 * page listed a shared document and the assistant could not see it:
 * `search_content` silently returned fewer hits and `read_document_text`
 * answered NOT_INDEXED for a file the user was looking at. For a business
 * the shared drive IS the corpus, so that was most of it.
 *
 * The visibility rule is `visibleDepartmentsFor` in `@droplet/tools-core`,
 * CALLED here rather than copied — the same function the orchestrator's Files
 * search route runs. Owner/admin see every ACTIVE department, everyone else
 * sees the ones they are a member of, and the HOUSEHOLD department is
 * dual-sentinelled so content indexed by either watcher generation stays
 * readable without a reindex.
 *
 * The first fix duplicated that rule here and guarded it with a test asserting
 * both files held the same literal strings. That guard could not have caught a
 * third privileged role: every string it checked would be unchanged while the
 * two resolvers diverged again. One implementation cannot drift from itself.
 *
 * FAILS CLOSED. Any error in the department lookup returns the personal
 * keys alone. Narrowing this list can only hide content; widening it on a
 * half-answered query would disclose it. The Files route makes the same
 * call for the same reason ("best-effort by design … personal only").
 */
export async function resolveChunkOwnerIds(
  prisma: PrismaClient,
  userId: string,
): Promise<string[]> {
  const row = UUID_SHAPE.test(userId)
    ? await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, role: true },
      })
    : await prisma.user.findUnique({
        where: { username: userId },
        select: { id: true, username: true, role: true },
      });
  if (!row) return [userId];

  const keys = [userId, row.username, row.id];

  try {
    keys.push(...deptCorpusKeys(await visibleDepartmentsFor(prisma, row)));
  } catch {
    // Personal only. See the fail-closed note above. `visibleDepartmentsFor`
    // THROWS on a database failure rather than answering "no departments",
    // precisely so this decision is made here and not inside it.
  }

  return [...new Set(keys)];
}
