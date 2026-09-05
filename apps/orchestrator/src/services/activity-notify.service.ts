/**
 * WARP-2587 (ADR-045 slice I) — make PM and the CRM tell somebody.
 *
 * Before this, assigning a ticket notified nobody and a deal reaching Won
 * notified nobody: `git grep -in notif` over pm.service.ts, routes/pm/native.ts
 * and routes/mobile/pm.ts was empty, and the only notification producers on the
 * box were reminders, meetings and two admin paths. The work was recorded and
 * then sat there.
 *
 * ── WHY THERE IS NO EVENT TABLE ────────────────────────────────────────────
 *
 * The durable artifact already exists. `PmActivity` and `CrmActivity` are
 * append-only, written inside the same transaction as the mutation they
 * describe, and already carry the actor and the diff. A parallel `*Event`
 * table would be a second, weaker copy of that — one more thing to keep in
 * sync and one more place for the two to disagree. So the claim lives ON the
 * activity row, and this service is a projector over rows that already exist.
 *
 * ── THE CLAIM IS AN ENUM, NOT AN IS-NULL ───────────────────────────────────
 *
 * `notifyStatus` (pending | sent | not_needed) is the state; `notifiedAt` is
 * an audit timestamp only, pinned to the enum by a CHECK in the migration.
 * A nullable timestamp could only express two states, so every row this sweep
 * legitimately declines to notify about — an `updated` verb, a CRM NOTE, an
 * assignment whose only recipient is the person who made it — would sit at
 * NULL forever and be rescanned on every 60s tick for the life of the row.
 * `not_needed` is the explicit terminal that makes "skipped" a decision
 * somebody wrote down (CLAUDE.md: persistent state lives in explicit columns;
 * TeamChatMeetingReminderStatus is the precedent this copies).
 *
 * ── EXACTLY-ONCE ───────────────────────────────────────────────────────────
 *
 * index.ts registers this on cron-runtime with the
 * `droplet:activity-notify` advisory-lock key — never a hand-rolled loop, and
 * never two replicas sweeping at once. Per tick the pending→sent claim
 * (`updateMany` guarded on `notifyStatus: "pending"`) commits in the SAME
 * transaction as the NotificationLog rows it produces, so a crash before
 * commit leaves the activity rows pending and the next tick redoes the work,
 * and a crash after commit has already durably recorded the notification.
 * NotificationLog IS the durable artifact here — it is what the dashboard's
 * "Recent notifications" panel and the `list_notifications` tool read. Only
 * the MQTT toast is best-effort, and it runs AFTER the commit; a failed toast
 * is logged, stamped on the log row's `error`, and contained.
 *
 * ── WHICH EVENTS, AND WHY THE CUT IS THIS SMALL ────────────────────────────
 *
 * PM: `assigned`, `state_changed`, `due_date_changed`, `commented`. Nothing
 * else. The excluded ones are excluded on purpose:
 *   • `updated` is the catch-all bucket pm.service.ts writes for a name,
 *     description, startDate or label change. It fires on a typo fix. A
 *     notifier that pings the whole team when somebody corrects a spelling is
 *     uninstalled once and never trusted again, and it takes the four verbs
 *     that DO matter down with it.
 *   • `title_changed`, `priority_changed`, `label_*`, `cycle_*`, `module_*`,
 *     `archived`, `restored`, `parent_removed` are board hygiene. They are
 *     visible in the item's own activity feed, which is where somebody who
 *     cares about them is already looking.
 *   • `created` is not an event for anyone but its assignees, and a create
 *     WITH assignees now writes `assigned` rows too (pm.service.ts), so the
 *     case is covered by the verb that actually names it.
 *   • `unassigned` is recorded but not notified: "you are no longer on this"
 *     is rarely actionable and doubles the traffic of every re-assignment.
 *
 * CRM: a STAGE_CHANGE whose destination stage has `kind` WON or LOST. Not
 * every stage move — a deal walking through four OPEN stages is the pipeline
 * working, not news. The outcome class is read from CrmPipelineStage.kind and
 * never inferred from the stage's name or position, because those are
 * owner-configurable (the enum's own docstring says so).
 *
 * ── WHO ────────────────────────────────────────────────────────────────────
 *
 * PM: the work item's assignees (PmWorkItemAssignee), plus whatever
 * `departmentWatchers` resolves — see the seam below — and NEVER the actor.
 * A person does not need to be told what they just did; team-chat-reminders
 * gets that clause right for the organizer and this copies it.
 * CRM: the deal's `ownerId`, minus the actor.
 *
 * ── COALESCING, AND ITS WINDOW ─────────────────────────────────────────────
 *
 * A bulk import that assigns 200 tickets must not send 200 notifications, so
 * the unit of delivery is (recipient, tick, source) — at most ONE
 * NotificationLog row per recipient per 60s tick from PM and one from the CRM.
 * One activity gets a specific message; two or more get a counted digest.
 *
 * Two constants make that work:
 *   • SETTLE_MS (60s): a row is only a candidate once it is 60s old. Without
 *     it, the first rows of a burst that is still arriving get their own
 *     notification and the remaining 197 get a digest — the worst of both.
 *     The cost is stated rather than hidden: worst-case latency from "you were
 *     assigned" to the toast is SETTLE_MS + one tick, about two minutes. An
 *     assignment is not a page; two minutes is the right side of that trade.
 *   • BATCH (500 rows per source per tick): a pathological backlog (a
 *     connector backfill, a box that was off for a week) drains across
 *     successive ticks FIFO instead of one unbounded scan, and every
 *     unprocessed row stays `pending` so the next tick resumes exactly where
 *     this one stopped.
 */
