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
 * (Push / phone routing will land later through a dedicated notifier
 * service — for now the in-app toast is the only delivery channel.)
 */

import type { PrismaClient } from "@prisma/client";
import { publish } from "./mqtt.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("notifications");

export type NotificationKind = "reminder" | "event" | "system" | "ai";

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

export async function sendNotification(
  prisma: PrismaClient,
  input: DispatchInput,
): Promise<DispatchResult> {
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
