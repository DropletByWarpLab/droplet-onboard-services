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
 * Rate limit: deferred to the existing rate-limit middleware (mounted
 * upstream in app.ts).
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

const logger = pino({ name: "pm-webhook" });

/** Replay window — payloads older than this are rejected. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

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
    (req: Request, res: Response) => {
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
      let payload: PmWebhookPayload;
      try {
        payload = JSON.parse(rawBody.toString("utf8")) as PmWebhookPayload;
      } catch {
        logger.warn({ event_type: "webhook_bad_payload", reason: "malformed_json" });
        return res.status(400).json({ error: "malformed JSON" });
      }

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