import type { $Enums, Prisma, PrismaClient } from "@prisma/client";
import {
  publishNotificationToast,
  recordNotification,
} from "./notifications.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("activity-notify");

/** A row is only a candidate once it has been still for this long — the
 *  coalescing window. See the header for why it is not zero. */
export const SETTLE_MS = 60_000;

/** Rows considered per source table per tick. Bounds one tick's work; the
 *  remainder stays `pending` and drains on the next one. */
export const BATCH = 500;

/** NotificationLog.title / .body caps, matching routes/notifications.ts's zod
 *  schema so a digest can never write a row the manual-send path would
 *  reject. */
const TITLE_MAX = 120;
const BODY_MAX = 500;

/** The four PM verbs worth interrupting somebody for. See the header for the
 *  justification of every verb NOT in this set — the cut is the design. */
export const NOTIFIABLE_PM_VERBS: ReadonlySet<$Enums.PmActivityVerb> =
  new Set<$Enums.PmActivityVerb>([
    "assigned",
    "state_changed",
    "due_date_changed",
    "commented",
  ]);

/** Digest vocabulary — one short past-tense word per verb, so a tally reads
 *  as English ("2 assigned · 1 moved"). */
const PM_VERB_WORD: Record<string, string> = {
  assigned: "assigned",
  state_changed: "moved",
  due_date_changed: "re-dated",
  commented: "commented",
};

/**
 * THE SLICE-H SEAM.
 *
 * Slice H gives a PmProject a department. Until it lands there is no edge in
 * the schema from a work item to a Department at all — PmProject has no
 * `departmentId`, PmWorkspace has none, and DepartmentMembership points only
 * at Department and User. So "notify the department too" cannot be written
 * today without either a raw `information_schema` probe (a pattern this repo
 * has zero precedent for, and dead code the day slice H ships) or a compile
 * dependency on a column that does not exist.
 *
 * Instead the recipient set takes an injected resolver that defaults to
 * `noDepartmentWatchers`. This slice ships the MERGE, the de-duplication and
 * the actor exclusion already correct for a non-empty result, and
 * activity-notify.service.test.ts drives them with a stub resolver — so the
 * path is PROVEN before slice H exists rather than merely present.
 *
 * Slice H's whole integration is then: implement this signature over
 * `PmProject.departmentId → DepartmentMembership.userId`, and pass it at the
 * single call site in index.ts. Nothing in this file changes.
 *
 * Contract: workItemId → User.id[]. Unknown ids may be omitted; the caller
 * tolerates a partial map.
 */
export type DepartmentWatchersResolver = (
  prisma: PrismaClient,
  workItemIds: readonly string[],
) => Promise<Map<string, string[]>>;

