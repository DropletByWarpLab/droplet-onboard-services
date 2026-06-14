/**
 * Plane → orchestrator webhook receiver.
 *
 * WARP-511 — POST /api/pm/webhook accepts Plane's outgoing webhook
 * payloads (issue created, updated, transitioned, commented). Per spec
 * WARP-498 + 04-coding-standards/security-rules.md: fail-CLOSED on any
 * signature mismatch.
 *
 * Auth: HMAC-SHA256 signature header, validated using
 * DROPLET_PM_WEBHOOK_SECRET. Plane's outgoing-webhook config writes the
 * same secret to its end; both sides must match.
 *
 * Replay guard: Plane sends a `X-Plane-Delivery-Timestamp` header. We
 * reject deliveries older than REPLAY_WINDOW_MS (5 min).
 *
 * Rate limit: this route is mounted BEFORE authMiddleware, so the only
 * thing in front of it is the HMAC check. To stop an unauthenticated
 * flood from burning CPU on signature comparison (or wedging the event
 * bus), a per-IP fixed-window limiter runs FIRST, before any HMAC work.
 * It reuses the repo's `cacheIncr` Redis primitive (same posture as the
 * setup-claim limiter in routes/setup.ts) and fails OPEN on a cache
 * outage so a down Redis never blackholes legitimate Plane deliveries.
 *
 * Routing: valid payload → fired on an in-process EventEmitter that
 * downstream consumers subscribe to. Consumers (AI summarization, voice
 * notifications, mobile push) are out of scope for V1; this receiver
 * just lands the event.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";

import { Router, type Request, type Response } from "express";
import pino from "pino";

import { config } from "../config.js";
import { cacheIncr } from "../services/cache.service.js";

const logger = pino({ name: "pm-webhook" });

/** Replay window — payloads older than this are rejected. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Per-IP rate-limit window length (seconds) and max deliveries within it. */
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX = 60;

/** `ratelimit:pm-webhook:<ip>` — fixed-window delivery count for the IP. */
function rateLimitKey(ip: string): string {
  return `ratelimit:pm-webhook:${ip}`;
}

/** Plane's webhook signature header name. */
const SIGNATURE_HEADER = "x-plane-signature";

/** Plane's webhook timestamp header name. */
const TIMESTAMP_HEADER = "x-plane-delivery-timestamp";

/**
 * Event bus exported for downstream consumers (separate tickets — not
 * wired here in V1). Importers subscribe via `pmWebhookBus.on("event",
 * handler)`. Event payload shape mirrors Plane's webhook JSON.
 */
export const pmWebhookBus = new EventEmitter();

/** Webhook payload as Plane sends it (loosely typed; consumers narrow). */
export interface PmWebhookPayload {
  event: string;
  action?: string;
  data: Record<string, unknown>;
}

export function createPmWebhookRouter(): Router {
  const router = Router();

  router.post(
    "/api/pm/webhook",
    // WARP-566 — `req.body` is the RAW request Buffer here: app.ts mounts
    // `express.raw` scoped to this path BEFORE the global express.json().
    // HMAC is defined over the exact octet string Plane signed, so we hash
    // those raw bytes directly. Re-serializing the parsed JSON
    // (JSON.stringify(req.body)) would diverge from Plane's serializer
    // (key order, whitespace, unicode/float formatting) and both reject
    // valid events and weaken integrity. JSON.parse happens only AFTER the
    // signature verifies.
    async (req: Request, res: Response) => {
      // Per-IP fixed-window rate limit FIRST — this public route's only
      // other gate is the HMAC check, so cap deliveries before spending CPU
      // on signature comparison. `cacheIncr` is atomic (INCR + EXPIRE) and
      // returns null on a Redis error, in which case we fail OPEN (treat as
      // under-limit) so a down cache never drops valid Plane events.
      const ip = req.ip ?? "unknown";
      const count = await cacheIncr(rateLimitKey(ip), RATE_LIMIT_WINDOW_SEC);
      if (count !== null && count > RATE_LIMIT_MAX) {
        logger.warn({ event_type: "webhook_rate_limited", ip }, "pm webhook rate limit exceeded");
        res.setHeader("Retry-After", String(RATE_LIMIT_WINDOW_SEC));
        return res.status(429).json({ error: "rate limit exceeded" });
      }

      const signature = req.header(SIGNATURE_HEADER);
      const timestamp = req.header(TIMESTAMP_HEADER);
      const secret = config.DROPLET_PM_WEBHOOK_SECRET;

      // Fail-CLOSED on missing config / headers.
      if (!secret) {
        logger.warn({ event_type: "webhook_auth_failure", reason: "no_secret" });
        return res.status(503).json({ error: "webhook not configured" });
      }
      if (!signature) {
        logger.warn({ event_type: "webhook_auth_failure", reason: "missing_signature" });
        return res.status(401).json({ error: "missing signature" });
      }
      if (!timestamp) {
        logger.warn({ event_type: "webhook_auth_failure", reason: "missing_timestamp" });
        return res.status(401).json({ error: "missing timestamp" });
      }

      // Defensive: the raw parser must have produced a Buffer. If it did
      // not (mount misconfiguration), fail-CLOSED rather than hash a
      // re-serialized value.
      const rawBody = req.body;
      if (!Buffer.isBuffer(rawBody)) {
        logger.warn({ event_type: "webhook_auth_failure", reason: "body_not_raw" });
        return res.status(400).json({ error: "raw body required" });
      }

      // Replay window.
      const ts = Number(timestamp);
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
        logger.warn({ event_type: "webhook_auth_failure", reason: "replay_window" });
        return res.status(401).json({ error: "timestamp outside replay window" });
      }

      // HMAC over the EXACT received bytes: `${timestamp}.` + raw payload.
      // Binds the timestamp (replay guard) to the body without
      // re-serializing the body.
      const expected = createHmac("sha256", secret)
        .update(Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]))
        .digest("hex");

      const sigBuf = Buffer.from(signature, "hex");
      const expBuf = Buffer.from(expected, "hex");
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
        logger.warn({ event_type: "webhook_auth_failure", reason: "signature_mismatch" });
        return res.status(401).json({ error: "signature mismatch" });
      }

      // Signature verified. Parse the raw bytes now; malformed JSON is a
      // 400 (bad payload), never a 500.
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString("utf8"));
      } catch {
        logger.warn({ event_type: "webhook_bad_payload", reason: "malformed_json" });
        return res.status(400).json({ error: "malformed JSON" });
      }

      // A signature-valid body that parses to a non-object (null, array,
      // scalar) must not reach `payload.event` and throw a TypeError → 500.
      // Fail-CLOSED to 400 (bad payload) instead.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        logger.warn({ event_type: "webhook_bad_payload", reason: "not_an_object" });
        return res.status(400).json({ error: "payload must be a JSON object" });
      }
      const payload = parsed as PmWebhookPayload;

      // Authenticated. Emit + 204.
      logger.info(
        {
          event_type: "webhook_received",
          plane_event: payload.event,
          plane_action: payload.action,
        },
        "Plane webhook delivered",
      );
      pmWebhookBus.emit("event", payload);
      return res.status(204).send();
    },
  );

  return router;
}
