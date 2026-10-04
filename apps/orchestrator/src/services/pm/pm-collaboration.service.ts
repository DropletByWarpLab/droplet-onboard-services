/**
 * WARP-3519 (ADR-069 WS-2) — collaboration on a work item: editing and deleting
 * comments, reactions, the watch list, and the merged activity timeline.
 *
 * Same conventions as pm.service.ts, which this sits beside and imports from:
 * errors are `Error(code)` with a stable string the route maps to HTTP, every
 * mutation writes its `PmActivity` row inside the SAME transaction as the
 * change, and lists are one query plus batched lookups — never a query per row.
 *
 * What lives elsewhere, and why it is not here:
 *   - `addComment`, `listComments` and the comment wire shape stay in
 *     pm.service.ts (the dashboard, the mobile contract and the tools all reach
 *     them there); the mention / reader / auto-watch rules they share with
 *     `editComment` are in pm-mentions.ts, pm-readers.ts and pm-watchers.ts.
 *   - Delivery. Nothing in this file notifies anybody. Mentions, comments,
 *     state changes and assignments become notifications because the activity
 *     rows written here and in pm.service.ts are swept by
 *     activity-notify.service.ts — one pipeline, no second dispatcher.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { PM_TIMELINE_MIRRORED_VERBS, normalizePmReactionEmoji } from "@droplet/shared-types";
import {
  PM_ERRORS,
  hydrateComments,
  isPrismaCode,
  mapActivity,
  writeActivity,
  type ApiActivity,
  type ApiComment,
} from "./pm.service.js";
import {
  isEmptyCommentHtml,
  recordMentions,
  resolveCommentMentions,
  retractCommentNotifications,
} from "./pm-mentions.js";
import { filterItemReaders } from "./pm-readers.js";

type Db = PrismaClient | Prisma.TransactionClient;

// ── Stable error codes ────────────────────────────────────────────────────────
// `comment_not_found` and `work_item_not_found` are PM_ERRORS' own; these are
// the ones this slice adds. The route layer maps the whole vocabulary.
export const PM_COLLAB_ERRORS = {
  /** Not the author (edit), or neither the author nor an owner/admin (delete). */
  COMMENT_FORBIDDEN: "comment_forbidden",
  /** The comment is a tombstone: it can be neither edited nor reacted to. */
  COMMENT_DELETED: "comment_deleted",
  /** An edit that would leave no text. Deleting is the way to remove a comment. */
  EMPTY_COMMENT: "empty_comment",
  INVALID_EMOJI: "invalid_emoji",
  /** Adding or removing SOMEBODY ELSE as a watcher without owner/admin/lead rights. */
  WATCH_FORBIDDEN: "watch_forbidden",
  /** The person to watch the item cannot read it (guest not assigned, deactivated, …). */
  USER_CANNOT_READ: "user_cannot_read_item",
  INVALID_CURSOR: "invalid_cursor",
} as const;

/** Who is acting. `id` is null for the MCP service principal and for any caller
 *  without a person behind it — none of these writes is open to one. */
export interface CollabActor {
  id: string | null;
  role: string | undefined;
}

const isAdminRole = (role: string | undefined): boolean => role === "owner" || role === "admin";

// ── Comments: edit + delete ───────────────────────────────────────────────────

/**
 * Edit a comment. AUTHOR ONLY — an owner or admin may delete somebody else's
 * comment but may not put new words in their mouth, and an AI-authored comment
 * (`authorId` null) has no author to edit it.
 *
 * Mentions are re-derived from the new html under the same rules as a new
 * comment (sanitized first, read back out of the result, kept only for people
 * who can read the item). Only people NEWLY mentioned are told; a mention
 * removed before the sweep has run is retracted. An edit that changes nothing is
 * not an edit: no `editedAt`, no activity row, no "(edited)" marker.
 */