/** The shipping default until slice H lands. Degrades to "assignees only",
 *  which is the correct answer for a box with no departments configured — it
 *  is not a stub that silently drops a feature. */
export const noDepartmentWatchers: DepartmentWatchersResolver = async () =>
  new Map<string, string[]>();

export interface ActivityNotifySweepResult {
  /** PmActivity rows claimed `sent`. */
  pmNotified: number;
  /** PmActivity rows given the explicit `not_needed` terminal. */
  pmSkipped: number;
  crmNotified: number;
  crmSkipped: number;
  /** NotificationLog rows written across both phases. */
  notificationsSent: number;
}

export interface ActivityNotifyOpts {
  departmentWatchers?: DepartmentWatchersResolver;
  /** Injectable clock — the settle window is the one thing worth pinning
   *  deterministically in tests. */
  now?: () => number;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** "INBOX-42 — Fix the leak", the way the dashboard and the LLM both name a
 *  work item. Falls back to the bare name if the project identifier is
 *  missing (it cannot be, inside a transaction, but a null-safe read here is
 *  cheaper than a thrown sweep). */
function workItemLabel(item: {
  name: string;
  sequenceId: number;
  project: { identifier: string } | null;
}): string {
  const key = item.project ? `${item.project.identifier}-${item.sequenceId}` : null;
  return key ? `${key} — ${item.name}` : item.name;
}

/** "2 assigned · 1 moved" — insertion-ordered so the tally reads in the order
 *  things happened rather than alphabetically. */
function tally(words: string[]): string {
  const counts = new Map<string, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()].map(([w, n]) => `${n} ${w}`).join(" · ");
}

interface Outgoing {
  /** NotificationLog.userId is a USERNAME, not a User.id — the MQTT topic
   *  ws-bridge subscribes to is `droplet/notifications/{username}`
   *  (ws-bridge.service.ts) and routes/notifications.ts keys the panel the
   *  same way. Same clause as team-chat-reminders.service.ts. */
  username: string;
  title: string;
  body: string;
}

/**
 * Claim the rows and durably record the notifications, atomically; then
 * publish the toasts and stamp what actually delivered.
 *
 * Split this way on purpose: the claim and the NotificationLog rows must not
 * be able to disagree (a row marked `sent` with no log entry is a
 * notification the user can never find), while the MQTT publish is a leaf
 * effect that must never be able to roll the claim back.
 */

/**
 * The ONLY thing this sweep needs from either activity delegate.
 *
 * `Prisma.PmActivityDelegate | Prisma.CrmActivityDelegate` is not callable:
 * TypeScript refuses to call a union of generic signatures that are not
 * mutually assignable, and these two are not. Widening to `any` would hide the
 * two fields the claim actually depends on. This structural type names them
 * instead, so a rename of `notifyStatus` on either model is a compile error
 * here rather than a silently non-matching `where`.
 */
type NotifyClaimDelegate = {
  updateMany(args: {
    where: { id: { in: string[] }; notifyStatus: "pending" };
    data: { notifyStatus: "sent" | "not_needed"; notifiedAt?: Date | null };
  }): Promise<{ count: number }>;
};

