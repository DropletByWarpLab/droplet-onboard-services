/**
 * Web Push fan-out for camera detection events.
 *
 * Architecture:
 *   1. On orchestrator boot, configure web-push with a VAPID keypair.
 *      Keys come from VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY env vars.
 *      If absent, we generate a pair on first boot and log them so
 *      the operator can pin them in .env (regenerating breaks every
 *      existing subscription, so we don't auto-rotate).
 *   2. The dashboard subscribes via the service worker, POSTs the
 *      endpoint + keys to /api/devices/push/subscribe, which inserts
 *      into the PushSubscription table.
 *   3. When a Frigate detection event arrives via MQTT, the camera
 *      service calls dispatchToInterestedUsers — we look up which
 *      users have a CameraNotificationPref matching the event's
 *      label, and web-push to each of their PushSubscription rows.
 *   4. A 410 Gone or 404 Not Found from the push service means the
 *      subscription is dead — we delete it.
 *
 * Why Web Push (vs FCM/APNS native)? It's the W3C standard, browsers
 * support it natively, iOS 16.4+ supports it for installed PWAs, and
 * the Android Droplet app can register a service worker if it uses a
 * webview shell. Native FCM/APNS wiring is left for a future PR
 * (those need platform-specific server keys + auth dances).
 */

import webpush from "web-push";
import type { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import {
  assertPushDestination,
  vetPushEndpoint,
  type VettedPushEndpoint,
} from "../lib/push-endpoint.js";
import { webPushGate } from "./off-lan-gate.service.js";
import { recordActivity } from "./activity.singleton.js";
import { canAccessCamera } from "./camera-access.service.js";
// WARP-2911 — the leaf, never notifications.service (which imports this module).
import { assertRecipientIsUsername } from "./notification-recipient.js";

const logger = createLogger("push-dispatch");

let configured = false;
let publicKey: string | null = null;

/**
 * Initialise web-push with VAPID keys. Reads from env; if absent, we
 * generate a pair, log it once at startup, and use it in-process.
 * The operator should pin the logged keys in .env so a restart doesn't
 * break every subscriber — without that, every restart is the moral
 * equivalent of a forced re-pair.
 */
export function initPushDispatch(): void {
  if (configured) return;
  let pub = config.VAPID_PUBLIC_KEY;
  let priv = config.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    logger.warn(
      {
        VAPID_PUBLIC_KEY: pub,
        VAPID_PRIVATE_KEY: priv,
      },
      "Generated ephemeral VAPID keypair. Pin these in .env to keep subscriptions across restarts.",
    );
  }
  webpush.setVapidDetails(
    `mailto:${config.VAPID_CONTACT_EMAIL || "ops@droplet.local"}`,
    pub,
    priv,
  );
  publicKey = pub;
  configured = true;
}

/**
 * WARP-2752 (ADR-051) — PERSIST the generated keypair, so a restart stops
 * silently unsubscribing everyone.
 *
 * The sync `initPushDispatch` above generates an ephemeral pair when the env
 * vars are absent and tells the operator to pin them. Nobody does: `VAPID` does
 * not appear anywhere in `scripts/` or `docker/`, so no shipped box has ever
 * had them set, which means every orchestrator restart rotates the keypair and
 * invalidates every existing `PushSubscription`. Push has therefore never
 * worked across a restart for anyone.
 *
 * This stores the generated pair in `SystemFlag` on first use and reads it back
 * on every subsequent boot. ENV STILL WINS: an operator who pins the keys keeps
 * exactly today's behaviour, and this only fills the gap where the alternative
 * was a fresh key every boot.
 *
 * ON KEEPING A PRIVATE KEY IN THE DATABASE. It is consistent with what is
 * already there — `PushSubscription` rows hold each subscriber's own keys in
 * cleartext in the same database. The blast radius is bounded: a VAPID private
 * key lets a holder SEND pushes to this box's subscribers, it does not decrypt
 * anything (payload encryption uses the subscription's keys, not this one).
 * Env remains the right place for an operator who wants it out of the DB.
 */
const VAPID_FLAG_KEY = "push.vapid";