export async function editComment(
  prisma: PrismaClient,
  actor: CollabActor,
  commentId: string,
  commentHtml: string,
): Promise<ApiComment> {
  const existing = await prisma.pmComment.findUnique({
    where: { id: commentId },
    include: { mentions: { select: { userId: true } } },
  });
  if (!existing) throw new Error(PM_ERRORS.COMMENT_NOT_FOUND);
  if (actor.id === null || existing.authorId !== actor.id) {
    throw new Error(PM_COLLAB_ERRORS.COMMENT_FORBIDDEN);
  }
  if (existing.isDeleted) throw new Error(PM_COLLAB_ERRORS.COMMENT_DELETED);

  const { html, mentionIds } = await resolveCommentMentions(prisma, existing.workItemId, commentHtml);
  if (isEmptyCommentHtml(html)) throw new Error(PM_COLLAB_ERRORS.EMPTY_COMMENT);
  if (html === existing.commentHtml) return (await hydrateComments(prisma, [existing]))[0]!;

  const authorId = actor.id;
  const previous = existing.mentions.map((m) => m.userId);
  let row;
  try {
    row = await prisma.$transaction(async (tx) => {
      // The guard is IN the statement (pre-PR checklist P1): a delete that
      // commits between the read above and this write must not have its
      // tombstone overwritten with text. Authorship never changes, so a miss
      // here can only mean the comment was deleted under us.
      const updated = await tx.pmComment.updateMany({
        where: { id: commentId, authorId, isDeleted: false },
        data: { commentHtml: html, editedAt: new Date() },
      });
      if (updated.count === 0) throw new Error(PM_COLLAB_ERRORS.COMMENT_DELETED);
      await recordMentions(tx, {
        workItemId: existing.workItemId,
        commentId,
        actorId: authorId,
        mentionIds,
        previous,
      });
      await writeActivity(tx, {
        workItemId: existing.workItemId,
        actorId: authorId,
        verb: "comment_edited",
        field: "comment",
        newValue: commentId,
      });
      return tx.pmComment.findUniqueOrThrow({ where: { id: commentId } });
    });
  } catch (err) {
    // Hard-deleted with its work item between the read and the write.
    if (isPrismaCode(err, "P2025")) throw new Error(PM_ERRORS.COMMENT_NOT_FOUND);
    throw err;
  }
  return (await hydrateComments(prisma, [row]))[0]!;
}

/**
 * Delete a comment — SOFT. The row stays as a tombstone (body cleared) so the
 * thread keeps its shape and the activity trail keeps an anchor; its reactions
 * and mention rows go, and so does any notification it caused that has not been
 * swept yet. Author, or an owner/admin. Deleting a tombstone again is a no-op
 * that returns it: nothing written, no second activity row.
 */
export async function deleteComment(
  prisma: PrismaClient,
  actor: CollabActor,
  commentId: string,
): Promise<ApiComment> {
  const existing = await prisma.pmComment.findUnique({ where: { id: commentId } });
  if (!existing) throw new Error(PM_ERRORS.COMMENT_NOT_FOUND);
  const isAuthor = actor.id !== null && existing.authorId === actor.id;
  if (!isAuthor && !isAdminRole(actor.role)) throw new Error(PM_COLLAB_ERRORS.COMMENT_FORBIDDEN);
  if (existing.isDeleted) return (await hydrateComments(prisma, [existing]))[0]!;

  let row;
  try {
    row = await prisma.$transaction(async (tx) => {
      const deleted = await tx.pmComment.updateMany({
        where: { id: commentId, isDeleted: false },
        data: { commentHtml: "", isDeleted: true, deletedAt: new Date(), deletedById: actor.id },
      });
      // count 0 = somebody else deleted it first: report their tombstone, and
      // do not write a second `comment_deleted`.
      if (deleted.count > 0) {
        await tx.pmCommentReaction.deleteMany({ where: { commentId } });
        await tx.pmCommentMention.deleteMany({ where: { commentId } });
        await retractCommentNotifications(tx, existing.workItemId, commentId);
        await writeActivity(tx, {
          workItemId: existing.workItemId,
          actorId: actor.id,
          verb: "comment_deleted",
          field: "comment",
          oldValue: commentId,
        });
      }
      return tx.pmComment.findUniqueOrThrow({ where: { id: commentId } });
    });
  } catch (err) {
    if (isPrismaCode(err, "P2025")) throw new Error(PM_ERRORS.COMMENT_NOT_FOUND);
    throw err;
  }
  return (await hydrateComments(prisma, [row]))[0]!;
}

