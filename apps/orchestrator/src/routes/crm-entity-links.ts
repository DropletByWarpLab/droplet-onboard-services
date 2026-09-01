/**
 * /api/crm/entity-links/* -- linking a file in /files to a business record
 * (WARP-2585, ADR-045 slice 6).
 *
 * MOUNT. A separate router on the `/api/crm` prefix, so the `crm` ModuleId gate
 * `mountModuleGates` already registers for `routePrefixes: ["/api/crm"]` covers
 * it with no registry edit -- one vocabulary, not a parallel list. `crm` is not
 * in `FEATURE_GATED_MODULES`, so there is a workspace gate and no per-person
 * feature gate, exactly as for the rest of the CRM. Nothing in `routes/crm.ts`
 * uses a path parameter in the first segment after `/crm`, so neither router
 * can shadow the other whichever order they mount in.
 *
 * ROLES. Reads carry no `requireRole`: the CRM is business-shared and every
 * `/api/crm` read is already open to any authenticated principal, so gating
 * this one would be a surprise, not a hardening. What a read IS gated by is
 * per-row: the service drops links whose file lives in a department the viewer
 * cannot read. Writes are `owner|admin|family`, matching `WRITE` in
 * `routes/crm.ts`.
 *
 * DELIBERATELY NOT `requireRoleOrMcpService`. Every other CRM write admits the
 * MCP service principal so WARP-2546's tools can dispatch. This one does not,
 * for a concrete reason rather than caution: creating a link resolves a PATH
 * through the CALLER's own Nextcloud token, and the service principal's
 * asserted-user channel (`X-Nextcloud-User`/`X-Nextcloud-Token`, handled only
 * in `routes/files.ts`) is a separate trust surface this router does not
 * implement. No tool in this slice needs it -- `business_link` is slice 6's
 * tool half and lands with the `business_*` suite, which owns the prompt-budget
 * decision. When it does, it admits the principal HERE and brings the asserted-
 * user handling with it.
 *
 * THE FILE GATE ON CREATE, in order, all three necessary:
 *   1. PROPFIND the path as the caller (`ncGetFileId`) -- Nextcloud's own
 *      answer to "can this person see this file". 404 when it cannot.
 *   2. `resolveFileDepartment` + `checkSpaceAccess(reader)` -- Droplet's
 *      policy answer, which is a DIFFERENT question: a groupfolder is mounted
 *      into a member's home, so step 1 can succeed on a file whose department
 *      membership was revoked and whose NC-side removal has not converged
 *      (`syncState: "removing"`). `routes/files.ts` runs both for this reason.
 *   3. the subject record exists (service layer) -- 404, not an FK 500.
 *
 * Errors: the service throws `Error(code)`; codes map to status here, mirroring
 * `routes/crm.ts` and `routes/pm/native.ts`.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { requireRole } from "../middleware/auth.js";
import { checkSpaceAccess, type SpaceAccessCaller } from "../middleware/space.js";
import { resolveFileDepartment } from "../services/file-registry.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { ncGetFileId } from "../services/nextcloud.client.js";
import * as links from "../services/crm/entity-link.service.js";

const WRITE = ["owner", "admin", "family"] as const;

const SUBJECT = z.enum(["COMPANY", "CONTACT", "DEAL", "PROJECT", "WORK_ITEM"]);
const ROLE = z.enum(["CONTRACT", "INVOICE", "QUOTE", "SCAN", "CORRESPONDENCE", "OTHER"]);
const ORIGIN = z.enum(["MANUAL", "SUGGESTED", "EXTRACTED"]);

/** The wire space vocabulary `/files?space=` uses. Free-form beyond the two
 *  literals because a department id is a uuid; the REGISTRY overrides whatever
 *  a client claims wherever it has a row. */
const SPACE = z.string().min(1).max(64);

const createSchema = z.object({
  // The client sends the PATH it browsed, not an ncFileId: the id is resolved
  // server-side by a PROPFIND as the caller, which is what makes step 1 of the
  // gate an authorization check rather than a lookup.
  filePath: z.string().min(1).max(4096),
  space: SPACE.optional(),
  subjectType: SUBJECT,
  subjectId: z.string().min(1).max(64),
  role: ROLE.optional(),
  linkedBy: ORIGIN.optional(),
  confidence: z.number().int().min(0).max(100).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

const patchSchema = z.object({
  role: ROLE.optional(),
  note: z.string().max(2000).nullable().optional(),
  archived: z.boolean().optional(),
});

const listSchema = z.object({
  subject_type: SUBJECT.optional(),
  subject_id: z.string().min(1).max(64).optional(),
  nc_file_id: z.coerce.number().int().positive().optional(),
  role: ROLE.optional(),
  archived: z.enum(["0", "1", "true", "false"]).optional(),
});

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: "invalid_request", details: error.flatten() });
}

function mapServiceError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case links.ENTITY_LINK_ERRORS.SUBJECT_NOT_FOUND:
    case links.ENTITY_LINK_ERRORS.LINK_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case links.ENTITY_LINK_ERRORS.CONFIDENCE_MISMATCH:
      // The row referenced is fine; the combination is wrong. 422, so "MANUAL
      // with a confidence" does not read as a malformed body.
      res.status(422).json({ error: msg });
      return true;
    default:
      return false;
  }
}

