/**
 * /api/contacts/* — the one address book (WARP-2018 schema, WARP-2032's local
 * half). The CRM's Customers surface reaches people through here rather than
 * through a person record of its own.
 *
 * Auth: mounted AFTER authMiddleware and gated by the `contacts` ModuleId
 * through the registry-driven module gates. Unlike PM and the CRM, contacts are
 * OWNED — every route is scoped to `req.user.id`, and another owner's row reads
 * as 404 rather than 403 so the API never confirms an id it will not serve.
 *
 * The CardDAV half of WARP-2032 — source discovery/verify, the cron-runtime
 * sync ticker, photo storage — is NOT here. It writes the same `Contact` rows
 * through `AddressBookSource`.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { requireRole } from "../middleware/auth.js";
import * as contacts from "../services/contacts/contacts.service.js";

const WRITE = ["owner", "admin", "family"] as const;

/**
 * The local `User.id` UUID (WARP-485: `req.user.id` is always one, whether the
 * session came from a JWT or an OCS token). Deliberately NOT the Nextcloud
 * username that `Note.userId` and `CalendarEvent.userId` carry — those predate
 * the invariant, and a stable UUID is the right key for a table with no
 * Nextcloud counterpart.
 */
function ownerId(req: Request): string | null {
  const id = req.user?.id;
  if (!id || id.startsWith("_service:")) return null;
  return id;
}

function mapServiceError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case contacts.CONTACT_ERRORS.CONTACT_NOT_FOUND:
    case contacts.CONTACT_ERRORS.EMAIL_NOT_FOUND:
    case contacts.CONTACT_ERRORS.PHONE_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case contacts.CONTACT_ERRORS.CONTACT_IS_EXTERNAL:
      // Not a permission problem: the row belongs to a sync source, and the
      // edit would be reverted. 409 says "not in this state", which is true.
      res.status(409).json({ error: msg });
      return true;
    case contacts.CONTACT_ERRORS.DUPLICATE_EMAIL:
    case "contact_needs_a_name":
      res.status(422).json({ error: msg });
      return true;
    default:
      return false;
  }
}

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: "invalid_request", details: error.flatten() });
}

const emailSchema = z.object({
  address: z.string().min(3).max(320).email(),
  label: z.string().max(64).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

const phoneSchema = z.object({
  number: z.string().min(1).max(64),
  label: z.string().max(64).nullable().optional(),
  isPrimary: z.boolean().optional(),
});

const contactCreateSchema = z.object({
  displayName: z.string().min(1).max(300).optional(),
  givenName: z.string().max(150).nullable().optional(),
  familyName: z.string().max(150).nullable().optional(),
  organization: z.string().max(300).nullable().optional(),
  jobTitle: z.string().max(200).nullable().optional(),
  note: z.string().max(20000).nullable().optional(),
  // A STRING, matching the column. vCard 4.0 permits `--0423` (April 23rd,
  // year unknown), which `z.string().date()` would reject and a DateTime would
  // have to invent a year for.
  birthday: z.string().max(64).nullable().optional(),
  emails: z.array(emailSchema).max(25).optional(),
  phones: z.array(phoneSchema).max(25).optional(),
});

const contactPatchSchema = contactCreateSchema.partial();

const paginationQuery = z.object({
  per_page: z.coerce.number().int().positive().max(200).optional(),
  page: z.coerce.number().int().positive().optional(),
});

export function createContactsRouter(prisma: PrismaClient): Router {
  const router = Router();

  function requireOwner(req: Request, res: Response): string | null {
    const id = ownerId(req);
    if (!id) {
      // A service principal has no address book of its own. Refusing here is
      // what keeps the owner scope from silently becoming "everyone".
      res.status(403).json({ error: "contacts_require_a_user" });
      return null;
    }
    return id;
  }

  router.get("/contacts", async (req, res, next) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const parsed = paginationQuery.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      res.json(
        await contacts.listContacts(prisma, owner, {
          query: req.query.q ? String(req.query.q) : undefined,
          perPage: parsed.data.per_page,
          page: parsed.data.page,
          includeExternal: req.query.external !== "0" && req.query.external !== "false",
        }),
      );
    } catch (err) {
      next(err);
    }
  });

  router.get("/contacts/:id", async (req, res, next) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      res.json({ contact: await contacts.getContact(prisma, owner, req.params.id) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post("/contacts", requireRole(...WRITE), async (req, res, next) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const parsed = contactCreateSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      const contact = await contacts.createContact(prisma, owner, parsed.data);
      res.status(201).json({ contact });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.patch("/contacts/:id", requireRole(...WRITE), async (req, res, next) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    const parsed = contactPatchSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      res.json({ contact: await contacts.updateContact(prisma, owner, req.params.id, parsed.data) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete("/contacts/:id", requireRole(...WRITE), async (req, res, next) => {
    const owner = requireOwner(req, res);
    if (!owner) return;
    try {
      await contacts.deleteContact(prisma, owner, req.params.id);
      res.status(204).end();
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  return router;
}