export async function ensurePushDispatch(prisma: PrismaClient): Promise<void> {
  if (configured) return;

  // An operator-pinned pair always wins, and needs no DB round trip.
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
    initPushDispatch();
    return;
  }

  const existing = await prisma.systemFlag.findUnique({ where: { key: VAPID_FLAG_KEY } });
  const stored = existing?.valueJson as { publicKey?: string; privateKey?: string } | null;
  if (stored?.publicKey && stored?.privateKey) {
    webpush.setVapidDetails(
      `mailto:${config.VAPID_CONTACT_EMAIL || "ops@droplet.local"}`,
      stored.publicKey,
      stored.privateKey,
    );
    publicKey = stored.publicKey;
    configured = true;
    return;
  }

  const keys = webpush.generateVAPIDKeys();
  // `create` rather than `upsert`, and a caught conflict rather than a lock:
  // two orchestrator instances racing on first boot must converge on ONE pair,
  // and the loser has to adopt the winner's rather than overwrite it — an
  // overwrite here would invalidate the subscriptions the winner just accepted.
  try {
    await prisma.systemFlag.create({
      data: { key: VAPID_FLAG_KEY, valueJson: { publicKey: keys.publicKey, privateKey: keys.privateKey } },
    });
    publicKey = keys.publicKey;
    webpush.setVapidDetails(
      `mailto:${config.VAPID_CONTACT_EMAIL || "ops@droplet.local"}`,
      keys.publicKey,
      keys.privateKey,
    );
    configured = true;
    logger.info("Generated and persisted a VAPID keypair; subscriptions now survive restarts.");
  } catch {
    const raced = await prisma.systemFlag.findUnique({ where: { key: VAPID_FLAG_KEY } });
    const won = raced?.valueJson as { publicKey?: string; privateKey?: string } | null;
    if (won?.publicKey && won?.privateKey) {
      webpush.setVapidDetails(
        `mailto:${config.VAPID_CONTACT_EMAIL || "ops@droplet.local"}`,
        won.publicKey,
        won.privateKey,
      );
      publicKey = won.publicKey;
      configured = true;
      return;
    }
    // Could not persist and could not read one back — fall through to the
    // ephemeral path rather than leaving push unconfigured. Degraded, loudly.
    initPushDispatch();
  }
}

export function getPublicVapidKey(): string {
  if (!configured) initPushDispatch();
  if (!publicKey) throw new Error("VAPID not configured");
  return publicKey;
}

export interface PushPayload {
  title: string;
  body: string;
  /** URL the dashboard should open when the operator taps the
   *  notification (e.g. `/cameras/front_door`). */
  url?: string;
  /** Frigate event ID — lets the service worker tag the notification
   *  so opening multiple events doesn't stack a thousand entries. */
  tag?: string;
  /** Authenticated proxy URL for a thumbnail so the notification
   *  shows a preview image. Same-origin so the SW fetches with the
   *  session cookie. */
  imageUrl?: string;
  data?: Record<string, unknown>;
  /** WARP-2804 — the NotificationLog row this push is for. The service worker
   *  acknowledges it (`POST /api/notifications/<id>/ack {via:'opened'}`) when
   *  the person taps the notification. Absent on the camera detection
   *  fan-out, which writes no row. */
  notificationId?: string;
}

/** WARP-2904 — what one push dial (or refusal) did, for the audit row. */
type PushEgressOutcome =
  | "allowed"
  | "refused_gate"
  | "refused_endpoint"
  | "pruned"
  | "provider_error";

/**
 * WARP-2904 — one signed `network` activity row per dial and per refusal, the
 * `routes/web.ts` egress-audit idiom, so /admin/audit shows push beside
 * weather and mail. Fire-and-forget and fail-soft (`recordActivity` swallows).
 *
 * Carries the endpoint's HOST only: the full endpoint is a per-subscriber
 * capability URL (anyone holding it plus the keys can push to that browser),
 * and the payload never appears here at all.
 */
function auditPushEgress(userId: string, outcome: PushEgressOutcome, host?: string): void {
  recordPushEgress(outcome, { userId, ...(host ? { dst: host } : {}) }, host);
}

/** The signed `network` row itself — shared by the per-recipient rows above
 *  and the one-per-event camera refusal below. */
function recordPushEgress(
  outcome: PushEgressOutcome,
  refs: Record<string, string | number>,
  host?: string,
): void {
  void recordActivity({
    kind: "network",
    severity: outcome === "allowed" ? "info" : "warn",
    sourceIcon: "globe",
    what: host ? `Web push: ${host}` : "Web push",
    sub: "web_push",
    refs: { channel: "web_push", outcome, ...refs },
    actor: { type: "system", id: null },
  });
}

/**
 * WARP-2904: the endpoint check at DIAL time. The subscribe route runs the
 * same structural check at registration, but rows stored before that check
 * existed are never otherwise re-checked. Here the host is also resolved,
 * so a push-service name that resolves inside the boundary is refused.
 * Returns the vetted endpoint (the host web-push will actually connect to,
 * plus the normalised URL to dial), or null when it may not be dialled.
 * See lib/push-endpoint.ts for why this is not plain `assertOutboundUrlAllowed`.
 */
