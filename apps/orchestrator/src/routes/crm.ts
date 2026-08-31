/**
 * /api/crm/* — the CRM surface (WARP-2117). Backs the Customers/Deals sub-tabs
 * (WARP-2545) and, once they exist, the `crm_*` tools (WARP-2546).
 *
 * Auth: mounted AFTER authMiddleware, and gated by the `crm` ModuleId through
 * the registry-driven module gates in `module-mounts.ts` — this file adds no
 * gate of its own, so there is one vocabulary and not a parallel list.
 *
 * Like PM, the CRM is business-shared: reads are open to any authenticated
 * role, writes are gated with `requireRole`. Write routes admit the MCP service
 * principal (`requireRoleOrMcpService`) so WARP-2546's confirmation-gated tools
 * can dispatch here; the tool layer owns the human-facing confirmation.
 *
 * Errors: the service throws Error(code); codes map to HTTP status here,
 * mirroring routes/pm/native.ts.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import * as crm from "../services/crm/crm.service.js";
import * as partyLinks from "../services/crm/party-link.service.js";
import * as customerRecord from "../services/crm/customer-record.service.js";

/** Actor for attribution — the local User.id UUID (WARP-485), or null for the
 *  MCP service principal. */
function actor(req: Request): string | null {
  const id = req.user?.id;
  if (!id || id === "_service:mcp") return null;
  return id;
}

/**
 * The owner whose contacts a party-link request may touch (WARP-2562).
 *
 * Distinct from `actor()` above, which answers "who gets the credit" and is
 * allowed to be null. This answers "whose address book is this", and a null
 * here is not attribution-less — it is unscoped, so the caller is refused
 * rather than served someone else's rows. Mirrors `contacts.ts:ownerId`,
 * including the `_service:` prefix test rather than one hard-coded principal.
 */
function ownerId(req: Request): string | null {
  const id = req.user?.id;
  if (!id || id.startsWith("_service:")) return null;
  return id;
}

function mapPartyLinkError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case partyLinks.PARTY_LINK_ERRORS.CONTACT_NOT_FOUND:
    case partyLinks.PARTY_LINK_ERRORS.COMPANY_NOT_FOUND:
    case partyLinks.PARTY_LINK_ERRORS.LINK_NOT_FOUND:
    // WARP-2562 — a link now names the connection it came from, so a bad
    // connection id is its own 404 rather than an "already linked" 409 or a
    // foreign-key 500.
    case partyLinks.PARTY_LINK_ERRORS.CONNECTION_NOT_FOUND:
      // Another owner's contact lands here too, as a 404. A 403 would confirm
      // the row exists to someone who should not know that.
      res.status(404).json({ error: msg });
      return true;
    case partyLinks.PARTY_LINK_ERRORS.PARTY_AMBIGUOUS:
    case partyLinks.PARTY_LINK_ERRORS.CONFIDENCE_NEEDS_MATCHED:
      // The request is well-formed but self-contradictory — 422, not 400, so
      // it does not read as a malformed body.
      res.status(422).json({ error: msg });
      return true;
    case partyLinks.PARTY_LINK_ERRORS.ALREADY_LINKED:
      res.status(409).json({ error: msg });
      return true;
    default:
      // The unique index is the real guard under a race; the service's
      // pre-check can lose it. Map Prisma's own violation to the same 409 so
      // a concurrent duplicate is not a 500.
      if (typeof err === "object" && err !== null && "code" in err && err.code === "P2002") {
        res.status(409).json({ error: partyLinks.PARTY_LINK_ERRORS.ALREADY_LINKED });
        return true;
      }
      return false;
  }
}

