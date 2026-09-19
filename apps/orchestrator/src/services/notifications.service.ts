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
  /** WARP-2909 — where to go. A same-origin dashboard path (`/admin/audit?run=<id>`),
   *  validated by `assertNotificationLink`: a single leading `/`, no scheme, no
   *  protocol-relative `//host`, no backslash or control characters, ≤ 512 chars.
   *  Only trusted in-process callers set it; `POST /api/notifications/send`
   *  refuses it so neither the model nor the manual sender can author a lure. */
  url?: string;
  /** WARP-2909 — a small, FLAT, PHI-free record the client may badge on
   *  (`data.needsDecision === true` on a parked run). Validated by
   *  `assertNotificationData`: no nested objects or arrays, ≤ 1 KB serialised,
   *  and the keys `url`, `token`, `confirmationToken`, `bindingHash` and
   *  `pendingBindingHash` are refused. `url` because the service worker spreads
   *  `data` over the validated `url` (public/sw.js) and would open an unvalidated
   *  one; the rest because a notification payload is copied to third-party push
   *  services and OS notification stores, none of which this box controls. */
  data?: Record<string, string | number | boolean>;
  /** WARP-2909 — a collapse key for the OS tray (`agent-run:<runId>`), same
   *  charset/length rule as a tag in the camera fan-out: `^[A-Za-z0-9._:-]{1,128}$`.
   *  No default is derived: the log row does not exist at push time. */
  tag?: string;
}

/** WARP-2909 — the deep-link guards. Each throws a plain Error whose message
 *  starts with `invalid_link` / `invalid_tag` / `invalid_data` so a route or a
 *  worker can name the refusal without a new error class. */
export const NOTIFICATION_LINK_MAX_CHARS = 512;
export const NOTIFICATION_TAG_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const NOTIFICATION_DATA_MAX_BYTES = 1024;
export const NOTIFICATION_DATA_FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "url",
  "token",
  "confirmationToken",
  "bindingHash",
  "pendingBindingHash",
]);

/** Accepts only a same-origin dashboard path: starts with exactly one `/`. */
export function assertNotificationLink(url: string): void {
  if (typeof url !== "string" || url.length === 0 || url.length > NOTIFICATION_LINK_MAX_CHARS) {
    throw new Error(`invalid_link: a notification url is 1–${NOTIFICATION_LINK_MAX_CHARS} characters`);
  }
  if (/[\r\n\0]/.test(url)) {
    throw new Error("invalid_link: a notification url carries no control characters");
  }
  if (url.includes("\\")) {
    throw new Error("invalid_link: a notification url carries no backslash");
  }
  if (!url.startsWith("/")) {
    throw new Error("invalid_link: a notification url is a same-origin path starting with `/`, never a scheme");
  }
  if (url.startsWith("//")) {
    throw new Error("invalid_link: a protocol-relative `//host` url is not a same-origin path");
  }
}

export function assertNotificationTag(tag: string): void {
  if (typeof tag !== "string" || !NOTIFICATION_TAG_PATTERN.test(tag)) {
    throw new Error("invalid_tag: a notification tag matches ^[A-Za-z0-9._:-]{1,128}$");
  }
}

/** Flat, small, and never a second `url` or anything that could stand in for
 *  the confirm route's token. */
export function assertNotificationData(data: Record<string, string | number | boolean>): void {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("invalid_data: notification data is a flat object");
  }
  for (const [key, value] of Object.entries(data)) {
    if (NOTIFICATION_DATA_FORBIDDEN_KEYS.has(key)) {
      throw new Error(`invalid_data: the key \`${key}\` is not allowed in notification data`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`invalid_data: notification data is flat — \`${key}\` must be a string, number or boolean`);
    }
  }
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > NOTIFICATION_DATA_MAX_BYTES) {
    throw new Error("invalid_data: notification data is at most 1 KB serialised");
  }
}