// ── Reactions ─────────────────────────────────────────────────────────────────

/** Resolve the emoji against the closed allowlist and load the live comment a
 *  reaction can attach to. Shared by add and remove so the two cannot disagree
 *  about what is a legal target. */
async function reactionTarget(
  prisma: PrismaClient,
  actor: CollabActor,
  commentId: string,
  emoji: string,
) {
  const canonical = normalizePmReactionEmoji(emoji);
  if (!canonical) throw new Error(PM_COLLAB_ERRORS.INVALID_EMOJI);
  if (actor.id === null) throw new Error(PM_COLLAB_ERRORS.COMMENT_FORBIDDEN);
  const comment = await prisma.pmComment.findUnique({ where: { id: commentId } });
  if (!comment) throw new Error(PM_ERRORS.COMMENT_NOT_FOUND);
  if (comment.isDeleted) throw new Error(PM_COLLAB_ERRORS.COMMENT_DELETED);
  return { emoji: canonical, userId: actor.id, comment };
}

/** React to a comment. Idempotent per (comment, person, emoji): reacting twice
 *  is one reaction, reported as `created: false` rather than as an error. */
export async function addReaction(
  prisma: PrismaClient,
  actor: CollabActor,
  commentId: string,
  emoji: string,
): Promise<{ comment: ApiComment; created: boolean }> {
  const t = await reactionTarget(prisma, actor, commentId, emoji);
  let created: boolean;
  try {
    const res = await prisma.pmCommentReaction.createMany({
      data: [{ commentId, userId: t.userId, emoji: t.emoji }],
      skipDuplicates: true,
    });
    created = res.count === 1;
  } catch (err) {
    // The comment was hard-deleted (its work item went) between the read and the insert.
    if (isPrismaCode(err, "P2003")) throw new Error(PM_ERRORS.COMMENT_NOT_FOUND);
    throw err;
  }
  return { comment: (await hydrateComments(prisma, [t.comment]))[0]!, created };
}

/** Take the caller's own reaction back. Idempotent — removing one that is not
 *  there is not an error. */
export async function removeReaction(
  prisma: PrismaClient,
  actor: CollabActor,
  commentId: string,
  emoji: string,
): Promise<ApiComment> {
  const t = await reactionTarget(prisma, actor, commentId, emoji);
  await prisma.pmCommentReaction.deleteMany({
    where: { commentId, userId: t.userId, emoji: t.emoji },
  });
  return (await hydrateComments(prisma, [t.comment]))[0]!;
}

// ── Watchers ──────────────────────────────────────────────────────────────────

export interface ApiWatcher {
  userId: string;
  reason: "CREATOR" | "ASSIGNEE" | "COMMENTER" | "MENTIONED" | "MANUAL";
  createdAt: string;
}

/**
 * Everyone who hears about the item, oldest subscription first.
 *
 * The stored watch list UNIONED with the item's assignees: an assignee has
 * always been told about their own work (the notify sweep reads the assignees
 * directly), so the list that says who is told must include them even when no
 * row was ever written — an item assigned before the watch list existed, or a
 * row removed by hand. A derived entry reports `ASSIGNEE` and the assignment's
 * own timestamp. One entry per person.
 */
