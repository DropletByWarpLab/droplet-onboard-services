/**
 * Brain notification policy (WARP-2752, ADR-051) — how a finding reaches a
 * human, and more importantly how often it does not.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT. The detector pass runs hourly. The
 * naive wiring — notify on every finding — pushes the same overdue invoice to
 * the operator's phone every hour, and inside a week they mute the app. A muted
 * brain is a deleted brain, so the delivery policy matters more to whether this
 * feature survives than the detectors do.
 *
 * THE POLICY, in one line: interrupt for a big loss, batch everything else.
 *
 *   IMMEDIATE  a `loss` whose impact clears BRAIN_NOTIFY_MIN_IMPACT_MINOR.
 *              One notification per finding, ever — `notifiedAt` is stamped, so
 *              a condition that persists for a month is announced once.
 *   BATCHED    everything else, as ONE digest no more often than
 *              BRAIN_DIGEST_INTERVAL_MS. Twenty findings in a week produce one
 *              notification, not twenty.
 *   NEVER      a finding with no impact and no severity is not worth a phone
 *              buzz; it waits on /brief for someone to come looking.
 *
 * WHO IS TOLD. The owner, by username. `company`-scope findings are owner/admin
 * material by ADR-051 §9, and there is exactly one owner (the role is a
 * singleton, immutable and unassignable). Broadcasting to every admin would turn
 * one finding into N notifications and re-create the noise problem from the
 * other direction.
 *
 * WHAT IS NOT TOLD, and why. Only `company` scope is notified — enforced in the
 * query since WARP-2811, having been policy-by-comment before it. A `personal`
 * or `department` finding belongs to somebody who is not necessarily the owner,
 * and sending it here would hand them another person's business over a channel
 * with no scope check. They wait on /brief until per-recipient delivery is
 * designed; see WARP-2811.
 */
import type { PrismaClient } from "@prisma/client";
import { sendNotification } from "../notifications.service.js";

/** Only a loss this large interrupts somebody. Minor units. */
export const DEFAULT_MIN_IMPACT_MINOR = 100_000n; // 1,000.00

/** A digest at most this often. */
export const DEFAULT_DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60_000;

const DIGEST_FLAG_KEY = "brain.last_digest_at";

export type NotifyOutcome = {
  immediate: number;
  digested: number;
  digestSent: boolean;
};

/**
 * The single owner, BY USERNAME. Findings go to them; see the module docstring.
 *
 * WARP-2813 — this used to select `id`. The notifications subsystem is keyed on
 * `User.username` end to end: `sendNotification` publishes to
 * `droplet/notifications/${userId}`, the only subscriber is ws-bridge's
 * `droplet/notifications/${user.username}`, and both readers of the persisted
 * `NotificationLog` — routes/notifications.ts and the `list_notifications`
 * tool — filter by username too. A UUID here meant the broker dropped the toast
 * AND no reader could see the stored row, so every notification this file has
 * ever produced reached nobody.
 *
 * This is the exact defect WARP-2783 fixed in audit-verify.service.ts one day
 * after this file landed. That fix's comment called itself "the one UUID-keyed
 * caller in the codebase"; it was not, and the claim of uniqueness is why the
 * sweep stopped there. The return type is named for the vocabulary now, so the
 * next reader cannot mistake which one it is.
 */
async function ownerUsername(prisma: PrismaClient): Promise<string | null> {
  const owner = await prisma.user.findFirst({
    where: { role: "owner" },
    select: { username: true },
  });
  return owner?.username ?? null;
}

