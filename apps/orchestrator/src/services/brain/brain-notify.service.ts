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
 * WHO IS TOLD. The owner. `company`-scope findings are owner/admin material by
 * ADR-051 §9, and there is exactly one owner (the role is a singleton, immutable
 * and unassignable). Broadcasting to every admin would turn one finding into N
 * notifications and re-create the noise problem from the other direction.
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

/** The single owner. Findings go to them; see the module docstring. */
async function ownerId(prisma: PrismaClient): Promise<string | null> {
  const owner = await prisma.user.findFirst({ where: { role: "owner" }, select: { id: true } });
  return owner?.id ?? null;
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

  const to = await ownerId(prisma);
  // No owner = a box mid-setup. Nothing to do, and nothing to record: leaving
  // `notifiedAt` null keeps these findings in the queue for when there is one.
  if (!to) return { immediate: 0, digested: 0, digestSent: false };

  const pending = await prisma.brainFinding.findMany({
    where: { notifiedAt: null, status: "new" },
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