async function readWatchers(db: Db, workItemId: string): Promise<ApiWatcher[]> {
  const [rows, assignees] = await Promise.all([
    db.pmWorkItemWatcher.findMany({
      where: { workItemId },
      select: { userId: true, reason: true, createdAt: true },
    }),
    db.pmWorkItemAssignee.findMany({
      where: { workItemId },
      select: { userId: true, createdAt: true },
    }),
  ]);
  const byUser = new Map<string, { reason: ApiWatcher["reason"]; createdAt: Date }>();
  for (const r of rows) byUser.set(r.userId, { reason: r.reason, createdAt: r.createdAt });
  for (const a of assignees) {
    if (!byUser.has(a.userId)) byUser.set(a.userId, { reason: "ASSIGNEE", createdAt: a.createdAt });
  }
  return [...byUser.entries()]
    .map(([userId, v]) => ({ userId, reason: v.reason, createdAt: v.createdAt }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.userId < b.userId ? -1 : 1))
    .map((w) => ({ userId: w.userId, reason: w.reason, createdAt: w.createdAt.toISOString() }));
}

async function requireItem(db: Db, workItemId: string): Promise<{ id: string; projectId: string }> {
  const item = await db.pmWorkItem.findUnique({
    where: { id: workItemId },
    select: { id: true, projectId: true },
  });
  if (!item) throw new Error(PM_ERRORS.WORK_ITEM_NOT_FOUND);
  return item;
}

export async function listWatchers(prisma: PrismaClient, workItemId: string): Promise<ApiWatcher[]> {
  await requireItem(prisma, workItemId);
  return readWatchers(prisma, workItemId);
}

/** Managing SOMEBODY ELSE's subscription is for owners, admins and the lead of
 *  the item's project. Subscribing yourself needs nothing beyond reading the item. */
async function assertCanManageOthers(
  db: Db,
  actor: CollabActor,
  item: { projectId: string },
): Promise<void> {
  if (isAdminRole(actor.role)) return;
  const project = await db.pmProject.findUnique({
    where: { id: item.projectId },
    select: { leadId: true },
  });
  if (project?.leadId && project.leadId === actor.id) return;
  throw new Error(PM_COLLAB_ERRORS.WATCH_FORBIDDEN);
}

/** Subscribe `targetUserId` (default: the caller) to the item. Idempotent. */
export async function addWatcher(
  prisma: PrismaClient,
  actor: CollabActor,
  workItemId: string,
  targetUserId?: string,
): Promise<{ watchers: ApiWatcher[]; created: boolean }> {
  const item = await requireItem(prisma, workItemId);
  if (actor.id === null) throw new Error(PM_COLLAB_ERRORS.WATCH_FORBIDDEN);
  const target = targetUserId ?? actor.id;
  if (target !== actor.id) {
    await assertCanManageOthers(prisma, actor, item);
    const readers = await filterItemReaders(prisma, workItemId, [target]);
    if (!readers.has(target)) throw new Error(PM_COLLAB_ERRORS.USER_CANNOT_READ);
  }
  const created = await prisma.$transaction(async (tx) => {
    const res = await tx.pmWorkItemWatcher.createMany({
      data: [{ workItemId, userId: target, reason: "MANUAL" }],
      skipDuplicates: true,
    });
    // Only a subscription that actually changed is history.
    if (res.count === 1) {
      await writeActivity(tx, {
        workItemId,
        actorId: actor.id,
        verb: "watcher_added",
        field: "watchers",
        newValue: target,
      });
    }
    return res.count === 1;
  });
  return { watchers: await readWatchers(prisma, workItemId), created };
}

/**
 * Unsubscribe `targetUserId` (default: the caller). A CURRENT ASSIGNEE cannot be
 * unsubscribed — assignees are always told about their own work, which is what
 * `readWatchers` reports — so for them this changes nothing and says so by
 * returning the unchanged list. Take them off the item first.
 */
