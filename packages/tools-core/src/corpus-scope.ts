/**
 * Corpus scope — which `FileContentChunk.userId` owners a caller may read
 * (WARP-2821).
 *
 * WHY THIS LIVES IN tools-core. The file-indexer writes every groupfolder
 * document under a SENTINEL owner rather than a person — `__household__`, or
 * `__dept_<uuid>__` since WARP-1264 — so "which corpora may this caller
 * search" is a rule, and it is asked in two processes: the orchestrator's
 * `/files/search/content` route, and the mcp-server's `resolveChunkOwnerIds`
 * behind `search_content` / `read_document_text`.
 *
 * It used to be answered TWICE, and the two answers disagreed. The mcp-server's
 * copy never emitted a sentinel at all, so every shared and department document
 * was listed by the Files page and invisible to the assistant. That defect was
 * not a wrong line; it was two implementations of one rule that nobody compared.
 *
 * The first fix duplicated the orchestrator's rule into the mcp-server and
 * guarded it with a test asserting both files contained the same literal
 * strings. Romain's review named the hole in that: the sentinel FORMATS
 * genuinely cannot be shared (the indexer is Python), but the visibility rule
 * is plain TypeScript over Prisma, and both processes already depend on this
 * package. A third privileged role added to one side would leave every string
 * the guard checked unchanged and the resolvers silently divergent — reopening
 * exactly the defect. So the rule is here, called from both, and there is
 * nothing left to keep in sync.
 *
 * THE RULE IS DELIBERATELY NOT WIDER THAN THE FILES PAGE. The assistant must
 * read what the caller can open, and not a document more.
 */
import type { PrismaClient } from "@prisma/client";

/**
 * The legacy household sentinel. Must match the file-indexer's
 * `HOUSEHOLD_USER_ID` (`services/file-indexer/config.py`) — that side is
 * Python and cannot import this.
 */
export const HOUSEHOLD_INDEX_USER = "__household__";

/**
 * One department's corpus sentinel. Must match `watcher.py`'s
 * `f"__dept_{dept['id']}__"` exactly: a mismatch is silent, and reads as "the
 * department has no documents" rather than as an error.
 */
export function deptSentinel(departmentId: string): string {
  return `__dept_${departmentId}__`;
}

/** A department this caller can see, with the field the search cache key folds in. */
export interface VisibleDept {
  id: string;
  kind: string;
  aclVersion: number;
}

/** The caller, already resolved to a local identity. `id` is the local
 *  `User.id` UUID — never a Nextcloud username and never a service-principal
 *  string; a caller resolving a service-asserted user must swap it in first. */
export interface CorpusCaller {
  id: string;
  role: string;
}

/**
 * The ACTIVE departments this caller is visible into.
 *
 * Owner/admin see ALL active departments — the audited "see-all" posture
 * `checkSpaceAccess` takes. Everyone else sees only the ones they are a member
 * of, and only while the department is active.
 *
 * THROWS on a database failure rather than returning an empty list, because
 * the two callers want different things from that case and neither should have
 * the choice made for it here: the Files route degrades to personal-only with
 * `resolved: false` so a stale cache key cannot be minted, and the mcp-server
 * falls back to the caller's own keys. Swallowing the error here would hand
 * both of them "this caller is in no departments", which is indistinguishable
 * from a real answer.
 */
export async function visibleDepartmentsFor(
  prisma: PrismaClient,
  caller: CorpusCaller,
): Promise<VisibleDept[]> {
  const privileged = caller.role === "owner" || caller.role === "admin";
  if (privileged) {
    return prisma.department.findMany({
      where: { state: "active" },
      select: { id: true, kind: true, aclVersion: true },
    });
  }
  const memberships = await prisma.departmentMembership.findMany({
    where: { userId: caller.id, department: { state: "active" } },
    select: { department: { select: { id: true, kind: true, aclVersion: true } } },
  });
  return memberships.map((m) => m.department);
}

/**
 * The sentinel owner keys for a set of visible departments.
 *
 * The HOUSEHOLD department is DUAL-SENTINELLED: old watcher builds wrote
 * `__household__` and WARP-1264 builds write the uuid form, neither is
 * reindexed, and emitting only one hides half the shared drive with no error.
 */
export function deptCorpusKeys(depts: readonly VisibleDept[]): string[] {
  const keys: string[] = [];
  for (const dept of depts) {
    if (dept.kind === "HOUSEHOLD") keys.push(HOUSEHOLD_INDEX_USER);
    keys.push(deptSentinel(dept.id));
  }
  return keys;
}

/** max(`aclVersion`) across the caller's visible departments; 0 when none.
 *  Folded into the Files search cache key so a rights change busts it. */
export function maxAclVersion(depts: readonly VisibleDept[]): number {
  let max = 0;
  for (const dept of depts) if (dept.aclVersion > max) max = dept.aclVersion;
  return max;
}
