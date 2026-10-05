/**
 * /api/support/* — the service desk (ADR-069, WS-12 / WARP-3528): desks, tickets,
 * queues, the conversation, requesters and escalation.
 *
 * Auth: mounted AFTER authMiddleware. Three layers, outermost first:
 *   1. `mountModuleGates` (off the registry's `/api/support` prefix) — the box
 *      has the `support` module on, the caller's role may hold it (an external
 *      guest holds nothing, `refuseBelowFloor`), and THIS PERSON holds the
 *      `support` grant. Every denial there is the one 404 `module_disabled` a
 *      switched-off module answers: a narrowed person sees a smaller box, not a
 *      locked door (ADR-032 §3). The slice spec says "403"; the box's own
 *      contract is the byte-identical 404, so this surface follows it.
 *   2. `requireRole` here — human staff only. The MCP service principal is NOT
 *      admitted on any route: the assistant reaches tickets through the
 *      `business_*` verbs in a later slice, and widening this guard belongs to
 *      that change together with MCP_ACTING_USER_GATED_DOMAINS.
 *   3. `requireFeatureAccess` per route — `act` to work a ticket, `manage` to
 *      run a desk, and the Projects grant on top for escalation.
 *
 * Errors: the services throw `Error(code)`; `mapSupportError` is the one place
 * that knows the HTTP status. Bodies are zod-validated and camelCase.
 */
import { Router, type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import { installSlaRoutes } from "./sla.routes.js";
import type { PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { requireRole } from "../../middleware/auth.js";
import {
  requireFeatureAccess,
  resolveEffectiveAccessForRequest,
  type EffectiveAccessResolver,
} from "../../middleware/feature-gate.js";
import { resolveEffectiveAccess } from "../../services/effective-access.service.js";
import { getEffectiveModuleIds } from "../../services/modules.service.js";
import { actorFromRequest } from "../../services/activity.service.js";
import { recordActivity } from "../../services/activity.singleton.js";
import { PM_ERRORS } from "../../services/pm/pm.service.js";
import { PM_DEPARTMENT_ERRORS } from "../../services/pm/pm-department.js";
import * as support from "../../services/support/support.service.js";
import {
  SUPPORT_ERRORS,
  SUPPORT_QUEUES,
  type SupportCtx,
  type SupportViewer,
} from "../../services/support/support.types.js";

const STAFF = ["owner", "admin", "family"] as const;
const ADMINS = ["owner", "admin"] as const;

export interface SupportRouterDeps {
  /** Injectable per-person access resolver (the feature gate's own seam). */
  resolveAccess?: EffectiveAccessResolver;
  /** Keeps Email module availability explicit in route tests. */
  isEmailModuleEffective?: () => Promise<boolean>;
}

// ── Validation ───────────────────────────────────────────────────────────────

const ID = z.string().min(1).max(64);
const PRIORITY = z.enum(["urgent", "high", "medium", "low", "none"]);
const nullableText = (max: number) => z.string().max(max).nullable().optional();

const listQuery = z.object({
  deskId: ID.optional(),
  queue: z.enum(SUPPORT_QUEUES).optional(),
  q: z.string().max(200).optional(),
  stateId: ID.optional(),
  priority: PRIORITY.optional(),
  assigneeId: ID.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

const queuesQuery = z.object({ deskId: ID.optional() });
const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(512).optional(),
});
const contactSearchQuery = z.object({ q: z.string().max(200).default("") });

const deskCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  identifier: z.string().min(1).max(10).regex(/^[A-Za-z0-9]+$/).optional(),
  description: z.string().max(10000).optional(),
  icon: z.string().max(64).optional(),
  color: z.string().max(32).optional(),
  departmentId: ID.optional(),
});

const deskPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: nullableText(10000),
  icon: nullableText(64),
  color: nullableText(32),
  departmentId: ID.nullable().optional(),
  archived: z.boolean().optional(),
});

const requesterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("CONTACT"), contactId: ID }),
  z.object({ kind: z.literal("USER"), userId: ID.optional() }),
]);

const ticketCreateSchema = z.object({
  deskId: ID,
  subject: z.string().trim().min(1).max(500),
  descriptionHtml: z.string().max(100000).optional(),
  requester: requesterSchema.optional(),
  channel: z.enum(["INTERNAL", "PHONE"]).optional(),
  stateId: ID.optional(),
  priority: PRIORITY.optional(),
  assigneeIds: z.array(ID).max(50).optional(),
  labelIds: z.array(ID).max(50).optional(),
  departmentId: ID.optional(),
  companyId: ID.optional(),
});