async function dialableEndpoint(endpoint: string): Promise<VettedPushEndpoint | null> {
  try {
    const vetted = vetPushEndpoint(endpoint);
    await assertPushDestination(vetted);
    return vetted;
  } catch {
    return null;
  }
}

/** A dial that never answers must not stall the caller (the reminders poller
 *  awaits each send in turn). */
const PUSH_DIAL_TIMEOUT_MS = 10_000;

export interface DispatchOutcome {
  sent: number;
  pruned: number;
  /** Dials actually attempted — 0 with no `refused` means "no subscribers". */
  attempted: number;
  /** Set when the `web_push` off-LAN channel refused the whole dispatch. */
  refused?: "egress_disabled";
}

/**
 * Send a push to every active subscription for `username` — the recipient's
 * Nextcloud username (`User.username`), never `User.id` (WARP-2911): that is
 * what `PushSubscription.username` stores. Subscriptions
 * that come back with 404 or 410 are deleted — those are the standard
 * "this endpoint is dead, give up" status codes per the Web Push spec.
 *
 * WARP-2904 — this is the ONE dial site for web push, so the `web_push`
 * off-LAN gate is read here, on every call, before a single subscription is
 * loaded: sendNotification, the camera fan-out and the test button are all
 * covered by it. A refusal is DATA (`refused`), never a throw — every caller
 * treats push as best-effort and must not start failing its own write.
 */
export async function dispatchToUser(
  prisma: PrismaClient,
  username: string,
  payload: PushPayload,
): Promise<DispatchOutcome> {
  // WARP-2911 — FIRST, before the gate: a `User.id` here is a caller bug, not
  // a refused dial, and this function has callers (the camera fan-out, the
  // push test button) that never pass through sendNotification's own check.
  assertRecipientIsUsername("dispatchToUser", username);
  if (!(await webPushGate(prisma))) {
    // Audit a refusal only when there was something to refuse. Push ships
    // off, so an unconditional row here would mean one signed warning per
    // notification (and per camera detection) on every box where nobody
    // has even subscribed. Only a COUNT: no subscription row is loaded
    // while the gate is closed. If the count cannot be read, the refusal is
    // audited anyway.
    const pending = await prisma.pushSubscription
      .count({ where: { username } })
      .catch(() => 1);
    if (pending > 0) auditPushEgress(username, "refused_gate");
    return { sent: 0, pruned: 0, attempted: 0, refused: "egress_disabled" };
  }
  if (!configured) initPushDispatch();
  const rows = await prisma.pushSubscription.findMany({ where: { username } });

  // Refuse (and prune) any stored endpoint that fails the push-endpoint guard.
  const blocked: string[] = [];
  const subs: Array<(typeof rows)[number] & VettedPushEndpoint> = [];
  for (const r of rows) {
    const vetted = await dialableEndpoint(r.endpoint);
    if (vetted) subs.push({ ...r, ...vetted });
    else {
      blocked.push(r.endpoint);
      auditPushEgress(username, "refused_endpoint");
    }
  }

  const body = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;
  const deadEndpoints: string[] = [...blocked];

  // Fan out in parallel — each push call is independent, and waiting
  // serially would compound latency on a slow push service.
  await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          {
            // The NORMALISED url, never the raw row: its host is the one
            // that was vetted and the one the audit row names.
            endpoint: s.url,
            keys: { p256dh: s.p256dhKey, auth: s.authKey },
          },
          body,
          // TTL: best-effort, stale notifications past 1 min are useless.
          { TTL: 60, timeout: PUSH_DIAL_TIMEOUT_MS },
        );
        sent++;
        auditPushEgress(username, "allowed", s.host);
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          deadEndpoints.push(s.endpoint);
          auditPushEgress(username, "pruned", s.host);
        } else {
          auditPushEgress(username, "provider_error", s.host);
          logger.warn({ err, host: s.host }, "push send failed");
        }
      }
    }),
  );

  if (deadEndpoints.length > 0) {
    pruned = (
      await prisma.pushSubscription.deleteMany({
        where: { endpoint: { in: deadEndpoints } },
      })
    ).count;
  }
  if (subs.length === 0) return { sent, pruned, attempted: 0 };
  // Non-blocking: bump lastFiredAt for monitoring. Failure here is fine.
  prisma.pushSubscription
    .updateMany({
      where: { username, endpoint: { notIn: deadEndpoints } },
      data: { lastFiredAt: new Date() },
    })
    .catch(() => {});
  return { sent, pruned, attempted: subs.length };
}

