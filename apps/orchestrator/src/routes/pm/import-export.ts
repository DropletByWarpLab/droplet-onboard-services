/**
 * WARP-3527 (ADR-069 WS-11) — /api/pm import and export.
 *
 * Its own router, mounted beside native.ts and relations.ts on the same `/api`
 * prefix: the paths are disjoint, the error vocabulary is its own, and several
 * slices edit native.ts. Everything here is under `/api/pm`, so the `projects`
 * module gate and the guest tier floor (mounted from the registry by
 * `mountModuleGates`) apply to it exactly as they do to the rest of Projects.
 *
 * ── ACCESS ─────────────────────────────────────────────────────────────────
 *   Export  any reader (the same people who can see the board).
 *   Import  owner, admin, or the project's lead. `requireRole` is the outer
 *           gate (owner/admin/family — the PM write roles, which also refuses
 *           guests and service principals); a `family` member then has to BE the
 *           project lead. The MCP principal is not admitted: nothing the
 *           assistant does needs to upload a file.
 *
 * ── THE UPLOAD ─────────────────────────────────────────────────────────────
 * multer with memory storage, as `files-brain.ts` does for brain uploads, and
 * `limits.fileSize` = 10 MiB so an oversized body is cut off at the limit, not
 * buffered whole. One file, no extra parts.
 *
 * ── EXPORT ─────────────────────────────────────────────────────────────────
 * Streamed from async generators with `drain` back-pressure; a client that
 * hangs up stops the loop. After the first byte is written an error can only
 * destroy the response (the status line has gone), so the failure is logged and
 * the connection is cut rather than a truncated file being presented as whole.
 */

import { Router, type NextFunction, type Request, type Response } from "express";
import multer, { MulterError } from "multer";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../../middleware/auth.js";
import { createLogger } from "../../lib/logger.js";
import { resolveDepartmentFilter } from "../../services/pm/pm-department.js";
import { exportCsvChunks, exportJsonChunks, type ExportFilters } from "../../services/pm/pm-export.service.js";
import {
  InvalidImportMappingError,
  PM_IMPORT_ERRORS,
  cancelImportJob,
  createImportJob,
  getImportJob,
  listImportJobs,
  startImportJob,
  updateImportJob,
} from "../../services/pm/pm-import.service.js";
import { IMPORT_MAX_BYTES, ImportParseError } from "../../services/pm/import/csv.js";
import { IMPORT_SOURCES } from "../../services/pm/import/types.js";
import * as pm from "../../services/pm/pm.service.js";
import { actorOf } from "./actor.js";

const logger = createLogger("pm-import-export");

/** A disconnected reader never drains; release the generator on close too. */
function waitForExportDrain(res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { res.off("drain", done); res.off("close", done); res.off("error", failed); };
    const done = () => { cleanup(); resolve(); };
    const failed = (err: Error) => { cleanup(); reject(err); };
    res.once("drain", done);
    res.once("close", done);
    res.once("error", failed);
    if (res.destroyed || res.writableEnded) done();
  });
}

const WRITE = ["owner", "admin", "family"] as const;

// ── validation ──────────────────────────────────────────────────────────────

const SOURCE = z.enum(IMPORT_SOURCES as unknown as [string, ...string[]]);
const PRIORITY = z.enum(["urgent", "high", "medium", "low", "none"]);
const GROUP = z.enum(["backlog", "unstarted", "started", "completed", "cancelled"]);
const FIELD = z.enum([
  "externalId", "name", "description", "status", "priority", "assignee", "assignees", "reporter",
  "labels", "issueType", "milestone", "dueDate", "startDate", "createdAt", "updatedAt", "completedAt", "parent",
]);

/** `Record<…>` with a cap on entries: a mapping is small; a huge one is abuse. */
const boundedRecord = <V extends z.ZodTypeAny>(value: V, max: number) =>
  z.record(z.string().min(1).max(300), value).refine((r) => Object.keys(r).length <= max, `at most ${max} entries`);

export const mappingSchema = z
  .object({
    columns: z.record(FIELD, z.array(z.string().min(1).max(300)).max(20)).optional(),
    dateOrder: z.enum(["auto", "DMY", "MDY", "YMD"]).optional(),
    listSeparator: z.string().min(1).max(1).optional(),
    createMissingStates: z.boolean().optional(),
    createMissingLabels: z.boolean().optional(),
    statuses: boundedRecord(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("state"), stateId: z.string().min(1).max(64) }),
        z.object({ kind: z.literal("create"), name: z.string().min(1).max(100), group: GROUP }),
        z.object({ kind: z.literal("default") }),
      ]),
      500,
    ).optional(),
    priorities: boundedRecord(PRIORITY, 500).optional(),
    people: boundedRecord(z.string().min(1).max(64).nullable(), 2000).optional(),
  })
  .strict();

const patchJobSchema = z
  .object({ source: SOURCE.optional(), mapping: mappingSchema.optional() })
  .strict()
  .refine((v) => v.source !== undefined || v.mapping !== undefined, "nothing to change");