export async function removeWatcher(
  prisma: PrismaClient,
  actor: CollabActor,
  workItemId: string,
  targetUserId?: string,
): Promise<{ watchers: ApiWatcher[] }> {
  const item = await requireItem(prisma, workItemId);
  if (actor.id === null) throw new Error(PM_COLLAB_ERRORS.WATCH_FORBIDDEN);
  const target = targetUserId ?? actor.id;
  if (target !== actor.id) await assertCanManageOthers(prisma, actor, item);

  const assigned = await prisma.pmWorkItemAssignee.findFirst({
    where: { workItemId, userId: target },
    select: { id: true },
  });
  if (!assigned) {
    await prisma.$transaction(async (tx) => {
      const res = await tx.pmWorkItemWatcher.deleteMany({ where: { workItemId, userId: target } });
      if (res.count > 0) {
        await writeActivity(tx, {
          workItemId,
          actorId: actor.id,
          verb: "watcher_removed",
          field: "watchers",
          oldValue: target,
        });
      }
    });
  }
  return { watchers: await readWatchers(prisma, workItemId) };
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export const TIMELINE_DEFAULT_LIMIT = 100;
export const TIMELINE_MAX_LIMIT = 500;
/** A cursor is an offset into an append-only stream, so it cannot be forged into
 *  anything worse than an expensive read; this bounds how expensive. */
const TIMELINE_MAX_OFFSET = 100_000;

export interface ApiTimelineRefs {
  /** stateId -> name, for the `state_changed` rows on this page. */
  states: Record<string, string>;
  /** labelId -> label, for `label_added` / `label_removed`. */
  labels: Record<string, { name: string; color: string | null }>;
  /** workItemId -> key + name, for `relation_*` and `parent_removed`. */
  workItems: Record<string, { key: string; name: string }>;
}

export type ApiTimelineEntry =
  | { type: "comment"; id: string; at: string; comment: ApiComment }
  | { type: "activity"; id: string; at: string; activity: ApiActivity };

export interface ApiTimeline {
  timeline: ApiTimelineEntry[];
  refs: ApiTimelineRefs;
  nextCursor: string | null;
  total: number;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset })).toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      o?: unknown;
    };
    if (
      parsed?.v === 1 &&
      typeof parsed.o === "number" &&
      Number.isInteger(parsed.o) &&
      parsed.o >= 0 &&
      parsed.o <= TIMELINE_MAX_OFFSET
    ) {
      return parsed.o;
    }
  } catch {
    // fall through to the one error below
  }
  throw new Error(PM_COLLAB_ERRORS.INVALID_CURSOR);
}

type CommentRow = Prisma.PmCommentGetPayload<object>;
type ActivityRow = Prisma.PmActivityGetPayload<object>;
type Merged =
  | { type: "comment"; at: Date; row: CommentRow }
  | { type: "activity"; at: Date; row: ActivityRow };

/** Two ascending streams into one. On equal timestamps the comment comes first
 *  (the thing somebody wrote, then what happened around it); within a stream the
 *  database's own order (createdAt, id) stands, so the merge is total and the
 *  same on every request — which is what makes a page boundary stable. */
function mergeChronological(comments: CommentRow[], activity: ActivityRow[]): Merged[] {
  const out: Merged[] = [];
  let c = 0;
  let a = 0;
  while (c < comments.length || a < activity.length) {
    const nextComment = comments[c];
    const nextActivity = activity[a];
    if (
      nextComment &&
      (!nextActivity || nextComment.createdAt.getTime() <= nextActivity.createdAt.getTime())
    ) {
      out.push({ type: "comment", at: nextComment.createdAt, row: nextComment });
      c++;
    } else if (nextActivity) {
      out.push({ type: "activity", at: nextActivity.createdAt, row: nextActivity });
      a++;
    }
  }
  return out;
}

/** The id in a `KIND:<id>` relation value (relation rows name the OTHER end). */
function relationTargetId(value: string | null): string | null {
  if (!value) return null;
  const i = value.indexOf(":");
  return i >= 0 && i < value.length - 1 ? value.slice(i + 1) : null;
}

/**
 * The work item's comments and activity as ONE chronological stream, newest
 * LAST — the order a thread is read in, with the composer under it.
 *
 * `commented` and `mentioned` activity rows are left out: the comment entry is
 * that event, and the mention is a chip inside it (see
 * PM_TIMELINE_MIRRORED_VERBS). Every other verb is shown, tombstones included.
 *
 * Paging is forward and offset-based behind an opaque cursor: the first page
 * holds the OLDEST entries and `nextCursor` (null at the end) fetches the ones
 * after it. Offset paging is exact here because the stream is append-only and
 * its order is total (see `mergeChronological`). To produce page N each source
 * is read to `offset + limit` rows and merged — the first `offset + limit`
 * entries of the merge can only come from the first `offset + limit` of each
 * source — so cost grows with how far in the caller is, bounded by the offset cap.
 *
 * Ids on the page are resolved to names in one query per kind (`refs`), at read
 * time, because the rows store ids: a renamed state or label reads correctly
 * and a deleted one is simply absent from `refs`.
 */