/** The viewer, as the space check wants it: LOCAL `User.id` UUID and role.
 *  NEVER the Nextcloud username -- the FileComment bug, in one line. */
function viewerOf(req: Request): SpaceAccessCaller {
  return { id: req.user?.id ?? "__none__", role: req.user?.role ?? "" };
}

export function createCrmEntityLinksRouter(prisma: PrismaClient): Router {
  const router = Router();

  /**
   * GET /api/crm/entity-links?subject_type=&subject_id=  (a record's documents)
   * GET /api/crm/entity-links?nc_file_id=                (a file's records)
   *
   * Unpaginated by design -- see the service header: a filtered page window
   * cannot report an honest total, and an inflated total is the leak the
   * filter exists to prevent. `truncated` is explicit, never inferred.
   */
  router.get("/crm/entity-links", async (req, res, next) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return badRequest(res, parsed.error);
    const { subject_type, subject_id, nc_file_id, role, archived } = parsed.data;
    const includeArchived = archived === "1" || archived === "true";
    try {
      if (nc_file_id !== undefined) {
        res.json(await links.listLinksForFile(prisma, viewerOf(req), nc_file_id, { includeArchived }));
        return;
      }
      if (!subject_type || !subject_id) {
        res.status(400).json({
          error: "invalid_request",
          details: "either nc_file_id, or both subject_type and subject_id, are required",
        });
        return;
      }
      res.json(
        await links.listLinksForSubject(
          prisma,
          viewerOf(req),
          { subjectType: subject_type, id: subject_id },
          { includeArchived, role },
        ),
      );
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.get("/crm/entity-links/:id", async (req, res, next) => {
    try {
      res.json({ link: await links.getLink(prisma, viewerOf(req), req.params.id) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.post("/crm/entity-links", requireRole(...WRITE), async (req, res, next) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    const body = parsed.data;
    try {
      // ── gate step 1: Nextcloud's own answer, as the caller ──
      const token = await resolveNcToken(req);
      const ncUser = req.user?.username;
      if (!token || !ncUser) {
        // Fail closed and ask for identity rather than degrading. Acting as
        // "admin" by default would be a privilege escalation dressed as a
        // convenience (routes/files.ts:getUser makes the same call).
        res.status(401).json({ error: "nextcloud_session_required" });
        return;
      }
      const filePath = `/${body.filePath}`.replace(/\/+/g, "/");
      const ncFileId = await ncGetFileId(token, ncUser, filePath);
      if (ncFileId === null) {
        res.status(404).json({ error: "file_not_found" });
        return;
      }

      // ── gate step 2: Droplet's policy answer, which step 1 does not give ──
      const departmentId = await resolveFileDepartment(prisma, ncFileId);
      if (departmentId !== null) {
        const access = await checkSpaceAccess(prisma, req, viewerOf(req), departmentId, "reader");
        if (!access.allowed) {
          res.status(access.status).json({ error: access.error });
          return;
        }
      }

      // WARP-1898's lesson, which applies the moment a stored path is read by
      // somebody other than its author: record WHICH SPACE the path is relative
      // to. Without it the reader's link falls through to /files' silent
      // personal-space default and resolves the LINKER's path inside the
      // READER's namespace. The registry is authoritative wherever it has a
      // row -- it is the same source the check above keys on; the client's
      // claim is the fallback for unregistered files and widens nothing.
      const fileSpace =
        departmentId !== null
          ? await departmentSpaceId(prisma, departmentId)
          : (body.space ?? "personal");

      const link = await links.linkFileToRecord(
        prisma,
        {
          ncFileId,
          filePath,
          fileSpace,
          subjectType: body.subjectType,
          subjectId: body.subjectId,
          role: body.role,
          linkedBy: body.linkedBy,
          confidence: body.confidence,
          note: body.note,
        },
        // Provenance only, and the LOCAL User UUID. Never `ncUser`.
        req.user?.id ?? null,
      );
      res.status(201).json({ link });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.patch("/crm/entity-links/:id", requireRole(...WRITE), async (req, res, next) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return badRequest(res, parsed.error);
    try {
      res.json({ link: await links.updateLink(prisma, viewerOf(req), req.params.id, parsed.data) });
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  router.delete("/crm/entity-links/:id", requireRole(...WRITE), async (req, res, next) => {
    try {
      await links.deleteLink(prisma, viewerOf(req), req.params.id);
      res.status(204).end();
    } catch (err) {
      if (mapServiceError(err, res)) return;
      next(err);
    }
  });

  return router;
}

/**
 * A resolved departmentId in the WIRE space vocabulary `/files?space=`
 * understands: the seeded HOUSEHOLD department is addressed as the legacy
 * `"shared"` literal there; every other department/team is `dept:<uuid>`.
 * Same shape as `routes/team-chat.ts:departmentSpaceId` -- duplicated rather
 * than exported across routers because it is four lines and the two callers
 * have no other seam in common.
 */
async function departmentSpaceId(prisma: PrismaClient, departmentId: string): Promise<string> {
  const dept = await prisma.department.findUnique({
    where: { id: departmentId },
    select: { kind: true },
  });
  return dept?.kind === "HOUSEHOLD" ? "shared" : `dept:${departmentId}`;
}