const runSchema = z.object({ mapping: mappingSchema.optional(), expectedUpdatedAt: z.string().datetime().optional() }).strict();

const uploadFieldsSchema = z.object({ source: SOURCE.optional() });

const exportQuerySchema = z.object({
  state: z.string().min(1).max(100).optional(),
  assignee: z.string().min(1).max(64).optional(),
  label: z.string().min(1).max(64).optional(),
  priority: PRIORITY.optional(),
  department: z.string().min(1).max(100).optional(),
  q: z.string().min(1).max(200).optional(),
});

// ── errors ──────────────────────────────────────────────────────────────────

function badRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: "invalid_request", details: error.flatten() });
}

const MESSAGES: Record<string, string> = {
  [PM_IMPORT_ERRORS.NOT_EDITABLE]: "This import has already started or finished, so its mapping can't change.",
  [PM_IMPORT_ERRORS.NOT_STARTABLE]: "This import can't be started from where it is.",
  [PM_IMPORT_ERRORS.CHANGED]: "This import changed after your review. Refresh and review it again before running it.",
  [PM_IMPORT_ERRORS.IN_PROGRESS]: "Another import is already running for this project. Wait for it to finish or cancel it.",
  [PM_IMPORT_ERRORS.NOT_CANCELLABLE]: "This import has already finished.",
  [PM_IMPORT_ERRORS.FILE_EXPIRED]: "The uploaded file is no longer kept. Upload it again.",
};

/** Service code → HTTP. Returns true if handled. */
function mapImportError(err: unknown, res: Response): boolean {
  if (err instanceof ImportParseError) {
    res.status(422).json({ error: err.code, message: err.message, ...(err.detail ?? {}) });
    return true;
  }
  if (err instanceof InvalidImportMappingError) {
    res.status(422).json({ error: PM_IMPORT_ERRORS.INVALID_MAPPING, problems: err.problems });
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case PM_IMPORT_ERRORS.JOB_NOT_FOUND:
    case pm.PM_ERRORS.PROJECT_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case PM_IMPORT_ERRORS.NOT_EDITABLE:
    case PM_IMPORT_ERRORS.NOT_STARTABLE:
    case PM_IMPORT_ERRORS.CHANGED:
    case PM_IMPORT_ERRORS.IN_PROGRESS:
    case PM_IMPORT_ERRORS.NOT_CANCELLABLE:
      res.status(409).json({ error: msg, message: MESSAGES[msg] });
      return true;
    case PM_IMPORT_ERRORS.FILE_EXPIRED:
      res.status(410).json({ error: msg, message: MESSAGES[msg] });
      return true;
    default:
      return false;
  }
}

// ── upload ──────────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  // a plain `filename=` is UTF-8, not latin1 (WARP-3057)
  defParamCharset: "utf8",
  limits: { fileSize: IMPORT_MAX_BYTES, files: 1, fields: 4, parts: 6 },
});

function receiveFile(req: Request, res: Response, next: NextFunction): void {
  upload.single("file")(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(413).json({
          error: "file_too_large",
          message: `That file is over ${IMPORT_MAX_BYTES / (1024 * 1024)} MB. Split it and import in parts.`,
          maxBytes: IMPORT_MAX_BYTES,
        });
        return;
      }
      res.status(400).json({ error: "invalid_upload", code: err.code });
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
}

// ── router ──────────────────────────────────────────────────────────────────