export async function getTimeline(
  prisma: PrismaClient,
  workItemId: string,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<ApiTimeline> {
  await requireItem(prisma, workItemId);
  const requested = Number.isFinite(opts.limit) ? Math.floor(opts.limit as number) : TIMELINE_DEFAULT_LIMIT;
  const limit = Math.max(1, Math.min(TIMELINE_MAX_LIMIT, requested));
  const offset = decodeCursor(opts.cursor);
  const take = offset + limit;

  const activityWhere: Prisma.PmActivityWhereInput = {
    workItemId,
    verb: { notIn: [...PM_TIMELINE_MIRRORED_VERBS] },
  };
  const [commentRows, activityRows, commentTotal, activityTotal] = await Promise.all([
    prisma.pmComment.findMany({
      where: { workItemId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
    }),
    prisma.pmActivity.findMany({
      where: activityWhere,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
    }),
    prisma.pmComment.count({ where: { workItemId } }),
    prisma.pmActivity.count({ where: activityWhere }),
  ]);

  const page = mergeChronological(commentRows, activityRows).slice(offset, offset + limit);
  const total = commentTotal + activityTotal;
  const nextCursor = offset + page.length < total ? encodeCursor(offset + page.length) : null;

  const pageComments = page.flatMap((e) => (e.type === "comment" ? [e.row] : []));
  const hydrated = new Map(
    (await hydrateComments(prisma, pageComments)).map((c) => [c.id, c] as const),
  );

  const stateIds = new Set<string>();
  const labelIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const e of page) {
    if (e.type !== "activity") continue;
    const { verb, oldValue, newValue } = e.row;
    if (verb === "state_changed") {
      if (oldValue) stateIds.add(oldValue);
      if (newValue) stateIds.add(newValue);
    } else if (verb === "label_added" && newValue) {
      labelIds.add(newValue);
    } else if (verb === "label_removed" && oldValue) {
      labelIds.add(oldValue);
    } else if (verb === "relation_added" || verb === "relation_removed") {
      const other = relationTargetId(verb === "relation_added" ? newValue : oldValue);
      if (other) itemIds.add(other);
    } else if (verb === "parent_removed" && oldValue) {
      itemIds.add(oldValue);
    }
  }
  const [states, labels, items] = await Promise.all([
    stateIds.size === 0
      ? []
      : prisma.pmState.findMany({
          where: { id: { in: [...stateIds] } },
          select: { id: true, name: true },
        }),
    labelIds.size === 0
      ? []
      : prisma.pmLabel.findMany({
          where: { id: { in: [...labelIds] } },
          select: { id: true, name: true, color: true },
        }),
    itemIds.size === 0
      ? []
      : prisma.pmWorkItem.findMany({
          where: { id: { in: [...itemIds] } },
          select: { id: true, name: true, sequenceId: true, project: { select: { identifier: true } } },
        }),
  ]);

  return {
    timeline: page.map((e): ApiTimelineEntry =>
      e.type === "comment"
        ? { type: "comment", id: e.row.id, at: e.at.toISOString(), comment: hydrated.get(e.row.id)! }
        : { type: "activity", id: e.row.id, at: e.at.toISOString(), activity: mapActivity(e.row) },
    ),
    refs: {
      states: Object.fromEntries(states.map((s) => [s.id, s.name])),
      labels: Object.fromEntries(labels.map((l) => [l.id, { name: l.name, color: l.color }])),
      workItems: Object.fromEntries(
        items.map((i) => [i.id, { key: `${i.project.identifier}-${i.sequenceId}`, name: i.name }]),
      ),
    },
    nextCursor,
    total,
  };
}