async function claimAndNotify(
  prisma: PrismaClient,
  table: "pmActivity" | "crmActivity",
  sendIds: string[],
  outgoing: Outgoing[],
  now: Date,
): Promise<number> {
  if (sendIds.length === 0 || outgoing.length === 0) return 0;

  const logIds = await prisma.$transaction(async (tx) => {
    const claimed = await (
      tx[table] as unknown as NotifyClaimDelegate
    ).updateMany({
      where: { id: { in: sendIds }, notifyStatus: "pending" },
      data: { notifyStatus: "sent", notifiedAt: now },
    });
    if (claimed.count === 0) return [];
    if (claimed.count !== sendIds.length) {
      // Under the advisory lock this is unreachable: the sweep is
      // single-flight box-wide and nothing else writes notifyStatus. It is
      // logged rather than thrown because the message built from the
      // candidate set is a SUPERSET of what was claimed — over-reporting one
      // digest line beats losing the claim for every row in the batch.
      logger.warn(
        { table, candidates: sendIds.length, claimed: claimed.count },
        "activity-notify claimed fewer rows than it planned — is the advisory lock wired up?",
      );
    }
    const ids: string[] = [];
    for (const o of outgoing) {
      const log = await recordNotification(tx, {
        userId: o.username,
        kind: "event",
        title: o.title,
        body: o.body,
      });
      ids.push(log.id);
    }
    return ids;
  });

  if (logIds.length === 0) return 0;

  // Best-effort delivery, AFTER the commit. Failures are logged, stamped on
  // the row, and contained — the log entry is the durable artifact and the
  // user can still find it in the panel.
  const delivered: string[] = [];
  const failed: string[] = [];
  outgoing.forEach((o, i) => {
    const { channels } = publishNotificationToast({
      userId: o.username,
      kind: "event",
      title: o.title,
      body: o.body,
    });
    (channels.length > 0 ? delivered : failed).push(logIds[i]);
  });
  try {
    if (delivered.length > 0) {
      await prisma.notificationLog.updateMany({
        where: { id: { in: delivered } },
        data: { channels: "toast", deliveredAt: now },
      });
    }
    if (failed.length > 0) {
      await prisma.notificationLog.updateMany({
        where: { id: { in: failed } },
        data: { error: "toast: mqtt_unavailable" },
      });
    }
  } catch (err) {
    logger.warn(
      { err, table },
      "activity-notify delivery stamp failed — notifications are already recorded",
    );
  }
  return logIds.length;
}

/** One `updateMany` for the whole skipped set. A row is never left `pending`
 *  after this sweep has looked at it and decided against it. */
async function markNotNeeded(
  prisma: PrismaClient,
  table: "pmActivity" | "crmActivity",
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const res = await (
    prisma[table] as unknown as NotifyClaimDelegate
  ).updateMany({
    where: { id: { in: ids }, notifyStatus: "pending" },
    // notifiedAt stays NULL: nothing was notified. The migration's CHECK
    // ("notifyStatus" = 'sent') = ("notifiedAt" IS NOT NULL) is what keeps
    // that honest.
    data: { notifyStatus: "not_needed" },
  });
  return res.count;
}