const ticketPatchSchema = z.object({
  subject: z.string().trim().min(1).max(500).optional(),
  descriptionHtml: z.string().max(100000).nullable().optional(),
  stateId: ID.optional(),
  priority: PRIORITY.optional(),
  assigneeIds: z.array(ID).max(50).optional(),
  departmentId: ID.nullable().optional(),
  labelIds: z.array(ID).max(50).optional(),
  companyId: ID.nullable().optional(),
});

const conversationSchema = z.object({
  bodyHtml: z.string().min(1).max(100000),
  stateId: ID.optional(),
});

const escalateSchema = z.object({
  projectId: ID,
  title: z.string().trim().min(1).max(500).optional(),
});

const contactSchema = z.object({
  displayName: z.string().trim().max(300).optional(),
  givenName: z.string().trim().max(200).optional(),
  familyName: z.string().trim().max(200).optional(),
  email: z.string().trim().max(320).optional(),
  phone: z.string().trim().max(64).optional(),
  organization: z.string().trim().max(300).optional(),
});

const emailChannelSchema = z.object({
  emailAccountId: ID.nullable(),
  contactOwnerUserId: ID.optional(),
  enabled: z.boolean().optional(),
  autoAckEnabled: z.boolean().optional(),
  autoAckTemplate: z.string().max(4000).optional(),
  reopenWindowDays: z.number().int().min(0).max(365).optional(),
}).strict();

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: "invalid_request", details: error.flatten() });
}

/** Map a service error code to an HTTP response. Returns true if handled. */
export function mapSupportError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case SUPPORT_ERRORS.DESK_NOT_FOUND:
    case SUPPORT_ERRORS.TICKET_NOT_FOUND:
    case SUPPORT_ERRORS.CONTACT_NOT_FOUND:
    case SUPPORT_ERRORS.PROJECT_NOT_FOUND:
    case SUPPORT_ERRORS.LABEL_NOT_FOUND:
    case SUPPORT_ERRORS.STATE_NOT_FOUND:
    case SUPPORT_ERRORS.COMPANY_NOT_FOUND:
    case PM_DEPARTMENT_ERRORS.DEPARTMENT_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case SUPPORT_ERRORS.INVALID_STATE:
    case SUPPORT_ERRORS.INVALID_LABEL:
    case SUPPORT_ERRORS.INVALID_ASSIGNEE:
    case SUPPORT_ERRORS.INVALID_REQUESTER:
    case SUPPORT_ERRORS.INVALID_CHANNEL:
    case PM_DEPARTMENT_ERRORS.DEPARTMENT_NOT_ASSIGNABLE:
    case support.EMPTY_BODY:
    case "contact_needs_a_name":
    case support.INVALID_CURSOR:
      // The row exists and the request is well formed; the CHOICE is what is
      // not processable — the same class as PM's invalid_state.
      res.status(422).json({ error: msg });
      return true;
    case SUPPORT_ERRORS.DESK_ARCHIVED:
    case PM_ERRORS.IDENTIFIER_TAKEN:
    case PM_DEPARTMENT_ERRORS.DEPARTMENT_ARCHIVED:
      res.status(409).json({ error: msg });
      return true;
    case PM_ERRORS.CONCURRENT_MUTATION:
      // The compare-and-set on a state change lost: nothing was applied.
      res.status(409).json({
        error: msg,
        code: "CONCURRENT_MUTATION",
        message: "Someone changed this ticket at the same time. Nothing was applied — try again.",
      });
      return true;
    case SUPPORT_ERRORS.CONTACT_EMAIL_EXISTS:
      res.status(409).json({
        error: msg,
        contactId: err instanceof support.SupportContactExistsError ? err.contactId : undefined,
      });
      return true;
    case support.EMAIL_CHANNEL_ERRORS.ACCOUNT_NOT_FOUND:
    case support.EMAIL_CHANNEL_ERRORS.CONTACT_OWNER_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case support.EMAIL_CHANNEL_ERRORS.EMAIL_MODULE_DISABLED:
      res.status(409).json({ error: msg, message: "Enable the Email module before binding a mailbox." });
      return true;
    case support.EMAIL_CHANNEL_ERRORS.INVALID_TEMPLATE:
      res.status(422).json({ error: msg });
      return true;
    case "reply_not_retryable":
      res.status(409).json({ error: msg });
      return true;
    case "reply_too_long":
      res.status(422).json({ error: msg, maxLength: 64000 });
      return true;
    case "email_channel_unavailable":
    case "email_recipient_unavailable":
      res.status(409).json({ error: msg });
      return true;
    case "outbound_email_blocked":
      res.status(451).json({ error: msg, channel: "outbound_email" });
      return true;
    default:
      return false;
  }
}

