/**
 * WARP-2731 (ADR-048) — the morning digest, and the Health row.
 *
 * ── The digest ─────────────────────────────────────────────────────────────
 *
 * One notification, at the hour the owner chose, ONLY when there is something
 * waiting. A daily "0 things need a look" is how a notification becomes
 * furniture, and furniture is not read on the morning it finally says three.
 *
 * Counts only. The title says how many; it never says whose invoice.
 *
 * `sendNotification` publishes the MQTT toast through a swallow-on-error
 * `safePublish` and then ALWAYS writes the `NotificationLog` row — so the
 * durable record survives a down broker, and "did Droplet tell me?" is
 * answerable even on a morning the toast never arrived.
 *
 * ── The Health row ─────────────────────────────────────────────────────────
 *
 * Two numbers that make two different silences visible, and they are the
 * reason this section exists at all:
 *
 *   "last file indexed"  A box upgraded without `scripts/rag-re-embed.sh`
 *                        lands every new file `failed` at the INDEXER, before
 *                        filing ever sees it (WARP-2196). Filing then has
 *                        nothing to do and reports itself perfectly healthy —
 *                        which it is. The corpus is the thing that is broken,
 *                        and nothing on the filing page would say so.
 *
 *   "last filing tick"   A registration that exists but never fires is the
 *                        WARP-1326 class of failure, and it presents exactly
 *                        like "no new documents". The only way to tell them
 *                        apart is to show when the worker last ran.
 *
 * Neither is a count of successes. A feature whose health page reports only
 * what it did is a feature that looks healthiest when it has stopped.
 */
import type { PrismaClient } from "@prisma/client";

import { sendNotification } from "../notifications.service.js";
import { createLogger } from "../../lib/logger.js";
import { readFilingSettings, permittedOwnerIds } from "./settings.js";

const logger = createLogger("filing-digest");

/** In-process record of when the tick last completed. Deliberately NOT a
 *  column: it is a liveness signal about THIS process, and a persisted one
 *  would keep reporting the last run of a process that has since died. */
let lastTickAt: Date | null = null;

export function noteTickCompleted(at: Date = new Date()): void {
  lastTickAt = at;
}

/** Test seam — module state that leaks between tests is a test that passes for
 *  the wrong reason. */
export function __resetTickClockForTests(): void {
  lastTickAt = null;
}

export interface FilingHealth {
  pending: number;
  failed: number;
  /** Hours since the file-indexer last wrote a `ready` row, or null when it
   *  never has. The corpus-block signal. */
  hoursSinceLastIndex: number | null;
  /** ISO time the filing tick last completed in this process, or null. */
  lastTickAt: string | null;
  /** True while the consecutive-failure canary is holding the worker back. */
  paused: boolean;
  pausedReason: string | null;
}

export async function readFilingHealth(
  prisma: PrismaClient,
  pause: { paused: boolean; reason: string | null },
): Promise<FilingHealth> {
  const settings = await readFilingSettings(prisma);
  const owners = await permittedOwnerIds(prisma, settings);

  const [pending, failed, lastIndexed] = await Promise.all([
    prisma.ingestProposal.count({ where: { status: "PENDING" } }),
    owners.length === 0
      ? Promise.resolve(0)
      : prisma.fileIndexStatus.count({
          where: { userId: { in: owners }, extractStatus: "failed" },
        }),
    owners.length === 0
      ? Promise.resolve(null)
      : prisma.fileIndexStatus.findFirst({
          where: { userId: { in: owners }, status: "ready" },
          orderBy: { updatedAt: "desc" },
          select: { updatedAt: true },
        }),
  ]);

  return {
    pending,
    failed,
    hoursSinceLastIndex: lastIndexed
      ? Math.floor((Date.now() - lastIndexed.updatedAt.getTime()) / 3_600_000)
      : null,
    lastTickAt: lastTickAt?.toISOString() ?? null,
    paused: pause.paused,
    pausedReason: pause.reason,
  };
}

export interface DigestResult {
  sent: boolean;
  pending: number;
  reason?: "off" | "no_owner" | "nothing_waiting" | "wrong_hour" | "already_sent";
}

/**
 * Send the digest, if this is the hour and there is anything to say.
 *
 * Idempotent within the day by reading `NotificationLog` rather than by
 * holding state: the hourly registration fires many times, a restart resets
 * any in-memory flag, and a duplicate morning toast is exactly the kind of
 * small rudeness that gets a feature muted.
 */
export async function runFilingDigest(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<DigestResult> {
  const settings = await readFilingSettings(prisma);
  if (settings.mode === "off") return { sent: false, pending: 0, reason: "off" };
  if (!settings.enabledById) return { sent: false, pending: 0, reason: "no_owner" };

  // Local hour, because the owner reads it at breakfast, not at UTC midnight.
  if (now.getHours() !== settings.digestHour) {
    return { sent: false, pending: 0, reason: "wrong_hour" };
  }

  const pending = await prisma.ingestProposal.count({ where: { status: "PENDING" } });
  if (pending === 0) return { sent: false, pending: 0, reason: "nothing_waiting" };

  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);
  const already = await prisma.notificationLog.findFirst({
    where: {
      userId: settings.enabledById,
      kind: "ai",
      createdAt: { gte: startOfDay },
      title: { startsWith: DIGEST_TITLE_PREFIX },
    },
    select: { id: true },
  });
  if (already) return { sent: false, pending, reason: "already_sent" };

  await sendNotification(prisma, {
    userId: settings.enabledById,
    kind: "ai",
    title:
      pending === 1
        ? `${DIGEST_TITLE_PREFIX} 1 thing needs a look`
        : `${DIGEST_TITLE_PREFIX} ${pending} things need a look`,
    // No body. The count IS the message, and a body would be the first place a
    // name or a filename crept in.
    body: null,
  });

  logger.info({ pending }, "filing digest sent");
  return { sent: true, pending };
}

/** The prefix the idempotence read keys on. A constant rather than a literal
 *  in two places, because the day they drift is the day the digest sends
 *  twice every morning and nobody can see why. */
export const DIGEST_TITLE_PREFIX = "Droplet filing:";