async function sweepPm(
  prisma: PrismaClient,
  cutoff: Date,
  now: Date,
  resolveWatchers: DepartmentWatchersResolver,
): Promise<{ notified: number; skipped: number; logs: number }> {
  // Ordered by createdAt so a backlog drains FIFO. The
  // [notifyStatus, createdAt] index makes the `pending` prefix selective even
  // though the table is append-only and almost every row is terminal.
  const rows = await prisma.pmActivity.findMany({
    where: { notifyStatus: "pending", createdAt: { lte: cutoff } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    include: {
      workItem: {
        select: {
          id: true,
          name: true,
          sequenceId: true,
          project: { select: { identifier: true } },
        },
      },
    },
  });
  if (rows.length === 0) return { notified: 0, skipped: 0, logs: 0 };

  const candidates = rows.filter((r) => NOTIFIABLE_PM_VERBS.has(r.verb));
  const skipIds = rows.filter((r) => !NOTIFIABLE_PM_VERBS.has(r.verb)).map((r) => r.id);
  if (candidates.length === 0) {
    return { notified: 0, skipped: await markNotNeeded(prisma, "pmActivity", skipIds), logs: 0 };
  }

  const workItemIds = [...new Set(candidates.map((r) => r.workItemId))];
  const [assignees, watchers] = await Promise.all([
    prisma.pmWorkItemAssignee.findMany({
      where: { workItemId: { in: workItemIds } },
      select: { workItemId: true, userId: true },
    }),
    resolveWatchers(prisma, workItemIds).catch((err) => {
      // A department resolver that throws must not take the assignee
      // notifications down with it.
      logger.warn({ err }, "department watcher resolution failed — assignees only");
      return new Map<string, string[]>();
    }),
  ]);

  const byItem = new Map<string, Set<string>>();
  for (const a of assignees) {
    const set = byItem.get(a.workItemId) ?? new Set<string>();
    set.add(a.userId);
    byItem.set(a.workItemId, set);
  }
  for (const [itemId, userIds] of watchers) {
    const set = byItem.get(itemId) ?? new Set<string>();
    for (const u of userIds) set.add(u);
    byItem.set(itemId, set);
  }

  // A `state_changed` row carries stateIds, not names. "moved" without a
  // destination is a notification nobody can act on, so resolve the names.
  const stateIds = [
    ...new Set(
      candidates
        .filter((r) => r.verb === "state_changed" && r.newValue)
        .map((r) => r.newValue as string),
    ),
  ];
  const stateNames = new Map<string, string>(
    stateIds.length === 0
      ? []
      : (
          await prisma.pmState.findMany({
            where: { id: { in: stateIds } },
            select: { id: true, name: true },
          })
        ).map((s) => [s.id, s.name] as const),
  );

  // recipient User.id -> the rows they should hear about.
  const perUser = new Map<string, typeof candidates>();
  const sendIds = new Set<string>();
  for (const row of candidates) {
    const recipients = [...(byItem.get(row.workItemId) ?? new Set<string>())].filter(
      // NEVER the actor.
      (userId) => userId !== row.actorId,
    );
    if (recipients.length === 0) {
      skipIds.push(row.id);
      continue;
    }
    sendIds.add(row.id);
    for (const userId of recipients) {
      const list = perUser.get(userId) ?? [];
      list.push(row);
      perUser.set(userId, list);
    }
  }

  const users =
    perUser.size === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: [...perUser.keys()] } },
          select: { id: true, username: true },
        });
  const usernames = new Map(users.map((u) => [u.id, u.username] as const));

  const outgoing: Outgoing[] = [];
  const reached = new Set<string>();
  for (const [userId, list] of perUser) {
    const username = usernames.get(userId);
    if (!username) {
      // A recipient with no directory row (deleted since the activity was
      // written). Not an error; their rows simply have one fewer recipient.
      continue;
    }
    for (const r of list) reached.add(r.id);
    if (list.length === 1) {
      const row = list[0];
      const label = workItemLabel(row.workItem);
      const title =
        row.verb === "assigned"
          ? "Assigned to you"
          : row.verb === "commented"
            ? "New comment"
            : row.verb === "due_date_changed"
              ? "Due date changed"
              : `Moved to ${stateNames.get(row.newValue ?? "") ?? "a new state"}`;
      outgoing.push({
        username,
        title: truncate(title, TITLE_MAX),
        body: truncate(label, BODY_MAX),
      });
      continue;
    }
    outgoing.push({
      username,
      title: truncate(`${list.length} updates on your work`, TITLE_MAX),
      body: truncate(tally(list.map((r) => PM_VERB_WORD[r.verb] ?? "updated")), BODY_MAX),
    });
  }

  // A candidate whose every recipient turned out to be undeliverable gets the
  // explicit terminal too — no row escapes this sweep still pending.
  for (const id of sendIds) if (!reached.has(id)) skipIds.push(id);
  const finalSendIds = [...reached];

  const logs = await claimAndNotify(prisma, "pmActivity", finalSendIds, outgoing, now);
  const skipped = await markNotNeeded(prisma, "pmActivity", skipIds);
  return { notified: logs > 0 ? finalSendIds.length : 0, skipped, logs };
}