export function createPmImportExportRouter(prisma: PrismaClient): Router {
  const router = Router();

  /** owner/admin, or the project's lead. Answers 403/404 itself and returns false. */
  async function mayImport(req: Request, res: Response, projectId: string): Promise<boolean> {
    // The shared Projects loader refuses Service Desk containers before lead
    // authorization, multipart parsing, or any import job write.
    const project = await pm.getProject(prisma, projectId);
    const role = req.user?.role;
    if (role === "owner" || role === "admin") return true;
    if (role === "family" && project.leadId !== null && project.leadId === req.user?.id) return true;
    res.status(403).json({
      error: "import_forbidden",
      message: "Only an owner, an admin or the project lead can import work items.",
    });
    return false;
  }

  // ── export ──
  async function streamExport(
    req: Request,
    res: Response,
    chunks: AsyncGenerator<string>,
    contentType: string,
    filename: string,
  ): Promise<void> {
    res.status(200);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      for await (const chunk of chunks) {
        if (res.destroyed || res.writableEnded) return;
        if (!res.write(chunk)) {
          await waitForExportDrain(res);
          if (res.destroyed || res.writableEnded) return;
        }
      }
      res.end();
    } catch (err) {
      if (!res.headersSent) {
        // nothing has been sent: an ordinary error response, without the download headers
        res.removeHeader("Content-Disposition");
        res.removeHeader("Content-Type");
        throw err;
      }
      logger.error({ err, path: req.path }, "export failed mid-stream");
      res.destroy(err instanceof Error ? err : undefined);
    }
  }

  router.get("/pm/projects/:id/export.csv", async (req, res, next) => {
    try {
      const parsed = exportQuerySchema.safeParse(req.query);
      if (!parsed.success) return badRequest(res, parsed.error);
      const q = parsed.data;
      const project = await pm.getProject(prisma, req.params.id);
      const filters: ExportFilters = {
        stateId: q.state,
        assignee: q.assignee === "me" ? (req.user?.id ?? undefined) : q.assignee,
        labelId: q.label,
        priority: q.priority,
        departmentId: await resolveDepartmentFilter(prisma, q.department),
        q: q.q,
      };
      const date = new Date().toISOString().slice(0, 10);
      await streamExport(
        req,
        res,
        exportCsvChunks(prisma, req.params.id, filters),
        "text/csv; charset=utf-8",
        `${project.identifier}-work-items-${date}.csv`,
      );
    } catch (err) {
      if (res.headersSent) return;
      if (mapImportError(err, res)) return;
      if (err instanceof Error && err.message === "department_not_found") {
        res.status(404).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.get("/pm/projects/:id/export.json", async (req, res, next) => {
    try {
      const project = await pm.getProject(prisma, req.params.id);
      const date = new Date().toISOString().slice(0, 10);
      await streamExport(
        req,
        res,
        exportJsonChunks(prisma, req.params.id),
        "application/json; charset=utf-8",
        `${project.identifier}-project-${date}.json`,
      );
    } catch (err) {
      if (res.headersSent) return;
      if (mapImportError(err, res)) return;
      next(err);
    }
  });

  // ── import ──
  /** Checked BEFORE multer: someone who may not import must not get 10 MB buffered first. */
  const importGate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (await mayImport(req, res, req.params.id)) next();
    } catch (err) {
      if (mapImportError(err, res)) return;
      next(err);
    }
  };

  router.post(
    "/pm/projects/:id/import",
    requireRole(...WRITE),
    importGate,
    receiveFile,
    async (req, res, next) => {
      try {
        const file = (req as Request & { file?: Express.Multer.File }).file;
        if (!file) {
          res.status(400).json({ error: "no_file", message: "Choose a file to import." });
          return;
        }
        const fields = uploadFieldsSchema.safeParse(req.body ?? {});
        if (!fields.success) return badRequest(res, fields.error);
        const actor = actorOf(req);
        if (!actor) {
          res.status(403).json({ error: "import_forbidden", message: "Only a signed-in person can import." });
          return;
        }
        const result = await createImportJob(prisma, actor, req.params.id, {
          fileName: file.originalname,
          buffer: file.buffer,
          source: fields.data.source as never,
        });
        res.status(201).json(result);
      } catch (err) {
        if (mapImportError(err, res)) return;
        next(err);
      }
    },
  );

  router.get("/pm/projects/:id/import-jobs", requireRole(...WRITE), async (req, res, next) => {
    try {
      if (!(await mayImport(req, res, req.params.id))) return;
      res.json({ jobs: await listImportJobs(prisma, req.params.id) });
    } catch (err) {
      if (mapImportError(err, res)) return;
      next(err);
    }
  });

  /** Load a job and check the caller may import into ITS project. */
  async function guardedJob(req: Request, res: Response): Promise<boolean> {
    const job = await getImportJob(prisma, req.params.jobId);
    return mayImport(req, res, job.projectId);
  }

  router.get("/pm/import-jobs/:jobId", requireRole(...WRITE), async (req, res, next) => {
    try {
      if (!(await guardedJob(req, res))) return;
      res.json({ job: await getImportJob(prisma, req.params.jobId) });
    } catch (err) {
      if (mapImportError(err, res)) return;
      next(err);
    }
  });

  router.patch("/pm/import-jobs/:jobId", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = patchJobSchema.safeParse(req.body);
      if (!parsed.success) return badRequest(res, parsed.error);
      if (!(await guardedJob(req, res))) return;
      res.json(
        await updateImportJob(prisma, req.params.jobId, {
          source: parsed.data.source as never,
          mapping: parsed.data.mapping as never,
        }),
      );
    } catch (err) {
      if (mapImportError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/import-jobs/:jobId/run", requireRole(...WRITE), async (req, res, next) => {
    try {
      const parsed = runSchema.safeParse(req.body ?? {});
      if (!parsed.success) return badRequest(res, parsed.error);
      if (!(await guardedJob(req, res))) return;
      // 202: accepted, not done. The runner takes it from here, outside this request.
      res.status(202).json({
        job: await startImportJob(prisma, req.params.jobId, {
          mapping: parsed.data.mapping as never,
          ...(parsed.data.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: parsed.data.expectedUpdatedAt }),
        }),
      });
    } catch (err) {
      if (mapImportError(err, res)) return;
      next(err);
    }
  });

  router.post("/pm/import-jobs/:jobId/cancel", requireRole(...WRITE), async (req, res, next) => {
    try {
      if (!(await guardedJob(req, res))) return;
      res.json({ job: await cancelImportJob(prisma, req.params.jobId) });
    } catch (err) {
      if (mapImportError(err, res)) return;
      next(err);
    }
  });

  return router;
}
