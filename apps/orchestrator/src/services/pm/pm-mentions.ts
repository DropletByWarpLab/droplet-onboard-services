/**
 * WARP-3519 (WS-2) — @mentions in comments.
 *
 * The contract, in the order things happen on a write:
 *
 *  1. The comment html is sanitized FIRST (sanitize-html.ts). The editor marks a
 *     mention as `<span data-mention-id="<User.id>">@Name</span>`; that is the
 *     only span the allowlist keeps.
 *  2. The mentioned ids are read back out of the SANITIZED html — never from a
 *     client-supplied list, so there is nothing for a client to forge — and are
 *     checked against who can READ the item (pm-readers.ts). A mention of
 *     somebody who cannot is dropped: its span is unwrapped to plain `@Name`
 *     text in the stored html, no row is written, nobody is notified.
 *  3. In the SAME transaction as the comment: one `PmCommentMention` row per
 *     mentioned person, one `mentioned` activity row per NEWLY mentioned person
 *     (the author is never told about themselves), and the mentioned are
 *     auto-watched. The `mentioned` activity row IS the notification queue
 *     entry — activity-notify.service.ts sweeps it like every other PM event;
 *     there is no second delivery path.
 *
 * `mentioned` activity rows are shaped like `assigned` ones (`newValue` = the
 * person) with the comment id in `oldValue`, so that deleting the comment, or
 * editing the mention out of it, can RETRACT the notification while it is still
 * pending (retract* below) instead of telling somebody about words that are
 * gone.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { extractMentionIds, sanitizePmHtml } from "./sanitize-html.js";
import { nudgeOutbox } from "./pm-outbox.js";
import { filterItemReaders } from "./pm-readers.js";
import { autoWatch } from "./pm-watchers.js";

type Db = PrismaClient | Prisma.TransactionClient;

/** A comment that names fifty people is a broadcast, not a mention. The cap is
 *  generous for a real thread and bounds the rows (and notifications) one
 *  write can produce. Mentions past it are unwrapped like any other dropped one. */
export const MAX_MENTIONS_PER_COMMENT = 20;

export interface ResolvedMentions {
  /** The html to STORE: sanitized, with every mention that was not kept unwrapped. */
  html: string;
  /** The people actually mentioned, in document order. */
  mentionIds: string[];
}

/**
 * Sanitize `rawHtml` and work out who is genuinely mentioned in it on
 * `workItemId`. One extra query (two when a guest is named) and only when the
 * html mentions somebody at all.
 */
export async function resolveCommentMentions(
  db: Db,
  workItemId: string,
  rawHtml: string,
): Promise<ResolvedMentions> {
  const sanitized = sanitizePmHtml(rawHtml);
  const found = extractMentionIds(sanitized);
  if (found.length === 0) return { html: sanitized, mentionIds: [] };

  const readers = await filterItemReaders(db, workItemId, found);
  const kept = found.filter((id) => readers.has(id)).slice(0, MAX_MENTIONS_PER_COMMENT);
  if (kept.length === found.length) return { html: sanitized, mentionIds: kept };
  return {
    html: sanitizePmHtml(sanitized, { allowedMentionIds: new Set(kept) }),
    mentionIds: kept,
  };
}

/** True when `html` has no text a person could read once tags and whitespace
 *  are gone (`<p></p>`, `<p><br></p>`, `<p>&nbsp;</p>`). A mention-only comment
 *  is NOT empty: its `@Name` is text. */
export function isEmptyCommentHtml(html: string): boolean {
  const text = html
    .replace(/<[^>]*(?:>|$)/g, "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .trim();
  return text.length === 0;
}

/**
 * Bring `commentId`'s `PmCommentMention` rows to exactly `mentionIds`, and do
 * what a NEW mention earns: a `mentioned` activity row (the notification) and
 * auto-watch. `previous` is the set already recorded — omit it for a brand-new
 * comment, pass the existing rows for an edit. Returns what changed.
 */
export async function recordMentions(
  tx: Db,
  input: {
    workItemId: string;
    commentId: string;
    actorId: string | null;
    mentionIds: readonly string[];
    previous?: readonly string[];
  },
): Promise<{ added: string[]; removed: string[] }> {
  const before = new Set(input.previous ?? []);
  const next = new Set(input.mentionIds);
  const added = [...next].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !next.has(id));

  if (removed.length > 0) {
    await tx.pmCommentMention.deleteMany({
      where: { commentId: input.commentId, userId: { in: removed } },
    });
    await retractMentionNotifications(tx, input.workItemId, input.commentId, removed);
  }
  if (added.length > 0) {
    await tx.pmCommentMention.createMany({
      data: added.map((userId) => ({ commentId: input.commentId, userId })),
      skipDuplicates: true,
    });
    // The author is never told about themselves — and an empty createMany is a
    // wasted statement inside a transaction that is already holding locks.
    const toTell = added.filter((userId) => userId !== input.actorId);
    if (toTell.length > 0) {
      await tx.pmActivity.createMany({
        data: toTell.map((userId) => ({
          workItemId: input.workItemId,
          actorId: input.actorId,
          verb: "mentioned" as const,
          field: "comment",
          oldValue: input.commentId,
          newValue: userId,
        })),
      });
      // The notification row shares the caller's transaction. Wake the single
      // outbox runtime only after commit through its deferred nudge seam.
      nudgeOutbox();
    }
    await autoWatch(
      tx,
      input.workItemId,
      added.map((userId) => ({ userId, reason: "MENTIONED" as const })),
    );
  }
  return { added, removed };
}

/** A person was un-mentioned by an edit: if their notification has not been
 *  swept yet it must not go out. Only `pending` rows move — a `sent` one is
 *  history. `not_needed` is the explicit terminal the sweep already uses, and
 *  it leaves `notifiedAt` NULL as the table's CHECK requires. */
export async function retractMentionNotifications(
  tx: Db,
  workItemId: string,
  commentId: string,
  userIds: readonly string[],
): Promise<void> {
  if (userIds.length === 0) return;
  await tx.pmActivity.updateMany({
    where: {
      workItemId,
      verb: "mentioned",
      oldValue: commentId,
      newValue: { in: [...userIds] },
      notifyStatus: "pending",
    },
    data: { notifyStatus: "not_needed" },
  });
}

/** The comment was deleted: nothing it caused may be announced any more — not
 *  its "new comment" (`commented`, `newValue` = comment id) and not any of its
 *  mentions. Still-pending rows only. */
export async function retractCommentNotifications(
  tx: Db,
  workItemId: string,
  commentId: string,
): Promise<void> {
  await tx.pmActivity.updateMany({
    where: {
      workItemId,
      notifyStatus: "pending",
      OR: [
        { verb: "commented", newValue: commentId },
        { verb: "mentioned", oldValue: commentId },
      ],
    },
    data: { notifyStatus: "not_needed" },
  });
}