/** Runs every guard that applies to the fields the input actually carries. */
function assertNotificationLinkFields(input: DispatchInput): void {
  if (input.url !== undefined) assertNotificationLink(input.url);
  if (input.tag !== undefined) assertNotificationTag(input.tag);
  if (input.data !== undefined) assertNotificationData(input.data);
}

/** The link fields as they appear on a wire payload — present only when set,
 *  so a notification without a link keeps yesterday's exact toast shape. */
function linkFields(input: DispatchInput): {
  url?: string;
  data?: Record<string, string | number | boolean>;
  tag?: string;
} {
  return {
    ...(input.url !== undefined ? { url: input.url } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
    ...(input.tag !== undefined ? { tag: input.tag } : {}),
  };
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
  // WARP-2909 — the same guards `sendNotification` throws on, degraded here
  // to keep the never-throws contract: a bad link drops url/data/tag from the
  // payload and the toast still goes out, with `toast: invalid_link` in
  // `errors` so the caller can stamp it on the row (the diagnosable place).
  let link: ReturnType<typeof linkFields> = {};
  try {
    assertNotificationLinkFields(input);
    link = linkFields(input);
  } catch (err) {
    logger.warn({ err, userId: input.userId }, "notification link dropped from toast");
    errors.push("toast: invalid_link");
  }
  // Channel 1: toast. Always attempted because the ws-bridge is the cheapest
  // delivery path and the user always has a dashboard tab nearby.
  const toastOk = safePublish(`droplet/notifications/${input.userId}`, {
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    at: new Date().toISOString(),
    ...link,
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
  // WARP-2909 — before the row write: the activity-notify caller is inside a
  // transaction, so a throw here aborts before anything commits.
  assertNotificationLinkFields(input);
  const row = await db.notificationLog.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      url: input.url ?? null,
      data: input.data,
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
  // WARP-2909 — before the toast and before any transport. A caller that
  // authors a bad link gets the throw; nothing is published and nothing is
  // written, so a lure never reaches a tray or the log.
  assertNotificationLinkFields(input);
  const { channels, errors } = publishNotificationToast(input);

  // Channel 2: web push. The toast only exists while a tab is open, so without
  // this a notification raised at 3am is gone by morning — the log row survives
  // but nothing renders it.
  //
  // Best-effort like the toast, and for the same reason: a push service being
  // slow or a keypair being unconfigured must never fail the caller's write.
  // The difference is that push failures are RECORDED rather than swallowed, so
  // "delivered: false" on a box with subscribers is diagnosable.
  //
  // A push failure is held SEPARATELY from `errors` and only folded in when
  // NOTHING delivered. `error` on the log row answers "why did this not
  // arrive"; a box with no push subscriptions at all is the normal case, and
  // letting that populate `error` on every successful toast would make the
  // column uniformly non-null — at which point a real failure is invisible in
  // exactly the place someone would look for it.
  let pushError: string | null = null;
  try {
    await ensurePushDispatch(prisma);
    // WARP-2909 — url/data/tag ride along; `tag` is only ever the caller's
    // (no default is derived — the log row does not exist yet at this point).
    const { sent } = await dispatchToUser(prisma, input.userId, {
      title: input.title,
      body: input.body ?? "",
      url: input.url,
      data: input.data,
      tag: input.tag,
    });
    if (sent > 0) channels.push("push");
  } catch (err) {
    pushError = `push: ${err instanceof Error ? err.message : String(err)}`;
    // Always visible to an operator, whether or not it reaches the row.
    logger.warn({ err, userId: input.userId }, "push notification failed");
  }
  if (pushError && channels.length === 0) errors.push(pushError);

  const delivered = channels.length > 0;
  const log = await prisma.notificationLog.create({
    data: {
      userId: input.userId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      url: input.url ?? null,
      data: input.data,
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
    /** WARP-2909 — the deep link and its flat data, null when the row has none. */
    url: string | null;
    data: Prisma.JsonValue | null;
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
