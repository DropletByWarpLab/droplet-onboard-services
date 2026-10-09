import { Router, type Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { fileMediaFromPath } from "@droplet/shared-types";
import { config } from "../config.js";
import { requireRoleOrMcpService } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { checkSpaceAccess } from "../middleware/space.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { resolveAssertedNextcloudLogin } from "../services/asserted-nextcloud-login.service.js";
import { getNcToken, resolveNcToken } from "../services/nextcloud-session.service.js";
import { isPathUnderUser } from "../services/brain-memory.service.js";
import { ncFetchFileResponse, ncGetFileId, ncUploadFile, NcPreconditionFailedError } from "../services/nextcloud.client.js";
import { resolveFileDepartment, upsertFileRegistryEntry } from "../services/file-registry.service.js";
import { createOfficeFileClient, readOfficeBytes, OFFICE_BYTES, OFFICE_MIME, OfficeFileError, type OfficeFileClient, type OfficeFormat } from "../services/office-file.client.js";
import { UnsafePathError } from "../lib/unsafe-path-error.js";
import { invalidatePrefix } from "../services/cache.service.js";
import { recordActivity } from "../services/activity.singleton.js";

const text = z.string().max(4000).refine((v) => !/\p{Cs}|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(v), "text contains unsupported controls");
const schema = z.object({
  action: z.enum(["inspect", "revise"]).default("inspect"),
  source_path: z.string().min(1).max(4096).optional(),
  item_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  path: z.string().max(255).regex(/^\/[^/\\%\x00-\x1f\x7f]+\.(docx|xlsx|pptx)$/i, "path must be a new personal-root Office filename").refine((v) => !/[\p{Cf}\p{Cs}]/u.test(v), "path contains hidden controls").optional(),
  changes: z.object({
    cells: z.array(z.object({ sheet: z.string().min(1).max(31), cell: z.string().regex(/^[A-Za-z]{1,3}[1-9][0-9]{0,6}$/), value: z.union([z.string().max(32767), z.number().finite(), z.boolean(), z.null()]) }).strict()).min(1).max(200).optional(),
    text: z.array(z.object({ id: z.string().min(1).max(200), text }).strict()).min(1).max(200).optional(),
  }).strict().optional(),
}).strict().refine((v) => Boolean(v.source_path) !== Boolean(v.item_id), "Provide exactly one source_path or item_id").refine((v) => v.action === "revise" ? Boolean(v.path && v.changes && (v.changes.cells || v.changes.text)) : !v.path && !v.changes, "Inspect accepts no destination/changes; revise requires path and changes");
const ROLES = new Set(["owner", "admin", "family"]);
const rateLimit = createRateLimit("office-file", { windowMs: 60_000, limit: 20 });
let activeRequests = 0;
class RouteError extends Error { constructor(readonly status: number, message: string) { super(message); } }
function officeFormat(name: string): OfficeFormat {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension !== "docx" && extension !== "xlsx" && extension !== "pptx") throw new RouteError(400, "Source must be a DOCX, XLSX or PPTX file.");
  return extension;
}

/** Reads with the caller's ACL; revisions create a fresh personal-root file.
 * Never stores original bytes, modifies sources, or forwards storage identity
 * to the credential-free document service. */