export function createSupportRouter(prisma: PrismaClient, deps: SupportRouterDeps = {}): Router {
  const router = Router();
  const resolve = deps.resolveAccess ?? resolveEffectiveAccess;
  const svcDeps = { resolveAccess: resolve };

  const staff = requireRole(...STAFF);
  const admins = requireRole(...ADMINS);
  const canAct: RequestHandler = requireFeatureAccess("support", "act", resolve);
  const canManage: RequestHandler = requireFeatureAccess("support", "manage", resolve);
  // Escalation writes a Projects row, so it needs that grant as well as Support.
  const canWorkProjects: RequestHandler = requireFeatureAccess("projects", "act", resolve);

  const requireEmailModule = async (res: Response): Promise<boolean> => {
    const effective = deps.isEmailModuleEffective
      ? await deps.isEmailModuleEffective()
      : (await getEffectiveModuleIds(prisma, config)).has("email");
    if (effective) return true;
    res.status(409).json({ error: support.EMAIL_CHANNEL_ERRORS.EMAIL_MODULE_DISABLED, message: "Enable the Email module before binding a mailbox." });
    return false;
  };

  const viewerOf = (req: Request): SupportViewer => ({
    id: req.user!.id,
    role: req.user!.role as SupportViewer["role"],
  });

  /** The neighbouring grants the caller holds, read once per request: Projects
   *  (a linked work item is masked without it) and the CRM (a customer's people
   *  and name are shown only with it). No local user row reads as neither. */
  const ctxOf = async (req: Request): Promise<SupportCtx> => {
    const access = await resolveEffectiveAccessForRequest(req, resolve);
    const holds = (m: "projects" | "crm") =>
      access !== null && access.features.some((f) => f.moduleId === m);
    return { canReadProjects: holds("projects"), canReadCrm: holds("crm") };
  };

  const fail = (err: unknown, res: Response, next: (e?: unknown) => void): void => {
    if (mapSupportError(err, res)) return;
    next(err);
  };

  // ── People ────────────────────────────────────────────────────────────────

  router.get("/support/agents", staff, async (_req, res, next) => {
    try {
      res.json({ agents: await support.listAgents(prisma, svcDeps) });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.get("/support/contacts", staff, async (req, res, next) => {
    try {
      const parsed = contactSearchQuery.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed.error);
      res.json({
        contacts: await support.searchRequesterContacts(prisma, viewerOf(req), parsed.data.q, await ctxOf(req)),
      });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.post("/support/contacts", staff, canAct, async (req, res, next) => {
    try {
      const parsed = contactSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const contact = await support.createRequesterContact(
        prisma,
        viewerOf(req),
        parsed.data,
        await ctxOf(req),
      );
      res.status(201).json({ contact });
    } catch (err) {
      fail(err, res, next);
    }
  });

  // ── Desks ─────────────────────────────────────────────────────────────────

  router.get("/support/desks", staff, async (req, res, next) => {
    try {
      const includeArchived = req.query.archived === "1" || req.query.archived === "true";
      res.json({ desks: await support.listDesks(prisma, { includeArchived }) });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.post("/support/desks", admins, canManage, async (req, res, next) => {
    try {
      const parsed = deskCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const desk = await support.createDesk(prisma, viewerOf(req), parsed.data);
      await recordActivity({
        kind: "system",
        severity: "ok",
        sourceIcon: "life-buoy",
        what: "Service desk created",
        sub: desk.name,
        refs: { actor: req.user?.username ?? null, deskId: desk.id, identifier: desk.identifier },
        actor: actorFromRequest(req),
      });
      res.status(201).json({ desk });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.patch("/support/desks/:id", admins, canManage, async (req, res, next) => {
    try {
      const parsed = deskPatchSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const desk = await support.updateDesk(prisma, viewerOf(req), req.params.id, parsed.data);
      await recordActivity({
        kind: "system",
        severity: "ok",
        sourceIcon: "life-buoy",
        what:
          parsed.data.archived === true
            ? "Service desk archived"
            : parsed.data.archived === false
              ? "Service desk restored"
              : "Service desk updated",
        sub: desk.name,
        refs: {
          actor: req.user?.username ?? null,
          deskId: desk.id,
          identifier: desk.identifier,
          fields: Object.keys(parsed.data),
        },
        actor: actorFromRequest(req),
      });
      res.json({ desk });
    } catch (err) {
      fail(err, res, next);
    }
  });

  // Mailbox choices and binding are owner/admin-only and exist only when the
  // same Email module the indexer uses is effective. The returned account rows
  // contain no credentials or encrypted fields.
  router.get("/support/email/accounts", admins, canManage, async (_req, res, next) => {
    try {
      if (!(await requireEmailModule(res))) return;
      res.json({ accounts: await support.listDeskEmailAccounts(prisma) });
    } catch (err) { fail(err, res, next); }
  });

  router.get("/support/desks/:id/email-channel", admins, canManage, async (req, res, next) => {
    try {
      if (!(await requireEmailModule(res))) return;
      res.json({ channel: await support.getDeskEmailChannel(prisma, req.params.id) });
    } catch (err) { fail(err, res, next); }
  });

  router.put("/support/desks/:id/email-channel", admins, canManage, async (req, res, next) => {
    try {
      if (!(await requireEmailModule(res))) return;
      const parsed = emailChannelSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const channel = await support.bindDeskEmailChannel(prisma, {
        projectId: req.params.id,
        emailAccountId: parsed.data.emailAccountId,
        contactOwnerUserId: parsed.data.contactOwnerUserId ?? viewerOf(req).id,
        enabled: parsed.data.enabled,
        autoAckEnabled: parsed.data.autoAckEnabled,
        autoAckTemplate: parsed.data.autoAckTemplate,
        reopenWindowDays: parsed.data.reopenWindowDays,
      });
      res.json({ channel });
    } catch (err) { fail(err, res, next); }
  });

  // ── Tickets ───────────────────────────────────────────────────────────────

  router.get("/support/queues", staff, async (req, res, next) => {
    try {
      const parsed = queuesQuery.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed.error);
      res.json({ queues: await support.queueCounts(prisma, viewerOf(req), parsed.data, svcDeps) });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.get("/support/tickets", staff, async (req, res, next) => {
    try {
      const parsed = listQuery.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed.error);
      res.json(await support.listTickets(prisma, viewerOf(req), parsed.data, svcDeps));
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.post("/support/tickets", staff, canAct, async (req, res, next) => {
    try {
      const parsed = ticketCreateSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const ticket = await support.createTicket(
        prisma,
        viewerOf(req),
        parsed.data,
        await ctxOf(req),
        svcDeps,
      );
      res.status(201).json({ ticket });
    } catch (err) {
      fail(err, res, next);
    }
  });

  // `:ref` is a work item id or a key like SUP-12 — the deep link carries a key.
  router.get("/support/tickets/:ref", staff, async (req, res, next) => {
    try {
      res.json({ ticket: await support.getTicket(prisma, req.params.ref, await ctxOf(req)) });
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.patch("/support/tickets/:id", staff, canAct, async (req, res, next) => {
    try {
      const parsed = ticketPatchSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const ticket = await support.updateTicket(
        prisma,
        viewerOf(req),
        req.params.id,
        parsed.data,
        await ctxOf(req),
        svcDeps,
      );
      res.json({ ticket });
    } catch (err) {
      fail(err, res, next);
    }
  });

  // ── Conversation ──────────────────────────────────────────────────────────

  router.get("/support/tickets/:id/conversation", staff, async (req, res, next) => {
    try {
      res.json(await support.getConversation(prisma, req.params.id, await ctxOf(req)));
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.post("/support/tickets/:id/replies", staff, canAct, async (req, res, next) => {
    try {
      const parsed = conversationSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const result = await support.addReply(
        prisma,
        viewerOf(req),
        req.params.id,
        parsed.data,
        await ctxOf(req),
        svcDeps,
      );
      res.status(201).json(result);
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.post("/support/tickets/:id/replies/:commentId/retry", staff, canAct, async (req, res, next) => {
    try {
      res.json(await support.retryPublicReply(prisma, req.params.id, req.params.commentId));
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.post("/support/tickets/:id/notes", staff, canAct, async (req, res, next) => {
    try {
      const parsed = conversationSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      const result = await support.addNote(
        prisma,
        viewerOf(req),
        req.params.id,
        parsed.data,
        await ctxOf(req),
        svcDeps,
      );
      res.status(201).json(result);
    } catch (err) {
      fail(err, res, next);
    }
  });

  router.post(
    "/support/tickets/:id/escalate",
    staff,
    canAct,
    canWorkProjects,
    async (req, res, next) => {
      try {
        const parsed = escalateSchema.safeParse(req.body);
        if (!parsed.success) return badRequest(res, parsed.error);
        // The caller just passed the Projects gate, so the linked item is theirs to see.
        const result = await support.escalateTicket(
          prisma,
          viewerOf(req),
          req.params.id,
          parsed.data,
          { ...(await ctxOf(req)), canReadProjects: true },
        );
        res.status(201).json(result);
      } catch (err) {
        fail(err, res, next);
      }
    },
  );

  // ── Requesters ────────────────────────────────────────────────────────────

  router.get("/support/requesters/:contactId/tickets", staff, async (req, res, next) => {
    try {
      const parsed = pageQuery.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed.error);
      res.json(await support.listRequesterTickets(prisma, req.params.contactId, parsed.data));
    } catch (err) {
      fail(err, res, next);
    }
  });

  installSlaRoutes(router, prisma, { staff, admins, canAct, canManage, viewerOf, ctxOf, fail, svcDeps });
  return router;
}