function mapServiceError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case crm.CRM_ERRORS.COMPANY_NOT_FOUND:
    case crm.CRM_ERRORS.CONTACT_NOT_FOUND:
    case crm.CRM_ERRORS.DEAL_NOT_FOUND:
    case crm.CRM_ERRORS.PIPELINE_NOT_FOUND:
    case crm.CRM_ERRORS.STAGE_NOT_FOUND:
    case crm.CRM_ERRORS.ACTIVITY_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case crm.CRM_ERRORS.INVALID_STAGE:
    case crm.CRM_ERRORS.AMOUNT_NEEDS_CURRENCY:
    case "activity_needs_a_subject":
      // The referenced row exists but is wrong for this request — 422, so a
      // cross-pipeline stage id does not read as a typo.
      res.status(422).json({ error: msg });
      return true;
    case crm.CRM_ERRORS.STAGE_HAS_DEALS:
    case crm.CRM_ERRORS.STAGE_IS_LAST:
    case crm.CRM_ERRORS.PIPELINE_HAS_DEALS:
    case crm.CRM_ERRORS.DUPLICATE_LINK:
      res.status(409).json({ error: msg });
      return true;
    default:
      return false;
  }
}

const WRITE = ["owner", "admin", "family"] as const;

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: "invalid_request", details: error.flatten() });
}

const STAGE_KIND = z.enum(["OPEN", "WON", "LOST"]);
const SUBJECT = z.enum(["COMPANY", "CONTACT", "DEAL"]);

/**
 * Minor units as a decimal string, optionally negative (a credit is a real
 * thing). A `z.number()` here would silently round above 2^53, which for a
 * currency figure is a wrong answer rather than an error.
 */
const AMOUNT_MINOR = z
  .string()
  .regex(/^-?\d{1,19}$/, "amountMinor must be a decimal string of minor units");

/** ISO-4217: three letters, uppercased by the caller. Not a closed list —
 *  currencies outlive any enum we would ship. */
const CURRENCY = z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO-4217 alpha-3 code");

// Non-numeric pagination would coerce to NaN and reach Prisma's skip/take as
// NaN — a driver crash surfacing as a 500. Rejected at the route layer.
const paginationQuery = z.object({
  per_page: z.coerce.number().int().positive().max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
});

const pipelineCreateSchema = z.object({
  name: z.string().min(1).max(120),
  seed_default_stages: z.boolean().optional(),
});

const pipelinePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  archived: z.boolean().optional(),
  sortOrder: z.number().int().finite().min(0).max(9999).optional(),
});

const stageCreateSchema = z.object({
  name: z.string().min(1).max(120),
  kind: STAGE_KIND.optional(),
  sortOrder: z.number().int().finite().min(0).max(9999).optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
});

const stagePatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: STAGE_KIND.optional(),
  sortOrder: z.number().int().finite().min(0).max(9999).optional(),
  probability: z.number().int().min(0).max(100).nullable().optional(),
});

const companyCreateSchema = z.object({
  name: z.string().min(1).max(300),
  domain: z.string().max(255).nullable().optional(),
  industry: z.string().max(120).nullable().optional(),
  phone: z.string().max(64).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  addressLine1: z.string().max(255).nullable().optional(),
  addressLine2: z.string().max(255).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  region: z.string().max(120).nullable().optional(),
  postalCode: z.string().max(32).nullable().optional(),
  country: z.string().max(120).nullable().optional(),
  note: z.string().max(20000).nullable().optional(),
  ownerId: z.string().max(64).nullable().optional(),
});

const companyPatchSchema = companyCreateSchema.partial().extend({
  archived: z.boolean().optional(),
});

const dealCreateSchema = z.object({
  title: z.string().min(1).max(300),
  companyId: z.string().max(64).nullable().optional(),
  pipelineId: z.string().max(64).optional(),
  stageId: z.string().max(64).optional(),
  amountMinor: AMOUNT_MINOR.nullable().optional(),
  currency: CURRENCY.nullable().optional(),
  expectedCloseOn: z.string().datetime().nullable().optional(),
  ownerId: z.string().max(64).nullable().optional(),
  projectId: z.string().max(64).nullable().optional(),
});

const dealPatchSchema = dealCreateSchema.partial().extend({
  closeReason: z.string().max(2000).nullable().optional(),
  archived: z.boolean().optional(),
});

const moveStageSchema = z.object({ stageId: z.string().min(1).max(64) });

const linkContactSchema = z.object({
  contactId: z.string().min(1).max(64),
  title: z.string().max(200).nullable().optional(),
  isPrimary: z.boolean().optional(),
  role: z.string().max(200).nullable().optional(),
});

