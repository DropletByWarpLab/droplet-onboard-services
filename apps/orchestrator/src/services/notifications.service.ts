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
  /** WARP-2911 — the recipient's Nextcloud username (`User.username`), NEVER
   *  `User.id`. It is the key at every hop: the toast topic
   *  `droplet/notifications/<username>` (ws-bridge subscribes on the username
   *  only), the `PushSubscription.username` lookup, and both
   *  `NotificationLog.username` readers. A `User.id` here reaches nobody, so
   *  every entry point refuses one (`NOTIFICATION_RECIPIENT_IS_ID`, below). */
  username: string;
  kind: NotificationKind;
  title: string;
  body?: string | null;
  /** WARP-2909 — where a tap/click should take the person: a same-origin
   *  dashboard PATH (`/workshop?run=<id>`), never an absolute URL. Checked by
   *  `assertNotificationLink`. Each native sender maps it to its own key
   *  (iOS `deepLink`, Android `data["url"]`). */
  url?: string;
  /** WARP-2909 — small, FLAT, PHI-free context for clients. A notification
   *  payload is copied to third-party push services and OS notification
   *  stores, so this must never carry customer data, a token or a binding
   *  hash — `assertNotificationData` refuses those keys, nesting, and > 1 KB. */
  data?: Record<string, string | number | boolean>;
  /** WARP-2909 — collapse key (web push `tag`): repeated notifications with
   *  one tag replace each other in the tray. `^[A-Za-z0-9._:-]{1,128}$`. */
  tag?: string;
}

// ── WARP-2909: the deep-link validators ─────────────────────────────────────

const MAX_LINK_LENGTH = 512;
const MAX_DATA_BYTES = 1024;
const TAG_RE = /^[A-Za-z0-9._:-]{1,128}$/;
/** `url` is refused because the service worker merges `data` into the
 *  notification data it opens on click — a `data.url` must never be able to
 *  stand in for the validated `url` (sw.js also spreads it first, belt and
 *  braces). The rest are the confirmation secrets a parked run must never leak. */
const FORBIDDEN_DATA_KEYS = new Set(["url", "token", "confirmationToken", "bindingHash", "pendingBindingHash"]);

/** Throws unless `url` is a same-origin path: one leading `/`, no scheme, no
 *  protocol-relative `//host`, no backslash (browsers read `/\host` as
 *  `//host`), no CR/LF/NUL, at most 512 chars. */
export function assertNotificationLink(url: string): void {
  if (
    typeof url !== "string" ||
    url.length === 0 ||
    url.length > MAX_LINK_LENGTH ||
    !url.startsWith("/") ||
    url.startsWith("//") ||
    /[\\\r\n\0]/.test(url)
  ) {
    throw new Error("invalid_notification_link");
  }
}

export function assertNotificationData(data: Record<string, unknown>): void {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("invalid_notification_data");
  }
  for (const [k, v] of Object.entries(data)) {
    if (FORBIDDEN_DATA_KEYS.has(k)) throw new Error(`invalid_notification_data: forbidden key ${k}`);
    if (!["string", "number", "boolean"].includes(typeof v)) {
      throw new Error("invalid_notification_data: not flat");
    }
  }
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_DATA_BYTES) {
    throw new Error("invalid_notification_data: too large");
  }
}

// ── WARP-2911: the recipient is a username ──────────────────────────────────

/** The shape of a `User.id` (`@default(uuid())`). No username has it — a
 *  Nextcloud login, `dev`, a `_service:*` identity — so a recipient that
 *  matches is an id handed to the username slot. */
const USER_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type NotificationRecipientErrorCode = "NOTIFICATION_RECIPIENT_IS_ID";

/**
 * WARP-2911 — a caller handed a `User.id` where the recipient's USERNAME goes.
 *
 * A PROGRAMMING error, and deliberately a throw rather than a `logger.warn`:
 * the failure it replaces was silent and total (the broker drops the toast,
 * no PushSubscription matches, no reader can see the row), and it shipped
 * three times (WARP-2783, WARP-2813, WARP-2910) because a warning nobody reads
 * is what silence already looked like. `caller` is the first stack frame
 * outside this module — the file that passed the id — so the log line says
 * where to look. Not in the error handler's trusted set: a route that throws
 * it answers a generic 500.
 */
export class NotificationRecipientError extends Error {
  readonly code: NotificationRecipientErrorCode;
  /** `fn (path/to/caller.ts:line:col)`, or null when no frame is available. */
  readonly caller: string | null;

  constructor(code: NotificationRecipientErrorCode, message: string, caller: string | null) {
    super(message);
    this.name = "NotificationRecipientError";
    this.code = code;
    this.caller = caller;
  }

  static isId(entryPoint: string, caller: string | null): NotificationRecipientError {
    return new NotificationRecipientError(
      "NOTIFICATION_RECIPIENT_IS_ID",
      `NOTIFICATION_RECIPIENT_IS_ID: ${entryPoint} was handed a User.id as the recipient; ` +
        `it takes the recipient's User.username` +
        (caller ? ` (passed from ${caller})` : ""),
      caller,
    );
  }

  toJSON(): { name: string; code: NotificationRecipientErrorCode; message: string; caller: string | null } {
    return { name: this.name, code: this.code, message: this.message, caller: this.caller };
  }
}