async function sweepCrm(
  prisma: PrismaClient,
  cutoff: Date,
  now: Date,
): Promise<{ notified: number; skipped: number; logs: number }> {
  // Gated on createdAt, NOT occurredAt. `occurredAt` is the time the thing
  // HAPPENED and can be backdated by a connector or dated in the FUTURE by a
  // meeting — a future-dated row would never reach an occurredAt cutoff and
  // would sit pending forever, which is precisely the failure the explicit
  // terminal exists to prevent. createdAt is the row-write clock and is
  // monotone.
  const rows = await prisma.crmActivity.findMany({
    where: { notifyStatus: "pending", createdAt: { lte: cutoff } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    include: { deal: { select: { id: true, title: true, ownerId: true } } },
  });
  if (rows.length === 0) return { notified: 0, skipped: 0, logs: 0 };

  const stageChanges = rows.filter(
    (r) => r.kind === "STAGE_CHANGE" && r.toStageId !== null && r.deal !== null,
  );
  const skipIds = rows
    .filter((r) => !(r.kind === "STAGE_CHANGE" && r.toStageId !== null && r.deal !== null))
    .map((r) => r.id);

  // The OUTCOME is `CrmPipelineStage.kind` and nothing else — never the
  // stage's name, never its position. Both are owner-configurable.
  const stageIds = [...new Set(stageChanges.map((r) => r.toStageId as string))];
  const stages =
    stageIds.length === 0
      ? []
      : await prisma.crmPipelineStage.findMany({
          where: { id: { in: stageIds } },
          select: { id: true, name: true, kind: true },
        });
  const stageById = new Map(stages.map((s) => [s.id, s] as const));

  const perUser = new Map<string, Array<{ id: string; title: string; outcome: "WON" | "LOST"; stage: string }>>();
  for (const row of stageChanges) {
    const stage = stageById.get(row.toStageId as string);
    if (!stage || stage.kind === "OPEN") {
      skipIds.push(row.id);
      continue;
    }
    const owner = row.deal?.ownerId ?? null;
    if (!owner || owner === row.actorId) {
      // Unowned, or the person who moved it IS the owner.
      skipIds.push(row.id);
      continue;
    }
    const list = perUser.get(owner) ?? [];
    list.push({
      id: row.id,
      title: row.deal?.title ?? "a deal",
      outcome: stage.kind,
      stage: stage.name,
    });
    perUser.set(owner, list);
  }

  const users =
    perUser.size === 0
      ? []
      : await prisma.user.findMany({
          where: { id: { in: [...perUser.keys()] } },
          select: { id: true, username: true },
        });
  const usernames = new Map(users.map((u) => [u.id, u.username] as const));

  const outgoing: Outgoing[] = [];
  const sendIds: string[] = [];
  for (const [userId, list] of perUser) {
    const username = usernames.get(userId);
    if (!username) continue;
    for (const item of list) sendIds.push(item.id);
    if (list.length === 1) {
      const only = list[0];
      outgoing.push({
        username,
        title: only.outcome === "WON" ? "Deal won" : "Deal lost",
        body: truncate(`${only.title} — ${only.stage}`, BODY_MAX),
      });
      continue;
    }
    outgoing.push({
      username,
      title: truncate(`${list.length} deals closed`, TITLE_MAX),
      body: truncate(
        tally(list.map((i) => (i.outcome === "WON" ? "won" : "lost"))),
        BODY_MAX,
      ),
    });
  }

  for (const row of stageChanges) {
    if (!sendIds.includes(row.id) && !skipIds.includes(row.id)) skipIds.push(row.id);
  }

  const logs = await claimAndNotify(prisma, "crmActivity", sendIds, outgoing, now);
  const skipped = await markNotNeeded(prisma, "crmActivity", skipIds);
  return { notified: logs > 0 ? sendIds.length : 0, skipped, logs };
}

/**
 * One tick. Registered on cron-runtime at 60s with the
 * `droplet:activity-notify` advisory lock (index.ts).
 *
 * Errors propagate naked to cron-runtime's `safeRun`, matching every other
 * handler: a sweep that cannot read the database SHOULD increment the
 * consecutive-failure canary rather than be absorbed here. Only the leaf
 * effects (the MQTT toast, the department resolver) are contained.
 */
export async function runActivityNotifySweep(
  prisma: PrismaClient,
  opts: ActivityNotifyOpts = {},
): Promise<ActivityNotifySweepResult> {
  const nowMs = (opts.now ?? Date.now)();
  const now = new Date(nowMs);
  const cutoff = new Date(nowMs - SETTLE_MS);
  const resolveWatchers = opts.departmentWatchers ?? noDepartmentWatchers;

  const pm = await sweepPm(prisma, cutoff, now, resolveWatchers);
  const crm = await sweepCrm(prisma, cutoff, now);

  return {
    pmNotified: pm.notified,
    pmSkipped: pm.skipped,
    crmNotified: crm.notified,
    crmSkipped: crm.skipped,
    notificationsSent: pm.logs + crm.logs,
  };
}