/**
 * The caller-writable timeline kinds. `STAGE_CHANGE`, `CREATED` and `SYNCED`
 * are box-written and deliberately absent: a hand-written stage change with no
 * move behind it would make the timeline lie about what happened. The service
 * enforces the same rule for non-route callers.
 */
const activityCreateSchema = z.object({
  subjectType: SUBJECT,
  companyId: z.string().max(64).nullable().optional(),
  contactId: z.string().max(64).nullable().optional(),
  dealId: z.string().max(64).nullable().optional(),
  kind: z.enum(["NOTE", "EMAIL", "CALL", "MEETING", "TASK"]),
  summary: z.string().min(1).max(1000),
  occurredAt: z.string().datetime().optional(),
  noteId: z.string().max(64).nullable().optional(),
  emailMessageId: z.string().max(64).nullable().optional(),
  calendarEventId: z.string().max(64).nullable().optional(),
  workItemId: z.string().max(64).nullable().optional(),
});

/**
 * WARP-2562 — party-link bodies.
 *
 * The caller names a CONNECTION, not a provider. The provider is derived from
 * that connection in the service and is never accepted here, for two reasons:
 * a body-supplied provider can contradict its own connection, and a provider
 * alone cannot tell two HubSpot portals apart — whose object ids are
 * portal-scoped and therefore collide.
 *
 * That also removes the WARP-2291 hazard rather than repeating it: there is no
 * vendor vocabulary in this schema to constrain or to get wrong, so a new
 * upstream still needs no migration here.
 */
const partyLinkCreateSchema = z
  .object({
    contactId: z.string().max(64).optional(),
    companyId: z.string().max(64).optional(),
    connectionId: z.string().min(1).max(64),
    externalId: z.string().min(1).max(256),
    linkedBy: z.enum(["MANUAL", "MATCHED", "IMPORTED"]).optional(),
    confidence: z.number().int().min(0).max(100).nullable().optional(),
  })
  // Both-or-neither is caught by the service (and by the CHECK constraint),
  // but catching it here too keeps the 422 body pointing at the field.
  .refine((v) => (v.contactId === undefined) !== (v.companyId === undefined), {
    message: "exactly one of contactId or companyId",
    path: ["contactId"],
  });

const partyLinkQuerySchema = z.object({
  contactId: z.string().max(64).optional(),
  companyId: z.string().max(64).optional(),
  archived: z.string().max(8).optional(),
});

const partyLinkArchiveSchema = z.object({
  /** Absent means archive. `false` un-archives — the same route both ways, so
   *  an accidental unlink is undone where it was made. */
  archived: z.boolean().optional(),
});