export function createOfficeFileRouter(prisma: PrismaClient, client: OfficeFileClient = createOfficeFileClient()): Router {
  const router = Router();
  router.post("/files/office", rateLimit, requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") }); return; }
    if (activeRequests >= 2) { res.status(429).json({ error: "Office processing is busy. Try again when it finishes." }); return; }
    activeRequests++;
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 55_000);
    const cancelled = () => { if (!res.writableEnded) controller.abort(); }; res.once("close", cancelled);
    const bounded = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(new OfficeFileError("TIMEOUT", "Office processing was cancelled."));
      if (controller.signal.aborted) { abort(); void work.catch(() => {}); return; }
      controller.signal.addEventListener("abort", abort, { once: true });
      void work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
    });
    try {
      const input = parsed.data;
      if (input.changes && Buffer.byteLength(JSON.stringify(input.changes), "utf8") > 1_048_576) throw new RouteError(413, "Office revision operations exceed 1 MiB. Use fewer edits or smaller replacement values.");
      const service = req.user?.id === "_service:mcp" && req.user.role === "service";
      const acting = service ? await bounded(resolveAssertedUser(prisma, req.header("x-nextcloud-user") ?? "")) : null;
      if (acting && !acting.ok) throw new RouteError(403, "Acting person must resolve to one active user.");
      const person = acting?.ok ? acting.user : req.user;
      if (!person || !ROLES.has(person.role)) throw new RouteError(403, "Office processing is not permitted for this role.");
      let fileIdentity: { token: string; login: string } | undefined;
      async function identity() {
        if (fileIdentity) return fileIdentity;
        const token = service ? (req.header("x-nextcloud-token") ?? "").trim() : await bounded(resolveNcToken(req));
        if (!token) throw new RouteError(401, "File access is disconnected. Sign in with your password to reconnect it.");
        if (service) {
          const mapping = await bounded(resolveAssertedNextcloudLogin(prisma, req.header("x-nextcloud-user") ?? ""));
          if (!mapping.ok || mapping.userId !== person!.id) throw new RouteError(403, "Acting person has no available File Store account.");
          fileIdentity = { token, login: mapping.login };
        } else {
          if (!req.user?.username) throw new RouteError(401, "Sign in again to reconnect file access.");
          fileIdentity = { token, login: req.user.username };
        }
        return fileIdentity;
      }
      let bytes: Buffer; let filename: string; let format: OfficeFormat;
      if (input.item_id) {
        const item = await bounded(prisma.brainMemoryItem.findUnique({ where: { id: input.item_id } }));
        if (!item || item.userId !== person.id || !item.hasOriginalBytes || !isPathUnderUser(person.id, item.storagePath)) throw new RouteError(404, "Source attachment not found.");
        if (item.ingestPolicy === "await_approval") throw new RouteError(409, "This attachment is awaiting approval. Approve it before Office processing.");
        filename = item.filename; format = officeFormat(filename);
        bytes = await bounded(readOfficeBytes(Readable.toWeb(createReadStream(item.storagePath)) as ReadableStream<Uint8Array>, OFFICE_BYTES, controller.signal));
      } else {
        const source = input.source_path!; filename = source.split("/").pop() ?? ""; format = officeFormat(filename);
        const { token, login } = await identity();
        const fileId = await bounded(ncGetFileId(token, login, source, controller.signal));
        if (fileId === null) throw new RouteError(404, "Source file not found.");
        const departmentId = await bounded(resolveFileDepartment(prisma, fileId));
        if (departmentId) {
          const access = await bounded(checkSpaceAccess(prisma, req as Request, { id: person.id, role: person.role }, departmentId, "reader"));
          if (!access.allowed) throw new RouteError(access.status, access.error);
        }
        const sourceResponse = await bounded(ncFetchFileResponse(token, login, source, undefined, controller.signal));
        if (!sourceResponse) throw new RouteError(404, "Source file not found.");
        bytes = await bounded(readOfficeBytes(sourceResponse.body, OFFICE_BYTES, controller.signal));
      }
      if (input.action === "inspect") {
        const inspection = await bounded(client.inspect(bytes, format, controller.signal));
        res.json({ action: "inspect", source: { filename, ...(input.source_path ? { path: input.source_path } : { item_id: input.item_id }) }, ...inspection }); return;
      }
      const path = input.path!;
      if (officeFormat(path) !== format) throw new RouteError(400, "Revision destination must keep the source Office extension.");
      if (path.toLowerCase() === input.source_path?.toLowerCase()) throw new RouteError(400, "Revisions must use a new filename; the source remains unchanged.");
      const { token, login } = await identity();
      if (await bounded(ncGetFileId(token, login, path, controller.signal)) !== null) throw new RouteError(409, "A file already exists at this path. Choose another name.");
      const output = await bounded(client.revise(bytes, format, input.changes!, controller.signal));
      if (!Buffer.isBuffer(output) || output.length < 22 || output.length > OFFICE_BYTES || output.toString("ascii", 0, 4) !== "PK\x03\x04") throw new OfficeFileError("UNAVAILABLE", "Office processor returned an invalid revised file.");
      if (config.AUTH_ENABLED || person.id !== "dev") {
        const current = await bounded(resolveAssertedUser(prisma, person.id));
        if (!current.ok || current.user.id !== person.id || !ROLES.has(current.user.role)) throw new RouteError(403, "Office processing access was revoked before the file could be saved.");
        if (service) {
          const mapping = await bounded(resolveAssertedNextcloudLogin(prisma, person.id));
          if (!mapping.ok || mapping.userId !== person.id || mapping.login !== login) throw new RouteError(403, "The acting person's File Store account changed before saving.");
        }
      }
      const liveToken = service ? await bounded(getNcToken(person.id)) : await bounded(resolveNcToken(req));
      if (!liveToken) throw new RouteError(401, "File access disconnected before saving. Sign in again to reconnect it.");
      await bounded(ncUploadFile(liveToken, login, "/", path.slice(1), output, { ifNoneMatch: true, signal: controller.signal }));
      const warnings = [format === "xlsx" ? "Formula and chart caches were cleared. Excel recalculates them when opened." : "Paragraph replacements keep the first text run's style; review longer text for layout changes."];
      try {
        const fileId = await bounded(ncGetFileId(liveToken, login, path, controller.signal));
        if (fileId === null) warnings.push("The file was saved; metadata registration is pending.");
        else await bounded(upsertFileRegistryEntry(prisma, { ncFileId: fileId, ownerUserId: person.id, path, departmentId: null, sizeBytes: output.length, sha256: createHash("sha256").update(output).digest("hex") }));
      } catch { warnings.push("The file was saved; metadata registration is pending."); }
      await bounded(invalidatePrefix(`files:list:${login}:`)).catch(() => {});
      void recordActivity({ kind: "file", severity: "info", sourceIcon: "file", what: "Office revision created", sub: path, refs: { path, bytes: output.length, format }, actor: { type: service ? "ai" : "user", id: person.id } });
      res.json({ action: "revise", format, path, filename: path.slice(1), bytes: output.length, mimeType: OFFICE_MIME[format], warnings, media: fileMediaFromPath(path, { name: path.slice(1), mimeType: OFFICE_MIME[format], size: output.length }) });
    } catch (error) {
      if (error instanceof NcPreconditionFailedError) { res.status(409).json({ error: "A file already exists at this path. Choose another name." }); return; }
      if (controller.signal.aborted) { if (!res.destroyed) res.status(408).json({ error: "Office processing exceeded the request deadline or was cancelled." }); return; }
      if (error instanceof RouteError) { res.status(error.status).json({ error: error.message }); return; }
      if (error instanceof UnsafePathError) { res.status(400).json({ error: error.message }); return; }
      if (error instanceof OfficeFileError) { res.status(error.code === "INVALID_FILE" ? 400 : error.code === "TOO_LARGE" ? 413 : error.code === "TIMEOUT" ? 408 : 503).json({ error: error.message }); return; }
      next(error);
    } finally { activeRequests--; clearTimeout(timer); res.removeListener("close", cancelled); }
  });
  return router;
}