/**
 * Fan out a detection event to every user who has a notification pref
 * matching the event's label on the event's camera. This is the
 * orchestrator-side glue between MQTT detection events and Web Push
 * — the camera service calls it from its MQTT handler.
 */
export async function dispatchDetectionEvent(
  prisma: PrismaClient,
  ev: {
    eventId: string;
    cameraName: string;
    label: string;
    score: number;
    thumbnailUrl?: string;
  },
): Promise<void> {
  // Find every user who has a CameraNotificationPref enabled for this
  // event's label. Frigate labels map to per-pref booleans:
  //   person  → onPerson
  //   car/truck/bus/motorcycle → onVehicle
  //   dog/cat/bird/cow/horse → onAnimal
  //   (anything else)  → onMotion
  const VEHICLE_LABELS = new Set(["car", "truck", "bus", "motorcycle"]);
  const ANIMAL_LABELS = new Set(["dog", "cat", "bird", "cow", "horse", "sheep"]);
  const labelKey = (label: string): keyof {
    onPerson: boolean;
    onVehicle: boolean;
    onAnimal: boolean;
    onMotion: boolean;
  } => {
    if (label === "person") return "onPerson";
    if (VEHICLE_LABELS.has(label)) return "onVehicle";
    if (ANIMAL_LABELS.has(label)) return "onAnimal";
    return "onMotion";
  };
  const camera = await prisma.camera.findUnique({
    where: { name: ev.cameraName },
  });
  if (!camera) return; // Frigate-only camera, no DB row → no per-user prefs.

  const prefField = labelKey(ev.label);
  const interestedPrefs = await prisma.cameraNotificationPref.findMany({
    where: {
      cameraId: camera.id,
      [prefField]: true,
    },
  });
  if (interestedPrefs.length === 0) return;

  // WARP-2982: a pref is not access. Re-check each recipient against the
  // per-camera grants at send time, so a person whose access was revoked
  // (or whose role dropped below owner/admin) stops being told what this
  // camera sees. Fail closed per user: an unknown user gets nothing.
  //
  // WARP-2911: the pref names its person by `User.id`; web push is keyed by
  // `PushSubscription.username`. The username is selected here and is what
  // `dispatchToUser` gets — handing it the pref's id matched no subscription
  // on any box where the two differ, so detections reached nobody's phone.
  const users = await prisma.user.findMany({
    where: { id: { in: interestedPrefs.map((p) => p.userId) } },
    select: { id: true, role: true, username: true },
  });
  const allowed: typeof users = [];
  for (const u of users) {
    if (await canAccessCamera(prisma, u, ev.cameraName)) allowed.push(u);
  }
  if (allowed.length === 0) return;

  // WARP-2911 — the `web_push` gate is read ONCE per detection. `web_push`
  // ships off and detections are the most frequent sender, so letting each
  // recipient's `dispatchToUser` discover the closed gate wrote one signed
  // refusal row per subscribed recipient per detection. Closed: at most ONE
  // row for the event (and none when nobody is subscribed — push ships off,
  // so "nothing to refuse" is the normal case), no subscription loaded,
  // nothing dialled. Open: `dispatchToUser` still reads the gate itself, per
  // recipient — it is the one dial site and keeps that contract.
  if (!(await webPushGate(prisma))) {
    const usernames = allowed.map((u) => u.username);
    const pending = await prisma.pushSubscription
      .count({ where: { username: { in: usernames } } })
      .catch(() => 1);
    if (pending > 0) {
      recordPushEgress("refused_gate", {
        source: "camera_detection",
        camera: ev.cameraName,
        subscriptions: pending,
      });
    }
    return;
  }

  const cameraDisplay = camera.displayName || ev.cameraName.replace(/_/g, " ");
  const payload: PushPayload = {
    title: `${ev.label[0].toUpperCase()}${ev.label.slice(1)} detected`,
    body: `${cameraDisplay} · ${Math.round(ev.score * 100)}% confidence`,
    url: `/cameras/${encodeURIComponent(ev.cameraName)}`,
    tag: `event-${ev.eventId}`,
    imageUrl: ev.thumbnailUrl,
    data: { eventId: ev.eventId, camera: ev.cameraName, label: ev.label },
  };

  // Fan out per-user. We don't bother awaiting individual results —
  // dispatchToUser handles its own pruning, and the SSE handler that
  // called us is already fire-and-forget.
  for (const recipient of allowed) {
    void dispatchToUser(prisma, recipient.username, payload).catch((err) =>
      logger.warn({ err, username: recipient.username }, "push dispatch user-failed"),
    );
  }
}
