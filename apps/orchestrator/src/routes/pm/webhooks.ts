/**
 * /api/pm/webhooks — work webhooks and chat-app notifications (WARP-3532,
 * ADR-069 §9). Owner and admin only, on every route, reads included.
 *
 * Why reads are admin-only too: a chat app's incoming-webhook URL is a
 * credential, and the delivery log names work items. Nobody below admin has a
 * reason to see either, and "the dashboard hides the button" is not an access
 * control. The role is checked at route REGISTRATION (`requireRole`), which —
 * unlike an inline `if` — records a policy-violation row when a member probes it
 * (the saas-credentials precedent).
 *
 * Mounted on `/api/pm`, so `mountModuleGates` puts the `projects` module gate in
 * front of it with every other PM route; with Projects off there is no work to
 * announce and these 404 `module_disabled` like the rest. (When the support desk
 * lands and emits ticket events on its own, that is the moment to revisit.)
 *
 * What goes in the audit feed (ActivityRow, kind `system`, like the other
 * integration settings): who did what to which webhook, its destination host and
 * format. Never the URL path, which is the credential, and never a secret.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../../middleware/auth.js";
import { sensitiveRateLimit, standardRateLimit } from "../../middleware/rate-limit.js";
import { recordActivity } from "../../services/activity.singleton.js";
import { actorFromRequest } from "../../services/activity.service.js";
import { createLogger } from "../../lib/logger.js";
import {
  PM_WEBHOOK_ERRORS,
  createWebhook,
  deleteWebhook,
  getWebhook,
  listDeliveries,
  listWebhooks,
  redeliver,
  rotateWebhookSecret,
  sendTestDelivery,
  updateWebhook,
  type ApiWebhook,
} from "../../services/pm/pm-webhook.service.js";
import { WORK_EVENT_CATALOG } from "../../services/pm/webhook-events.js";
import { actorOf } from "./actor.js";

const logger = createLogger("pm-webhooks-route");

const FORMAT = z.enum(["JSON", "SLACK", "TEAMS", "DISCORD", "GOOGLE_CHAT"]);
const NAME = z.string().trim().min(1).max(80);
// A bound, not a validator: the guard in the service is the validator.
const URL_STRING = z.string().trim().min(1).max(2048);
const EVENTS = z.array(z.string().min(1).max(64)).min(1).max(16);
const PROJECT_ID = z.string().min(1).max(64);

const createSchema = z
  .object({
    name: NAME,
    url: URL_STRING,
    format: FORMAT.default("JSON"),
    events: EVENTS,
    projectId: PROJECT_ID.nullable().optional(),
  })
  .strict();

const patchSchema = z
  .object({
    name: NAME.optional(),
    url: URL_STRING.optional(),
    format: FORMAT.optional(),
    events: EVENTS.optional(),
    projectId: PROJECT_ID.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nothing to change" });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().max(128).optional(),
});

/** The answer for a refused address. Fixed text: which rule fired is the one
 *  thing a response must not say. */
const BLOCKED_MESSAGE =
  "That address can't be used. A webhook can reach other devices on your network or the internet, but not this Droplet itself.";

/** Service error code → response. True when handled. */
function mapServiceError(err: unknown, res: Response): boolean {
  const code = err instanceof Error ? err.message : "";
  switch (code) {
    case PM_WEBHOOK_ERRORS.NOT_FOUND:
    case PM_WEBHOOK_ERRORS.DELIVERY_NOT_FOUND:
    case PM_WEBHOOK_ERRORS.PROJECT_NOT_FOUND:
      res.status(404).json({ error: code });
      return true;
    case PM_WEBHOOK_ERRORS.BLOCKED_DESTINATION:
      res.status(400).json({ error: code, message: BLOCKED_MESSAGE });
      return true;
    case PM_WEBHOOK_ERRORS.INVALID_EVENTS:
      res.status(400).json({ error: code, message: "Pick at least one event from the list." });
      return true;
    case PM_WEBHOOK_ERRORS.LIMIT_REACHED:
      res.status(409).json({
        error: code,
        message: "This workspace has reached its limit of webhooks. Delete one you no longer use.",
      });
      return true;
    default:
      return false;
  }
}

/** A zod failure → 400. `flatten()` carries messages and field names only; the
 *  submitted values — one of which is a credential — are never echoed. */