export function createCrmRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── Pipelines and stages ──

  router.get("/crm/pipelines", async (req, res, next) => {
    try {
      const includeArchived = req.query.archived === "1" || req.query.archived === "true";
      res.json({ pipelines: await crm.listPipelines(prisma, { includeArchived }) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/crm/pipelines", requireRole(...WRITE), async (req, res, next) => {
    const parsed = pipelineCreateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      const pipeline = await crm.createPipeline(prisma, {
        name: parsed.data.name,
        seedDefaultStages: parsed.data.seed_default_stages,
      });
      res.status(201).json({ pipeline });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.patch("/crm/pipelines/:id", requireRole(...WRITE), async (req, res, next) => {
    const parsed = pipelinePatchSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      res.json({ pipeline: await crm.updatePipeline(prisma, req.params.id, parsed.data) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete("/crm/pipelines/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await crm.deletePipeline(prisma, req.params.id);
      res.status(204).end();
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post("/crm/pipelines/:id/stages", requireRole(...WRITE), async (req, res, next) => {
    const parsed = stageCreateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      res.status(201).json({ stage: await crm.createStage(prisma, req.params.id, parsed.data) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.patch("/crm/stages/:id", requireRole(...WRITE), async (req, res, next) => {
    const parsed = stagePatchSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      res.json({ stage: await crm.updateStage(prisma, req.params.id, parsed.data) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete("/crm/stages/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await crm.deleteStage(prisma, req.params.id);
      res.status(204).end();
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // ── Summary (the board header, and "how's the quarter looking") ──
  // Registered BEFORE /crm/companies/:id and friends so no catch-all path
  // param can shadow it (app.ts documents the mount-order hazard).

  router.get("/crm/summary", async (req, res, next) => {
    try {
      const pipelineId = req.query.pipeline ? String(req.query.pipeline) : undefined;
      res.json(await crm.getPipelineSummary(prisma, pipelineId));
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // ── Companies ──

  router.get("/crm/companies", async (req, res, next) => {
    const parsed = paginationQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      res.json(
        await crm.listCompanies(prisma, {
          query: req.query.q ? String(req.query.q) : undefined,
          includeArchived: req.query.archived === "1" || req.query.archived === "true",
          perPage: parsed.data.per_page,
          page: parsed.data.page,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/crm/companies/:id", async (req, res, next) => {
    try {
      res.json({ company: await crm.getCompany(prisma, req.params.id) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post("/crm/companies", requireRoleOrMcpService(...WRITE), async (req, res, next) => {
    const parsed = companyCreateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      const company = await crm.createCompany(prisma, parsed.data, actor(req));
      res.status(201).json({ company });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.patch("/crm/companies/:id", requireRoleOrMcpService(...WRITE), async (req, res, next) => {
    const parsed = companyPatchSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      res.json({ company: await crm.updateCompany(prisma, req.params.id, parsed.data) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete("/crm/companies/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await crm.deleteCompany(prisma, req.params.id);
      res.status(204).end();
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post("/crm/companies/:id/contacts", requireRole(...WRITE), async (req, res, next) => {
    const parsed = linkContactSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      await crm.linkContactToCompany(prisma, req.params.id, parsed.data.contactId, {
        title: parsed.data.title,
        isPrimary: parsed.data.isPrimary,
      });
      res.status(204).end();
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete(
    "/crm/companies/:id/contacts/:contactId",
    requireRole(...WRITE),
    async (req, res, next) => {
      try {
        await crm.unlinkContactFromCompany(prisma, req.params.id, req.params.contactId);
        res.status(204).end();
      } catch (err) {
        if (mapServiceError(err, res)) return;
        next(err);
      }
    },
  );

  // ── Deals ──

  router.get("/crm/deals", async (req, res, next) => {
    const parsed = paginationQuery
      .extend({
        idle_days: z.coerce.number().int().min(0).max(3650).optional(),
      })
      .safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    const kind = req.query.kind ? STAGE_KIND.safeParse(String(req.query.kind)) : undefined;
    if (kind && !kind.success) return badRequest(res, kind.error);
    try {
      res.json(
        await crm.listDeals(prisma, {
          pipelineId: req.query.pipeline ? String(req.query.pipeline) : undefined,
          stageId: req.query.stage ? String(req.query.stage) : undefined,
          companyId: req.query.company ? String(req.query.company) : undefined,
          ownerId: req.query.owner ? String(req.query.owner) : undefined,
          kind: kind?.data,
          includeArchived: req.query.archived === "1" || req.query.archived === "true",
          idleDays: parsed.data.idle_days,
          perPage: parsed.data.per_page,
          page: parsed.data.page,
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/crm/deals/:id", async (req, res, next) => {
    try {
      res.json({ deal: await crm.getDeal(prisma, req.params.id) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post("/crm/deals", requireRoleOrMcpService(...WRITE), async (req, res, next) => {
    const parsed = dealCreateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      const deal = await crm.createDeal(prisma, parsed.data, actor(req));
      res.status(201).json({ deal });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.patch("/crm/deals/:id", requireRoleOrMcpService(...WRITE), async (req, res, next) => {
    const parsed = dealPatchSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      res.json({ deal: await crm.updateDeal(prisma, req.params.id, parsed.data, actor(req)) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // The board's write. Separate from PATCH because it is the one that moves the
  // forecast, and because it writes a timeline entry — a caller should have to
  // name what they are doing.
  router.post("/crm/deals/:id/stage", requireRoleOrMcpService(...WRITE), async (req, res, next) => {
    const parsed = moveStageSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      const deal = await crm.moveDealStage(prisma, req.params.id, parsed.data.stageId, actor(req));
      res.json({ deal });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete("/crm/deals/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await crm.deleteDeal(prisma, req.params.id);
      res.status(204).end();
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post("/crm/deals/:id/contacts", requireRole(...WRITE), async (req, res, next) => {
    const parsed = linkContactSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      await crm.linkContactToDeal(prisma, req.params.id, parsed.data.contactId, parsed.data.role);
      res.status(204).end();
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete(
    "/crm/deals/:id/contacts/:contactId",
    requireRole(...WRITE),
    async (req, res, next) => {
      try {
        await crm.unlinkContactFromDeal(prisma, req.params.id, req.params.contactId);
        res.status(204).end();
      } catch (err) {
        if (mapServiceError(err, res)) return;
        next(err);
      }
    },
  );

  // ── Timeline ──

  router.get("/crm/activities", async (req, res, next) => {
    const parsed = paginationQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    const subjectType = SUBJECT.safeParse(String(req.query.subject_type ?? ""));
    if (!subjectType.success) return badRequest(res, subjectType.error);
    const id = req.query.subject_id ? String(req.query.subject_id) : "";
    if (!id) {
      res.status(400).json({ error: "invalid_request", details: "subject_id is required" });
      return;
    }
    try {
      res.json(
        await crm.listActivities(
          prisma,
          { subjectType: subjectType.data, id },
          { perPage: parsed.data.per_page, page: parsed.data.page },
        ),
      );
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post("/crm/activities", requireRoleOrMcpService(...WRITE), async (req, res, next) => {
    const parsed = activityCreateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      const activity = await crm.logActivity(prisma, parsed.data, actor(req));
      res.status(201).json({ activity });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // ── The customer record (WARP-2563, ADR-044) ──
  //
  // One read for the whole page. Six separate fetches would each carry their
  // own loading and failure state and the page would flicker through them in
  // an order nobody chose.
  //
  // Gated by the `crm` module like every route in this file, and by nothing
  // else — there is no PHI in this response. The practice block is WARP-2564
  // and carries the connector check on top; a caller who may read a customer
  // must not thereby read a patient.
  router.get("/crm/companies/:id/record", async (req, res, next) => {
    try {
      const record = await customerRecord.getCustomerRecord(prisma, req.params.id);
      res.json({ record });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  // ── Party links (WARP-2562, ADR-044) ──
  //
  // "This contact and that upstream record are the same customer." No route
  // here admits the MCP service principal, unlike the CRM routes above, and
  // that is deliberate: a contact-side link is resolved against
  // `Contact.userId`, and the service principal has no owner. A tool that
  // needs to link on someone's behalf has to carry that person, which is a
  // decision for the landing seam (WARP-2549), not a default granted here.

  router.get("/crm/party-links", async (req, res, next) => {
    const owner = ownerId(req);
    if (!owner) return res.status(403).json({ error: "user_required" });
    const parsed = partyLinkQuerySchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      const links = await partyLinks.listPartyLinks(
        prisma,
        { contactId: parsed.data.contactId, companyId: parsed.data.companyId },
        owner,
        parsed.data.archived === "1" || parsed.data.archived === "true",
      );
      res.json({ links });
    } catch (err) {
      if (mapPartyLinkError(err, res)) return;
      next(err);
    }
  });

  router.post("/crm/party-links", requireRole(...WRITE), async (req, res, next) => {
    const owner = ownerId(req);
    if (!owner) return res.status(403).json({ error: "user_required" });
    const parsed = partyLinkCreateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      const link = await partyLinks.createPartyLink(prisma, parsed.data, owner, owner);
      res.status(201).json({ link });
    } catch (err) {
      if (mapPartyLinkError(err, res)) return;
      next(err);
    }
  });

  router.patch("/crm/party-links/:id/archive", requireRole(...WRITE), async (req, res, next) => {
    const owner = ownerId(req);
    if (!owner) return res.status(403).json({ error: "user_required" });
    const parsed = partyLinkArchiveSchema.safeParse(req.body ?? {});
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      const link = await partyLinks.archivePartyLink(
        prisma,
        req.params.id,
        owner,
        parsed.data.archived ?? true,
      );
      res.json({ link });
    } catch (err) {
      if (mapPartyLinkError(err, res)) return;
      next(err);
    }
  });

  return router;
}
