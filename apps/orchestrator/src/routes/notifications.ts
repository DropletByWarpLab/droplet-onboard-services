/**
 * /api/notifications/* — the recipient's notifications, their acknowledgement,
 * and a manual send.
 *
 *   N1  GET  /notifications               the list (keyset-paged) + the unread count
 *   N2  GET  /notifications/unread-count  the badge alone
 *   N3  POST /notifications/:id/ack       ack one ({via?: 'inbox'|'opened'})
 *   N4  POST /notifications/ack-all       ack every unread row up to `before`
 *       POST /notifications/send          the LLM `send_notification` tool and
 *                                         system code; calls sendNotification()
 *
 * WARP-2804 — everything here is keyed on `req.user.username`: a person only
 * ever reads or acks their OWN rows. Someone else's id answers exactly like a
 * missing one (404 NOTIFICATION_NOT_FOUND), so N3 never confirms a row
 * exists. Service principals (`_service:*`) never own rows, and N3/N4 refuse
 * them outright (403 HUMAN_ONLY) so a script cannot probe other people's ids.
 * Behind authMiddleware (core, not module-gated). Errors on N1–N4 are
 * `{error: {code, message}}`; /send keeps its original shape.
 *
 * The ack records the sign-in that did it — the sign-in's id from the signed
 * token (`req.user.sid`); its live-session check can be skipped when the
 * session store is unreachable, so whether it ran (`req.sessionChecked`) is
 * recorded beside it — and what the client SAID it was (`describeClient`,
 * reported, never proof). None of the three is ever returned by any route
 * here. The iOS inbox is the other consumer of N1–N4 and sends
 * `X-Droplet-Client`.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import {
  sendNotification,
  listNotifications,
  countUnread,
  ackNotification,
  ackAllNotifications,
  parseNotificationCursor,
  NOTIFICATION_LIST_MAX,
  type AckAttribution,
  type NotificationKind,
} from "../services/notifications.service.js";
import { describeClient } from "../lib/client-descriptor.js";

function getUser(req: Request): string {
  const username = req.user?.username;
  // authMiddleware guarantees req.user on these routes; an absent username is
  // an invariant break, not a legitimate "admin" default (ORCH-007 fail-open).
  if (!username) throw new Error("authenticated user required");
  return username;
}

// WARP-2587 — one vocabulary, checked in BOTH directions at compile time. The
// `satisfies` catches a label here that the enum does not have; `_KindsCover`
// catches a label the enum HAS that is missing here (which `satisfies` alone
// cannot see, and which would silently 400 a legitimate kind).
const NOTIFICATION_KINDS = [
  "reminder",
  "event",
  "system",
  "ai",
] as const satisfies readonly NotificationKind[];
type _KindsCover = NotificationKind extends (typeof NOTIFICATION_KINDS)[number] ? true : never;
const _kindsAreExhaustive: _KindsCover = true;

const sendSchema = z.object({
  kind: z.enum(NOTIFICATION_KINDS).default("system"),
  title: z.string().min(1).max(500),
  body: z.string().max(2000).optional(),
});

// ── WARP-2804 ────────────────────────────────────────────────────────────────

type ErrorCode = "VALIDATION_ERROR" | "NOTIFICATION_NOT_FOUND" | "HUMAN_ONLY";

function fail(res: Response, status: number, code: ErrorCode, message: string): void {
  res.status(status).json({ error: { code, message } });
}

/** A NotificationLog id (cuid) — and nothing that could be anything else. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A client's clock may run a little ahead of the box's; further than this is not "what I was shown". */
const BEFORE_SKEW_MS = 60_000;

const listQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d{1,3}$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(NOTIFICATION_LIST_MAX))
      .optional(),
    cursor: z
      .string()
      .refine((c) => parseNotificationCursor(c) !== null, "not a cursor this box minted")
      .optional(),
    state: z.enum(["unacked", "all"]).optional(),
  })
  .strict();

/** `inbox` (the default) or `opened` — the client REPORTS the person opened its link. */
const ackBodySchema = z.object({ via: z.enum(["inbox", "opened"]).optional() }).strict();

const ackAllBodySchema = z.object({ before: z.string().datetime({ offset: true }) }).strict();

/** Service principals never own rows; N3/N4 refuse them before anything is looked up. */
function refuseServicePrincipal(req: Request, res: Response): boolean {
  if (req.user?.role !== "service") return false;
  fail(res, 403, "HUMAN_ONLY", "Only a person can acknowledge their notifications.");
  return true;
}

/** The ack's device facts: the checked sign-in, and what the client said it was. */
function attribution(req: Request): AckAttribution {
  return {
    sessionId: req.user?.sid ?? null,
    sessionChecked: req.sessionChecked === true,
    client: describeClient(req.get("user-agent"), req.get("x-droplet-client")),
  };
}

export function createNotificationsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // N1
  router.get("/notifications", async (req, res, next) => {
    try {
      const q = listQuerySchema.safeParse(req.query);
      if (!q.success) {
        fail(res, 400, "VALIDATION_ERROR", "Those list options aren't in a shape Droplet understands.");
        return;
      }
      const username = getUser(req);
      const [page, unread] = await Promise.all([
        listNotifications(prisma, username, { limit: q.data.limit ?? 50, cursor: q.data.cursor, state: q.data.state }),
        countUnread(prisma, username),
      ]);
      res.json({ notifications: page.rows, unread, nextCursor: page.nextCursor });
    } catch (err) {
      next(err);
    }
  });

  // N2
  router.get("/notifications/unread-count", async (req, res, next) => {
    try {
      res.json({ unread: await countUnread(prisma, getUser(req)) });
    } catch (err) {
      next(err);
    }
  });

  // N4 — registered before N3 only for reading order; the paths cannot collide
  // (`ack-all` is one segment, `:id/ack` is two).
  router.post("/notifications/ack-all", async (req, res, next) => {
    try {
      if (refuseServicePrincipal(req, res)) return;
      const parsed = ackAllBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        fail(res, 400, "VALIDATION_ERROR", "`before` must be the ISO-8601 time of the newest notification shown.");
        return;
      }
      const before = new Date(parsed.data.before);
      if (before.getTime() > Date.now() + BEFORE_SKEW_MS) {
        fail(res, 400, "VALIDATION_ERROR", "`before` is in the future.");
        return;
      }
      const out = await ackAllNotifications(prisma, { username: getUser(req), before, ...attribution(req) });
      res.json(out);
    } catch (err) {
      next(err);
    }
  });

  // N3
  router.post("/notifications/:id/ack", async (req, res, next) => {
    try {
      if (refuseServicePrincipal(req, res)) return;
      const id = req.params.id ?? "";
      const body = ackBodySchema.safeParse(req.body ?? {});
      if (!ID_RE.test(id) || !body.success) {
        fail(res, 400, "VALIDATION_ERROR", "That acknowledgement isn't in a shape Droplet understands.");
        return;
      }
      const out = await ackNotification(prisma, {
        id,
        username: getUser(req),
        method: body.data.via ?? "inbox",
        ...attribution(req),
      });
      if (!out) {
        // Missing and someone else's are the same answer, byte for byte.
        fail(res, 404, "NOTIFICATION_NOT_FOUND", "No such notification.");
        return;
      }
      res.json({ notification: out.row, changed: out.changed });
    } catch (err) {
      next(err);
    }
  });

  router.post("/notifications/send", async (req, res, next) => {
    try {
      const parsed = sendSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const result = await sendNotification(prisma, {
        username: getUser(req),
        kind: parsed.data.kind,
        title: parsed.data.title,
        body: parsed.data.body,
      });
      res.status(202).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
