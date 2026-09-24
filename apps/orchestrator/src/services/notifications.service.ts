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
 *
 * WARP-2804 — RECORD, THEN DELIVER, and the recipient can acknowledge it.
 * `sendNotification` = `recordNotification` (the row, queued) followed by
 * `deliverNotification(id)` (toast + push, then the outcome stamped on that
 * row). The row exists before any transport, so the toast carries its `id`
 * and the push its `notificationId`: a client can acknowledge exactly what it
 * shows. A crash mid-send leaves a queued row the user can find, never a toast
 * with no row behind it. `ackNotification` / `ackAllNotifications` /
 * `countUnread` / `listNotifications` are the recipient's side (routes N1-N4).
 */

import type { $Enums, Prisma, PrismaClient } from "@prisma/client";
import { publish } from "./mqtt.service.js";
import { dispatchToUser, ensurePushDispatch } from "./push-dispatch.service.js";
import { assertRecipientIsUsername } from "./notification-recipient.js";
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

/** WARP-2804 — derived from the Prisma enums, like `NotificationKind`. */
export type NotificationAckState = $Enums.NotificationAckState;
export type NotificationAckMethod = $Enums.NotificationAckMethod;

export interface DispatchInput {
  /** WARP-2911 — the recipient's Nextcloud username (`User.username`), NEVER
   *  `User.id`. It is the key at every hop: the toast topic
   *  `droplet/notifications/<username>` (ws-bridge subscribes on the username
   *  only), the `PushSubscription.username` lookup, and both
   *  `NotificationLog.username` readers. A `User.id` here reaches nobody, so
   *  every entry point refuses one (`NOTIFICATION_RECIPIENT_IS_ID`, below) and
   *  `__tests__/notification-recipient.guard.test.ts` sweeps every call site. */
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
//
// The check, the error and its shape live in `./notification-recipient.ts` (a
// leaf: push-dispatch runs the same check, and this module imports
// push-dispatch). The shape itself is `@droplet/auth-policy`'s — the one every
// place a username is minted refuses — so creation and refusal cannot drift.
export {
  NotificationRecipientError,
  type NotificationRecipientErrorCode,
} from "./notification-recipient.js";

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
 *
 * WARP-2804 — `id` is the NotificationLog row this toast is for, and the
 * payload carries it so the toaster can acknowledge it. A toast is only ever
 * published for a recorded row.
 */
export function publishNotificationToast(input: DispatchInput & { id: string }): {
  channels: string[];
  errors: string[];
} {
  assertRecipientIsUsername("publishNotificationToast", input.username);
  const channels: string[] = [];
  const errors: string[] = [];
  // WARP-2909 — this function must not throw on a bad link: it DEGRADES, the
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
    id: input.id,
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
  assertRecipientIsUsername("recordNotification", input.username);
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

/** What `deliverNotification` reads back: everything a transport carries. */
const DELIVERY_SELECT = {
  id: true,
  username: true,
  kind: true,
  title: true,
  body: true,
  url: true,
  data: true,
} as const satisfies Prisma.NotificationLogSelect;

/** A stored `data` column as the flat object the transports carry. The row was
 *  validated on the way in (`recordNotification`); anything that is not an
 *  object is dropped here, and `assertLinkFields` below checks the rest. */
function storedData(data: Prisma.JsonValue | null): DispatchInput["data"] {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  return data as Record<string, string | number | boolean>;
}

export interface DeliverOptions {
  /** Web-push collapse key, `^[A-Za-z0-9._:-]{1,128}$`. A bad one is dropped, never thrown on. */
  tag?: string;
  /** WARP-2978 (ADR-059 P3 §B.6.7) fills this. Accepted and ignored here. */
  priority?: string;
}

/**
 * WARP-2804 — the DELIVERY half: transport one recorded row, by id.
 *
 *   1. Read the row (`id, username, kind, title, body, url, data`).
 *   2. Publish the toast with its `id`.
 *   3. Web push to the row's recipient with `notificationId: id`.
 *   4. Stamp `channels`, `deliveredAt`, `error` and `pushOutcome` on the row.
 *
 * Never throws on TRANSPORT — both channels are best-effort — and a stamp that
 * cannot be written is logged, not thrown: the notification already went out,
 * and the row stays queued and findable. Throws only when the row cannot be
 * read; then there is nothing to deliver, and nothing is published.
 */
export async function deliverNotification(
  prisma: PrismaClient,
  id: string,
  opts: DeliverOptions = {},
): Promise<DispatchResult> {
  const row = await prisma.notificationLog.findUnique({ where: { id }, select: DELIVERY_SELECT });
  if (!row) throw new Error(`notification_not_found: ${id}`);

  // WARP-2909 — delivery must not throw, so a link that fails the check
  // DEGRADES: both transports go without it, and the toast half records why.
  let link: Pick<DispatchInput, "url" | "data" | "tag"> = {
    url: row.url ?? undefined,
    data: storedData(row.data),
    tag: opts.tag,
  };
  try {
    assertLinkFields({ username: row.username, kind: row.kind, title: row.title, ...link });
  } catch {
    link = {};
  }

  const { channels, errors } = publishNotificationToast({
    id: row.id,
    username: row.username,
    kind: row.kind,
    title: row.title,
    body: row.body,
    url: link.url,
    data: link.data,
  });

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
    const { sent, attempted, refused } = await dispatchToUser(prisma, row.username, {
      title: row.title,
      body: row.body ?? "",
      url: link.url,
      data: link.data,
      tag: link.tag,
      notificationId: row.id,
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
    logger.warn({ err, username: row.username }, "push notification failed");
  }
  if (pushError && channels.length === 0) errors.push(pushError);

  const delivered = channels.length > 0;
  const error = errors.length > 0 ? errors.join(" | ") : null;
  try {
    await prisma.notificationLog.update({
      where: { id: row.id },
      data: {
        channels: channels.join(","),
        deliveredAt: delivered ? new Date() : null,
        error,
        pushOutcome,
      },
      select: { id: true },
    });
  } catch (err) {
    logger.warn({ err, id: row.id }, "notification delivery stamp failed — the row is recorded and the notification was sent");
  }

  return { id: row.id, channels, delivered, error: error ?? undefined };
}

/**
 * WARP-2804 — record, then deliver. Every caller keeps this signature.
 *
 * A `User.id` recipient or a bad link is the caller's bug (WARP-2911 /
 * WARP-2909): refused before the row and before any transport. A row that
 * cannot be written throws, and nothing is published.
 */
export async function sendNotification(
  prisma: PrismaClient,
  input: DispatchInput,
): Promise<DispatchResult> {
  assertRecipientIsUsername("sendNotification", input.username);
  assertLinkFields(input);
  const { id } = await recordNotification(prisma, input);
  return deliverNotification(prisma, id, { tag: input.tag });
}

/**
 * WARP-2911 — a `system` notification to every owner and admin, by username,
 * contained PER RECIPIENT: one refused or failed send (e.g. an account whose
 * username predates the ban on the `User.id` shape) is logged and skipped,
 * and never costs the recipients after it the alert. The OTA apply path's
 * `notifyOwners` (index.ts) is this.
 */
export async function notifyOwnersAndAdmins(
  prisma: PrismaClient,
  title: string,
  body: string,
): Promise<{ notified: string[]; failed: string[] }> {
  const owners = await prisma.user.findMany({
    where: { role: { in: ["owner", "admin"] } },
    select: { username: true },
  });
  const notified: string[] = [];
  const failed: string[] = [];
  for (const { username } of owners) {
    try {
      await sendNotification(prisma, { username, kind: "system", title, body });
      notified.push(username);
    } catch (err) {
      failed.push(username);
      logger.error({ err, username, title }, "owner/admin alert to one recipient failed — continuing with the rest");
    }
  }
  return { notified, failed };
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

// ── WARP-2804: the recipient's side ─────────────────────────────────────────

/**
 * What a client may see of its own notification rows (N1's `NotificationRow`).
 * An EXPLICIT select, so a column added later is not exposed by default. The
 * two device facts of an ack (`ackSessionId`, `ackClient`) are never returned:
 * they are the box's record of the ack, not something to hand back to any
 * client that asks.
 */
export const NOTIFICATION_ROW_SELECT = {
  id: true,
  kind: true,
  title: true,
  body: true,
  url: true,
  data: true,
  channels: true,
  deliveredAt: true,
  error: true,
  pushOutcome: true,
  createdAt: true,
  ackState: true,
  ackedAt: true,
  ackMethod: true,
} as const satisfies Prisma.NotificationLogSelect;

export type NotificationRow = Prisma.NotificationLogGetPayload<{ select: typeof NOTIFICATION_ROW_SELECT }>;

export const NOTIFICATION_LIST_MAX = 200;

/** `<createdAt ms>.<id>` — the keyset position of the last row of a page. */
const CURSOR_RE = /^(\d{1,15})\.([A-Za-z0-9_-]{1,64})$/;

export function encodeNotificationCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.getTime()}.${row.id}`;
}

/** The cursor's position, or null when it is not one this module minted. */
export function parseNotificationCursor(cursor: string): { at: Date; id: string } | null {
  const m = CURSOR_RE.exec(cursor);
  if (!m) return null;
  const at = new Date(Number(m[1]));
  return Number.isNaN(at.getTime()) ? null : { at, id: m[2]! };
}

export interface ListNotificationsOptions {
  /** 1–200, default 50. */
  limit?: number;
  /** From `nextCursor` of the previous page. An unparseable one throws `invalid_cursor`. */
  cursor?: string | null;
  /** `unacked`: unread only. Default `all`. */
  state?: "unacked" | "all";
}

/**
 * The recipient's notifications, newest first, keyset-paged on
 * `(createdAt desc, id desc)` so a row arriving between pages never shifts or
 * repeats one. `nextCursor` is null on the last page.
 */
export async function listNotifications(
  prisma: PrismaClient,
  username: string,
  opts: ListNotificationsOptions = {},
): Promise<{ rows: NotificationRow[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(NOTIFICATION_LIST_MAX, Math.trunc(opts.limit ?? 50) || 1));
  let after: { at: Date; id: string } | null = null;
  if (opts.cursor) {
    after = parseNotificationCursor(opts.cursor);
    if (!after) throw new Error("invalid_cursor");
  }
  const rows = await prisma.notificationLog.findMany({
    where: {
      username,
      ...(opts.state === "unacked" ? { ackState: "unacked" as const } : {}),
      ...(after
        ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: NOTIFICATION_ROW_SELECT,
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodeNotificationCursor(page[page.length - 1]!) : null;
  return { rows: page, nextCursor };
}

/**
 * The device facts of one acknowledgement (spec §A.2). `sessionId` is the
 * JWT `sid` — PROVEN: authMiddleware checks the session record on every
 * request that carries one — or null for a token without one (grace/legacy).
 * `client` is `describeClient(...)` — REPORTED, never proof — or null.
 */
export interface AckAttribution {
  sessionId: string | null;
  client: string | null;
}

export interface AckNotificationInput extends AckAttribution {
  id: string;
  /** The acting person's USERNAME. Only the recipient can ack: it is in the where-clause. */
  username: string;
  /** `all` is ack-all's alone; `incident` is WARP-2978's. The routes pass `inbox` or `opened`. */
  method: Exclude<NotificationAckMethod, "all">;
}

/**
 * WARP-2804 — the recipient acknowledges one notification.
 *
 *   - Only the recipient: `username` is in BOTH where-clauses, so someone
 *     else's id acks nothing and reads nothing — it answers exactly like a
 *     missing id (null → the route's 404), never confirming the row exists.
 *   - First ack wins and is idempotent: the update only matches a row that is
 *     not yet acked, so a second ack changes nothing (`changed: false`) and the
 *     original `ackedAt` / `ackMethod` / sign-in stand.
 *   - `untracked` rows (written before WARP-2804) can be acked.
 *
 * Returns the row as `NotificationRow` (never the device facts), or null.
 */
export async function ackNotification(
  db: NotificationDb,
  input: AckNotificationInput,
): Promise<{ changed: boolean; row: NotificationRow } | null> {
  const { count } = await db.notificationLog.updateMany({
    where: { id: input.id, username: input.username, ackState: { in: ["unacked", "untracked"] } },
    data: {
      ackState: "acked",
      ackedAt: new Date(),
      ackMethod: input.method,
      ackSessionId: input.sessionId,
      ackClient: input.client,
    },
  });
  const row = await db.notificationLog.findFirst({
    where: { id: input.id, username: input.username },
    select: NOTIFICATION_ROW_SELECT,
  });
  if (!row) return null;
  return { changed: count === 1, row };
}

export interface AckAllInput extends AckAttribution {
  username: string;
  /** The newest `createdAt` the client showed. A row created after it is never swept. */
  before: Date;
}

/**
 * WARP-2804 — "mark all read": the recipient's `unacked` rows created at or
 * before `before`, with `ackMethod: 'all'`.
 *
 * `before` is required so a notification that arrived after the person looked
 * is never swept unseen. `untracked` rows are left alone — they were never
 * unread — and an acked row keeps its first ack. Returns how many it acked and
 * the unread count left over (what the badge should now say).
 */
export async function ackAllNotifications(
  db: NotificationDb,
  input: AckAllInput,
): Promise<{ acked: number; unread: number }> {
  const { count } = await db.notificationLog.updateMany({
    where: { username: input.username, ackState: "unacked", createdAt: { lte: input.before } },
    data: {
      ackState: "acked",
      ackedAt: new Date(),
      ackMethod: "all",
      ackSessionId: input.sessionId,
      ackClient: input.client,
    },
  });
  return { acked: count, unread: await countUnread(db, input.username) };
}

/** WARP-2804 — the badge: the recipient's `unacked` rows. Never `untracked`, never `acked`. */
export function countUnread(db: NotificationDb, username: string): Promise<number> {
  return db.notificationLog.count({ where: { username, ackState: "unacked" } });
}
