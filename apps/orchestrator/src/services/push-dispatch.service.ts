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
}

/**
 * Send a push to every active subscription for `userId`. Subscriptions
 * that come back with 404 or 410 are deleted — those are the standard
 * "this endpoint is dead, give up" status codes per the Web Push spec.
 */
export async function dispatchToUser(
  prisma: PrismaClient,
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!configured) initPushDispatch();
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  if (subs.length === 0) return { sent: 0, pruned: 0 };

  const body = JSON.stringify(payload);
  let sent = 0;
  let pruned = 0;
  const deadEndpoints: string[] = [];

  // Fan out in parallel — each push call is independent, and waiting
  // serially would compound latency on a slow push service.
  await Promise.allSettled(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: s.endpoint,
            keys: { p256dh: s.p256dhKey, auth: s.authKey },
          },
          body,
          { TTL: 60 }, // Best-effort: stale notifications past 1 min are useless.
        );
        sent++;
      } catch (err) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          deadEndpoints.push(s.endpoint);
        } else {
          logger.warn({ err, endpoint: s.endpoint.slice(0, 60) }, "push send failed");
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
  // Non-blocking: bump lastFiredAt for monitoring. Failure here is fine.
  prisma.pushSubscription
    .updateMany({
      where: { userId, endpoint: { notIn: deadEndpoints } },
      data: { lastFiredAt: new Date() },
    })
    .catch(() => {});
  return { sent, pruned };
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
  for (const pref of interestedPrefs) {
    void dispatchToUser(prisma, pref.userId, payload).catch((err) =>
      logger.warn({ err, userId: pref.userId }, "push dispatch user-failed"),
    );
  }
}