export async function notifyFindings(
  prisma: PrismaClient,
  opts: {
    now?: Date;
    minImpactMinor?: bigint;
    digestIntervalMs?: number;
  } = {},
): Promise<NotifyOutcome> {
  const now = opts.now ?? new Date();
  const minImpact = opts.minImpactMinor ?? DEFAULT_MIN_IMPACT_MINOR;
  const digestIntervalMs = opts.digestIntervalMs ?? DEFAULT_DIGEST_INTERVAL_MS;

  const to = await ownerUsername(prisma);
  // No owner = a box mid-setup. Nothing to do, and nothing to record: leaving
  // `notifiedAt` null keeps these findings in the queue for when there is one.
  if (!to) return { immediate: 0, digested: 0, digestSent: false };

  // WARP-2811 — SCOPED. The module docstring states the policy ("WHO IS TOLD.
  // The owner. `company`-scope findings are owner/admin material by ADR-051
  // §9") and nothing enforced it: the query took every scope and sent all of
  // them to one recipient, so the first `personal`- or `department`-scoped
  // finding anyone wrote would arrive on the owner's phone carrying its title
  // and 300 characters of rationale. That is the cross-user leak WARP-2752
  // added `ownerId` and a CHECK to close on the READ path; the notify path
  // never got the same treatment.
  //
  // Personal and department findings deliberately wait on /brief rather than
  // being fanned out here. Per-recipient delivery is a real design — one that
  // has to answer the noise question this file exists to answer — and it is
  // UNBUILT, not forgotten. Until it exists, not notifying is the correct
  // behaviour, and it is the same choice the NEVER tier already makes.
  const pending = await prisma.brainFinding.findMany({
    where: { notifiedAt: null, status: "new", scope: "company" },
    orderBy: [{ impactMinor: { sort: "desc", nulls: "last" } }, { firstSeenAt: "asc" }],
    take: 200,
  });
  if (pending.length === 0) return { immediate: 0, digested: 0, digestSent: false };

  const urgent = pending.filter(
    (f) => f.kind === "loss" && f.impactMinor !== null && f.impactMinor >= minImpact,
  );
  const rest = pending.filter((f) => !urgent.some((u) => u.id === f.id));

  let immediate = 0;
  for (const f of urgent) {
    await sendNotification(prisma, {
      userId: to,
      kind: "ai",
      title: f.title,
      body: f.rationale.slice(0, 300),
    });
    // Stamped one at a time, immediately after its own send. A batch stamp
    // after the loop would re-announce everything if the process died midway.
    await prisma.brainFinding.update({ where: { id: f.id }, data: { notifiedAt: now } });
    immediate += 1;
  }

  if (rest.length === 0) return { immediate, digested: 0, digestSent: false };

  // The digest is rate-limited on its own clock, independent of the pass
  // cadence: the pass may run hourly and still only produce a digest weekly.
  const flag = await prisma.systemFlag.findUnique({ where: { key: DIGEST_FLAG_KEY } });
  const lastAt = (flag?.valueJson as { at?: string } | null)?.at;
  const dueAt = lastAt ? new Date(lastAt).getTime() + digestIntervalMs : 0;
  if (now.getTime() < dueAt) {
    // Not due. Leave `notifiedAt` NULL so these roll into the next digest —
    // holding them is the whole point of batching.
    return { immediate, digested: 0, digestSent: false };
  }

  const losses = rest.filter((f) => f.kind === "loss").length;
  const risks = rest.filter((f) => f.kind === "risk").length;
  const parts = [
    `${rest.length} new ${rest.length === 1 ? "finding" : "findings"}`,
    losses > 0 ? `${losses} money` : null,
    risks > 0 ? `${risks} risk` : null,
  ].filter(Boolean);

  await sendNotification(prisma, {
    userId: to,
    kind: "ai",
    title: `Your business brief: ${parts.join(", ")}`,
    // The top item by impact, so the notification says something specific
    // rather than only a count. A digest that reads "3 new findings" and
    // nothing else is a notification nobody opens.
    body: rest[0] ? rest[0].title.slice(0, 300) : null,
  });

  await prisma.brainFinding.updateMany({
    where: { id: { in: rest.map((f) => f.id) } },
    data: { notifiedAt: now },
  });
  await prisma.systemFlag.upsert({
    where: { key: DIGEST_FLAG_KEY },
    create: { key: DIGEST_FLAG_KEY, valueJson: { at: now.toISOString() } },
    update: { valueJson: { at: now.toISOString() } },
  });

  return { immediate, digested: rest.length, digestSent: true };
}
