/**
 * Notification dispatcher.
 *
 * One in-process function — `sendNotification()` — that publishes a
 * notification to the in-app toast channel (MQTT on
 * `droplet/notifications/{user}`). The ws-bridge service forwards
 * user-scoped MQTT topics over the dashboard's WebSocket, so any open
 * browser tab receives the toast in real time without polling.
 *
 * Every dispatch is logged in the NotificationLog table (kind, title,
 * delivery status, error). The in-app "Recent notifications" panel +
 * the LLM `list_notifications` tool both read from this log so the user
 * has a single source of truth.
 *
 * WARP-2752 (ADR-051) — WEB PUSH IS NOW A SECOND CHANNEL. It was fully built
 * (`push-dispatch.service.ts`, `PushSubscription`, a service worker, subscribe
 * routes) and `sendNotification` never called it: `dispatchToUser` had exactly
 * two production callers, the camera detection fan-out and a manual test
 * button. So a camera seeing a person reached your phone and nothing else ever
 * did. Both channels are attempted here, both are best-effort, and the
 * NotificationLog row records which ones actually carried it.
 */

import type { $Enums, Prisma, PrismaClient } from "@prisma/client";
import { publish } from "./mqtt.service.js";
import { dispatchToUser, ensurePushDispatch } from "./push-dispatch.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("notifications");

/** WARP-2587 — DERIVED from the Prisma enum, not restated. `kind` used to be a
 *  free String column whose vocabulary lived in a comment; now the column, this
 *  type and the route's zod enum all trace to one declaration in
 *  schema.prisma. A new label added there is a compile error at every site
 *  that has to handle it. */
export type NotificationKind = $Enums.NotificationKind;

/** A Prisma client OR an interactive-transaction handle. `recordNotification`
 *  takes this so a caller can commit the log row in the SAME transaction as
 *  whatever claim made it necessary (WARP-2587). */
type NotificationDb = PrismaClient | Prisma.TransactionClient;

export interface DispatchInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
}

export interface DispatchResult {
  id: string;
  channels: string[];
  delivered: boolean;
  error?: string;
}

/** Safe MQTT publish — failures are logged but never thrown. The toast
 *  channel is best-effort: if MQTT is down the notification still gets
 *  logged so the user can find it later. */
function safePublish(topic: string, payload: Record<string, unknown>): boolean {
  try {
    publish(topic, payload);
    return true;
  } catch (err) {
    logger.warn({ err, topic }, "MQTT notification publish failed");
    return false;
  }
}

/**
 * WARP-2587 — the TRANSPORT half of a dispatch, on its own.
 *
 * Extracted so a caller that must write the log row transactionally can still
 * publish the toast afterwards. Never throws: the toast is best-effort by
 * design and the log row is the durable record.
 */
export function publishNotificationToast(input: DispatchInput): {
  channels: string[];
  errors: string[];
} {
  const channels: string[] = [];
  const errors: string[] = [];
  // Channel 1: toast. Always attempted because the ws-bridge is the cheapest
  // delivery path and the user always has a dashboard tab nearby.
  const toastOk = safePublish(`droplet/notifications/${input.userId}`, {
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    at: new Date().toISOString(),
  });
  if (toastOk) channels.push("toast");
  else errors.push("toast: mqtt_unavailable");
  return { channels, errors };
}

/**
 * WARP-2587 — the DURABLE half, writable inside somebody else's transaction.
 *
 * The row lands "queued": no channels, no deliveredAt. That is honest — at the
 * time it is written nothing has been transported yet, and the caller stamps
 * the outcome after it commits and publishes. It is also what makes the
 * activity-notify sweep's exactly-once claim possible: the claim and the log
 * row commit together, so a row marked `sent` can never be a notification the
 * user is unable to find.
 */
export async function recordNotification(
  db: NotificationDb,
  input: DispatchInput,
): Promise<{ id: string }> {
  const row = await db.notificationLog.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      channels: "",
      deliveredAt: null,
      error: null,
    },
    select: { id: true },
  });
  return row;
}

export async function sendNotification(
  prisma: PrismaClient,
  input: DispatchInput,
): Promise<DispatchResult> {
  const { channels, errors } = publishNotificationToast(input);

  // Channel 2: web push. The toast only exists while a tab is open, so without
  // this a notification raised at 3am is gone by morning — the log row survives
  // but nothing renders it.
  //
  // Best-effort like the toast, and for the same reason: a push service being
  // slow or a keypair being unconfigured must never fail the caller's write.
  // The difference is that push failures are RECORDED rather than swallowed, so
  // "delivered: false" on a box with subscribers is diagnosable.
  try {
    await ensurePushDispatch(prisma);
    const { sent } = await dispatchToUser(prisma, input.userId, {
      title: input.title,
      body: input.body ?? "",
    });
    if (sent > 0) channels.push("push");
  } catch (err) {
    errors.push(`push: ${err instanceof Error ? err.message : String(err)}`);
  }

  const delivered = channels.length > 0;
  const log = await prisma.notificationLog.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      channels: channels.join(","),
      deliveredAt: delivered ? new Date() : null,
      error: errors.length > 0 ? errors.join(" | ") : null,
    },
  });

  return {
    id: log.id,
    channels,
    delivered,
    error: errors.length > 0 ? errors.join(" | ") : undefined,
  };
}

/** Recent notifications for a user, newest-first. Used by the LLM
 *  `list_notifications` tool and the "Recent notifications" panel. */
export async function listRecentNotifications(
  prisma: PrismaClient,
  userId: string,
  limit = 50,
): Promise<
  Array<{
    id: string;
    kind: string;
    title: string;
    body: string | null;
    channels: string;
    deliveredAt: Date | null;
    error: string | null;
    createdAt: Date;
  }>
> {
  return prisma.notificationLog.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(200, limit)),
  });
}