/** The first stack frame that is not this module: whoever called in. */
function callerOutsideThisModule(): string | null {
  const frame = (new Error().stack ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("at ") && !line.includes("notifications.service"));
  return frame ? frame.slice("at ".length) : null;
}

/** The one check every entry point runs on the recipient. */
function assertRecipientIsUsername(entryPoint: string, input: DispatchInput): void {
  if (USER_ID_SHAPE.test(input.username)) {
    throw NotificationRecipientError.isId(entryPoint, callerOutsideThisModule());
  }
}

/** The one check every entry point runs on the optional link fields. */
function assertLinkFields(input: DispatchInput): void {
  if (input.url !== undefined) assertNotificationLink(input.url);
  if (input.data !== undefined) assertNotificationData(input.data);
  if (input.tag !== undefined && !TAG_RE.test(input.tag)) throw new Error("invalid_notification_tag");
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
 * publish the toast afterwards. Never throws on a TRANSPORT problem: the toast
 * is best-effort by design and the log row is the durable record. It does
 * throw on a caller bug — a `User.id` recipient (WARP-2911), which would
 * publish to a topic nobody subscribes to.
 */
export function publishNotificationToast(input: DispatchInput): {
  channels: string[];
  errors: string[];
} {
  assertRecipientIsUsername("publishNotificationToast", input);
  const channels: string[] = [];
  const errors: string[] = [];
  // WARP-2909 — this function must not throw, so a bad link DEGRADES: the
  // toast still goes out, without the link, and the row records why.
  let link: Pick<DispatchInput, "url" | "data"> = { url: input.url, data: input.data };
  try {
    assertLinkFields(input);
  } catch {
    link = {};
    errors.push("toast: invalid_link");
  }
  // Channel 1: toast. Always attempted because the ws-bridge is the cheapest
  // delivery path and the user always has a dashboard tab nearby.
  const toastOk = safePublish(`droplet/notifications/${input.username}`, {
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    at: new Date().toISOString(),
    ...(link.url !== undefined ? { url: link.url } : {}),
    ...(link.data !== undefined ? { data: link.data } : {}),
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
  // WARP-2909 / WARP-2911 — before the write: inside a caller's transaction a
  // throw here aborts it before anything commits.
  assertRecipientIsUsername("recordNotification", input);
  assertLinkFields(input);
  const row = await db.notificationLog.create({
    data: {
      username: input.username,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      url: input.url ?? null,
      data: input.data ?? undefined,
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
  // WARP-2911 / WARP-2909 — a `User.id` recipient or a bad link is the
  // caller's bug: refuse before any transport or row.
  assertRecipientIsUsername("sendNotification", input);
  assertLinkFields(input);
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
  //
  // WARP-2904 — the push leg's result lands in `pushOutcome`, an explicit
  // enum, so a dial refused by the `web_push` off-LAN gate is distinguishable
  // from "no subscribers" and from "the push service failed". `channels` keeps
  // its meaning ("push" only when a push was actually accepted) and a refusal
  // never reaches `error`, where a delivered toast would hide it.
  let pushError: string | null = null;
  let pushOutcome: $Enums.PushOutcome;
  try {
    await ensurePushDispatch(prisma);
    const { sent, attempted, refused } = await dispatchToUser(prisma, input.username, {
      title: input.title,
      body: input.body ?? "",
      url: input.url,
      data: input.data,
      tag: input.tag,
    });
    if (sent > 0) channels.push("push");
    pushOutcome = refused
      ? "refused_gate"
      : sent > 0
        ? "sent"
        : attempted === 0
          ? "no_subscribers"
          : "failed";
  } catch (err) {
    pushOutcome = "failed";
    pushError = `push: ${err instanceof Error ? err.message : String(err)}`;
    // Always visible to an operator, whether or not it reaches the row.
    logger.warn({ err, username: input.username }, "push notification failed");
  }
  if (pushError && channels.length === 0) errors.push(pushError);

  const delivered = channels.length > 0;
  const log = await prisma.notificationLog.create({
    data: {
      username: input.username,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      url: input.url ?? null,
      data: input.data ?? undefined,
      channels: channels.join(","),
      deliveredAt: delivered ? new Date() : null,
      error: errors.length > 0 ? errors.join(" | ") : null,
      pushOutcome,
    },
  });

  return {
    id: log.id,
    channels,
    delivered,
    error: errors.length > 0 ? errors.join(" | ") : undefined,
  };
}

/** Recent notifications for a user (by USERNAME), newest-first. Used by the
 *  "Recent notifications" panel; the LLM `list_notifications` tool reads the
 *  same column directly. */
export async function listRecentNotifications(
  prisma: PrismaClient,
  username: string,
  limit = 50,
): Promise<
  Array<{
    id: string;
    kind: string;
    title: string;
    body: string | null;
    url: string | null;
    data: Prisma.JsonValue | null;
    channels: string;
    deliveredAt: Date | null;
    error: string | null;
    createdAt: Date;
  }>
> {
  return prisma.notificationLog.findMany({
    where: { username },
    orderBy: { createdAt: "desc" },
    take: Math.max(1, Math.min(200, limit)),
  });
}
