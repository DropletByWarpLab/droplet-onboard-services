/**
 * WARP-3519 (WS-2) — the automatic half of the watch list.
 *
 * Somebody is subscribed to a work item as a SIDE EFFECT of four things they did
 * to it: creating it, being assigned to it, commenting on it, being mentioned
 * in it. Each of those writers calls this inside its own transaction, so the
 * subscription commits or rolls back with the change that earned it.
 *
 * Idempotent by construction (`skipDuplicates` on the unique
 * `(workItemId, userId)`): an existing row keeps the reason it was first
 * written with, and re-doing any of the four is a no-op rather than an error.
 * It also REVIVES nobody — a person who unwatched is deleted, not muted, so
 * their next comment or mention simply subscribes them again, which is what a
 * direct interaction with an item should do.
 *
 * Auto-watching writes NO activity row: it is a consequence of an event that
 * already has its own (`created`, `assigned`, `commented`, `mentioned`), and a
 * "started watching" line for every first comment would drown the timeline.
 * Only an explicit watch/unwatch (the watchers API) is recorded.
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

export type PmWatchReasonName = "CREATOR" | "ASSIGNEE" | "COMMENTER" | "MENTIONED" | "MANUAL";

export interface WatchEntry {
  /** null / undefined is skipped — an AI- or system-authored change has no
   *  person to subscribe. */
  userId: string | null | undefined;
  reason: PmWatchReasonName;
}

export async function autoWatch(
  db: Db,
  workItemId: string,
  entries: readonly WatchEntry[],
): Promise<void> {
  const seen = new Set<string>();
  const data: Array<{ workItemId: string; userId: string; reason: PmWatchReasonName }> = [];
  for (const e of entries) {
    // First entry for a person wins (the caller orders them by precedence:
    // a creator who is also an assignee is recorded as the creator).
    if (!e.userId || seen.has(e.userId)) continue;
    seen.add(e.userId);
    data.push({ workItemId, userId: e.userId, reason: e.reason });
  }
  if (data.length === 0) return;
  await db.pmWorkItemWatcher.createMany({ data, skipDuplicates: true });
}