function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: "Invalid request", details: error.flatten() });
}

export function createPmWebhooksRouter(prisma: PrismaClient): Router {
  const router = Router();
  const admins = requireRole("owner", "admin");

  async function audit(
    req: Request,
    what: string,
    webhook: ApiWebhook,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await recordActivity({
      kind: "system",
      severity: "info",
      sourceIcon: "webhook",
      what,
      sub: webhook.name,
      actor: actorFromRequest(req),
      refs: {
        webhookId: webhook.id,
        destination: webhook.destination,
        format: webhook.format,
        events: webhook.events,
        projectId: webhook.projectId,
        ...extra,
      },
    });
  }

  const handle =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        await fn(req, res);
      } catch (err) {
        if (mapServiceError(err, res)) return;
        // No `err` in the log line: a service throw never carries the URL, but
        // the habit is the control (the saas-credentials rule).
        logger.warn({ method: req.method, path: req.path }, "pm webhooks request failed");
        next(err);
      }
    };

  router.get(
    "/pm/webhooks",
    admins,
    standardRateLimit,
    handle(async (_req, res) => {
      res.json({ webhooks: await listWebhooks(prisma), events: WORK_EVENT_CATALOG });
    }),
  );

  router.post(
    "/pm/webhooks",
    admins,
    sensitiveRateLimit,
    handle(async (req, res) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return void badRequest(res, parsed.error);
      const { webhook, secret } = await createWebhook(prisma, actorOf(req), parsed.data);
      await audit(req, "Work webhook created", webhook);
      // The ONLY response that ever carries the secret, besides a rotation.
      res.status(201).json({ webhook, secret });
    }),
  );

  router.get(
    "/pm/webhooks/:id",
    admins,
    standardRateLimit,
    handle(async (req, res) => {
      res.json({ webhook: await getWebhook(prisma, String(req.params.id)) });
    }),
  );

  router.patch(
    "/pm/webhooks/:id",
    admins,
    sensitiveRateLimit,
    handle(async (req, res) => {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) return void badRequest(res, parsed.error);
      const webhook = await updateWebhook(prisma, String(req.params.id), parsed.data);
      await audit(
        req,
        parsed.data.enabled === false
          ? "Work webhook paused"
          : parsed.data.enabled === true
            ? "Work webhook resumed"
            : "Work webhook changed",
        webhook,
        // WHICH fields, never their values: the address is a credential.
        { changed: Object.keys(parsed.data) },
      );
      res.json({ webhook });
    }),
  );

  router.delete(
    "/pm/webhooks/:id",
    admins,
    sensitiveRateLimit,
    handle(async (req, res) => {
      const webhook = await deleteWebhook(prisma, String(req.params.id));
      await audit(req, "Work webhook deleted", webhook);
      res.status(204).end();
    }),
  );

  router.post(
    "/pm/webhooks/:id/rotate-secret",
    admins,
    sensitiveRateLimit,
    handle(async (req, res) => {
      const { webhook, secret } = await rotateWebhookSecret(prisma, String(req.params.id));
      await audit(req, "Work webhook secret rotated", webhook);
      res.json({ webhook, secret });
    }),
  );

  router.post(
    "/pm/webhooks/:id/test",
    admins,
    sensitiveRateLimit,
    handle(async (req, res) => {
      const delivery = await sendTestDelivery(prisma, String(req.params.id), {
        id: actorOf(req),
        name: req.user?.displayName ?? null,
      });
      // 200 whatever the receiver said: the request did what it was asked, and
      // the result — delivered, refused, blocked by the egress setting — is the
      // answer, in the body.
      res.json({ delivery });
    }),
  );

  router.get(
    "/pm/webhooks/:id/deliveries",
    admins,
    standardRateLimit,
    handle(async (req, res) => {
      const parsed = listQuerySchema.safeParse(req.query);
      if (!parsed.success) return void badRequest(res, parsed.error);
      res.json(await listDeliveries(prisma, String(req.params.id), parsed.data));
    }),
  );

  router.post(
    "/pm/webhooks/:id/deliveries/:deliveryId/redeliver",
    admins,
    sensitiveRateLimit,
    handle(async (req, res) => {
      const delivery = await redeliver(prisma, String(req.params.id), String(req.params.deliveryId));
      res.status(202).json({ delivery });
    }),
  );

  return router;
}
