import { Router, type Request } from "express";
import type { MediaGenerationJob, Prisma, PrismaClient } from "@prisma/client";
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";
import { fileMediaFromPath, mediaJobMedia } from "@droplet/shared-types";
import { UnsafePathError } from "../lib/unsafe-path-error.js";
import { requireRoleOrMcpService } from "../middleware/auth.js";
import { checkSpaceAccess } from "../middleware/space.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { resolveAssertedNextcloudLogin } from "../services/asserted-nextcloud-login.service.js";
import { getNcToken, resolveNcToken } from "../services/nextcloud-session.service.js";
import { ncFetchFileResponse, ncGetFileId, ncUploadFile, NcPreconditionFailedError } from "../services/nextcloud.client.js";
import { resolveFileDepartment, upsertFileRegistryEntry } from "../services/file-registry.service.js";
import { invalidatePrefix } from "../services/cache.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { createMediaGenerationClient, MediaGenerationError, readMediaBytes, type MediaGenerationClient, type MediaSpec } from "../services/media-generation.client.js";

const roles = new Set(["owner", "admin", "family"]);
const guard = requireRoleOrMcpService("owner", "admin", "family");
const limit = createRateLimit("media-generation", { windowMs: 60_000, limit: 10 });
const filename = z.string().max(255).regex(/^\/[^/\\%\x00-\x1f\x7f]+\.(png|mp4)$/i);
// Raw personal WebDAV paths only. Percent escapes can conceal separators or
// traversal in later decoders; source resolution must identify one file.
const sourcePath = z.string().min(1).max(4096).refine((path) => path.startsWith("/") && !/[\\%\x00-\x1f\x7f]/.test(path) && !path.split("/").slice(1).some((part) => !part || part === "." || part === ".."), "Source must be an absolute File Store path without traversal or encoded separators.");
const schema = z.object({
  path: filename, kind: z.enum(["image", "video"]), prompt: z.string().min(1).max(4000).refine((s) => Boolean(s.trim())),
  source_path: sourcePath.optional(), mask_path: sourcePath.optional(),
  options: z.object({ width: z.number().int().optional(), height: z.number().int().optional(), steps: z.number().int().min(8).max(50).optional(), seed: z.number().int().min(0).max(2147483647).optional(), frames: z.number().int().optional(), fps: z.number().int().min(8).max(24).optional() }).strict().default({}),
}).strict().superRefine((v, ctx) => {
  if (!v.path.toLowerCase().endsWith(v.kind === "image" ? ".png" : ".mp4")) ctx.addIssue({ code: "custom", message: "Destination extension must match image PNG or video MP4." });
  if (v.mask_path && (!v.source_path || v.kind !== "image")) ctx.addIssue({ code: "custom", message: "Image masks require a source image." });
  if (v.kind === "image" && (v.options.frames !== undefined || v.options.fps !== undefined)) ctx.addIssue({ code: "custom", message: "frames/fps apply only to video." });
  const minimum = v.kind === "image" ? 512 : 256, maximum = v.kind === "image" ? 1024 : 768, multiple = v.kind === "image" ? 64 : 32;
  for (const dimension of [v.options.width, v.options.height]) if (dimension !== undefined && (dimension < minimum || dimension > maximum || dimension % multiple)) ctx.addIssue({ code: "custom", message: `Dimensions must be ${minimum}–${maximum}, in multiples of ${multiple}.` });
  if (v.options.frames !== undefined && (v.options.frames < 9 || v.options.frames > 49 || v.options.frames % 8 !== 1)) ctx.addIssue({ code: "custom", message: "Video frames must be 9–49 (8n+1)." });
});
const uuid = z.string().uuid();

function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new MediaGenerationError(408, "TIMEOUT", "Media creation exceeded its deadline. Check the destination before retrying."));
    if (signal.aborted) { abort(); void work.catch(() => {}); return; }
    signal.addEventListener("abort", abort, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Durable job metadata contains no prompts, source bytes or credentials.
 * Inference continues after the short submit request. A restart never reruns
 * an unknown outcome. Cancellation closes before the atomic file PUT begins. */
export function createMediaGenerationRouter(prisma: PrismaClient, client: MediaGenerationClient = createMediaGenerationClient()): Router {
  const router = Router();
  const running = new Map<string, AbortController>();
  let submitting = false;
  async function actor(req: Request) {
    const service = req.user?.id === "_service:mcp" && req.user.role === "service";
    const resolved = service ? await resolveAssertedUser(prisma, req.header("x-nextcloud-user") ?? "") : null;
    const browser = !service && req.user ? await prisma.user.findUnique({ where: { id: req.user.id }, select: { id: true, role: true, username: true, directoryStatus: true } }) : null;
    const person = resolved?.ok ? resolved.user : browser && browser.directoryStatus !== "DEACTIVATED" ? browser : null;
    if (!person || !roles.has(person.role)) throw new MediaGenerationError(403, "FORBIDDEN", "Media creation is not available to this actor.");
    return { id: person.id, role: person.role, username: person.username, service };
  }
  function publicJob(job: MediaGenerationJob) {
    return { id: job.id, kind: job.kind, path: job.path, status: job.status, createdAt: job.createdAt, ...(job.error ? { error: job.error } : {}), ...(job.status === "succeeded" && job.result && typeof job.result === "object" ? job.result as Record<string, unknown> : {}), ...(job.status === "running" || job.status === "saving" ? { media: mediaJobMedia(job.id) } : {}) };
  }
  async function expire() {
    await prisma.mediaGenerationJob.updateMany({ where: { status: { in: ["running", "saving"] }, deadlineAt: { lte: new Date() } }, data: { status: "failed", error: "The job exceeded its deadline or the Droplet restarted. Check the destination before retrying; it will never be overwritten." } });
  }
  async function finish(job: MediaGenerationJob, spec: MediaSpec, login: string, service: boolean, controller: AbortController) {
    const timer = setTimeout(() => controller.abort(), Math.max(1, job.deadlineAt.getTime() - Date.now()));
    try {
      const generated = await bounded(client.render(spec, controller.signal), controller.signal);
      if (controller.signal.aborted) throw new Error("deadline");
      // Recheck revocation immediately before storing a long-running result.
      const person = await bounded(prisma.user.findUnique({ where: { id: job.ownerUserId }, select: { role: true, directoryStatus: true, username: true, nextcloudUsername: true } }), controller.signal);
      const token = await bounded(getNcToken(job.ownerUserId), controller.signal);
      if (!person || person.directoryStatus === "DEACTIVATED" || !roles.has(person.role) || !token) throw new MediaGenerationError(401, "AUTH_REQUIRED", "File access expired or the actor was disabled before the result could be saved.");
      if ((service ? person.nextcloudUsername : person.username) !== login) throw new MediaGenerationError(401, "AUTH_REQUIRED", "The File Store account changed before the result could be saved. Create a new job after signing in again.");
      const claimed = await bounded(prisma.mediaGenerationJob.updateMany({ where: { id: job.id, status: "running", deadlineAt: { gt: new Date() } }, data: { status: "saving" } }), controller.signal);
      if (claimed.count !== 1 || controller.signal.aborted) return;
      await bounded(ncUploadFile(token, login, "/", job.path.slice(1), generated.bytes, { ifNoneMatch: true, signal: controller.signal }), controller.signal);
      const warnings: string[] = [];
      // A metadata outage cannot turn an acknowledged saved file into failure.
      const metadataSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]);
      try {
        const fileId = await bounded(ncGetFileId(token, login, job.path, metadataSignal), metadataSignal);
        if (fileId === null) throw new Error("metadata unavailable");
        await bounded(upsertFileRegistryEntry(prisma, { ncFileId: fileId, ownerUserId: job.ownerUserId, path: job.path, departmentId: null, sizeBytes: generated.bytes.length, sha256: createHash("sha256").update(generated.bytes).digest("hex") }), metadataSignal);
      } catch { warnings.push("The file was saved; metadata registration is pending."); }
      await bounded(invalidatePrefix(`files:list:${login}:`), metadataSignal).catch(() => {});
      const result = { path: job.path, filename: job.path.slice(1), mimeType: generated.mimeType, bytes: generated.bytes.length, seed: generated.seed, engine: generated.engine, warnings, media: fileMediaFromPath(job.path, { mimeType: generated.mimeType, size: generated.bytes.length }) };
      // Polling may already have expired the saving row. A received storage
      // acknowledgement is stronger evidence than that deadline estimate;
      // reconcile it without rerunning generation or permitting overwrite.
      await bounded(prisma.mediaGenerationJob.updateMany({ where: { id: job.id, status: { in: ["saving", "failed"] } }, data: { status: "succeeded", error: null, result: { ...result, media: { ...result.media } } as Prisma.InputJsonValue } }), AbortSignal.timeout(3000));
      void recordActivity({ kind: "file", severity: "info", sourceIcon: "file", what: "Media file created", sub: job.path, refs: { path: job.path, bytes: generated.bytes.length }, actor: { type: service ? "ai" : "user", id: job.ownerUserId } });
    } catch (error) {
      const message = error instanceof NcPreconditionFailedError ? "A file already exists at this destination. Choose another name." : error instanceof MediaGenerationError ? error.message : "Media generation failed or timed out. Check the destination before retrying; a lost storage acknowledgement can leave a saved file.";
      await bounded(prisma.mediaGenerationJob.updateMany({ where: { id: job.id, status: { in: ["running", "saving"] } }, data: { status: "failed", error: message } }), AbortSignal.timeout(3000)).catch(() => {});
    } finally { clearTimeout(timer); running.delete(job.id); }
  }
  router.post("/files/media", limit, guard, async (req, res, next) => {
    if (submitting || running.size > 0) { res.status(429).json({ code: "BUSY", error: "Local media generation is busy." }); return; }
    submitting = true;
    const submitSignal = AbortSignal.timeout(20_000);
    const within = <T>(work: Promise<T>) => bounded(work, submitSignal);
    try {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) throw new MediaGenerationError(400, "INVALID_ARGS", parsed.error.issues.map((i) => i.message).join("; "));
      const person = await within(actor(req));
      const token = person.service ? req.header("x-nextcloud-token")?.trim() : await within(resolveNcToken(req));
      if (!token || !await within(getNcToken(person.id))) throw new MediaGenerationError(401, "AUTH_REQUIRED", "Sign in with your password to connect file access for background media creation.");
      const identity = person.service ? await within(resolveAssertedNextcloudLogin(prisma, req.header("x-nextcloud-user") ?? "")) : null;
      if (identity && (!identity.ok || identity.userId !== person.id)) throw new MediaGenerationError(403, "FORBIDDEN", "Actor has no available File Store account.");
      const login = identity?.ok ? identity.login : person.username;
      const signal = submitSignal;
      if (await within(ncGetFileId(token, login, parsed.data.path, signal)) !== null) throw new MediaGenerationError(409, "ALREADY_EXISTS", "Destination already exists. Choose another name.");
      const supported = await within(client.capabilities());
      if (!supported[parsed.data.kind]) throw new MediaGenerationError(503, "NOT_CONFIGURED", "The local model for this media format is not installed.");
      await within(expire());
      if (await within(prisma.mediaGenerationJob.count({ where: { status: { in: ["running", "saving"] } } })) > 0) throw new MediaGenerationError(429, "BUSY", "A media job is still active. Check its status or wait for its deadline.");
      const spec: MediaSpec = { kind: parsed.data.kind, prompt: parsed.data.prompt, width: parsed.data.options.width ?? (parsed.data.kind === "image" ? 768 : 512), height: parsed.data.options.height ?? (parsed.data.kind === "image" ? 768 : 512), steps: parsed.data.options.steps ?? 20, seed: parsed.data.options.seed ?? randomInt(2147483648), ...(parsed.data.kind === "video" ? { frames: parsed.data.options.frames ?? 17, fps: parsed.data.options.fps ?? 16 } : {}) };
      for (const [path, key] of [[parsed.data.source_path, "source_base64"], [parsed.data.mask_path, "mask_base64"]] as const) {
        if (!path) continue;
        if (!/\.(png|jpe?g|webp)$/i.test(path)) throw new MediaGenerationError(400, "INVALID_INPUT", "Source images must be PNG, JPEG or WebP.");
        const fileId = await within(ncGetFileId(token, login, path, signal));
        if (fileId === null) throw new MediaGenerationError(404, "NOT_FOUND", "Source image not found.");
        const department = await within(resolveFileDepartment(prisma, fileId));
        if (department) {
          const access = await within(checkSpaceAccess(prisma, req, person, department, "reader"));
          if (!access.allowed) throw new MediaGenerationError(access.status, "FORBIDDEN", access.error);
        }
        const response = await within(ncFetchFileResponse(token, login, path, undefined, signal));
        if (!response) throw new MediaGenerationError(404, "NOT_FOUND", "Source image not found.");
        spec[key] = (await within(readMediaBytes(response.body, 4 * 1024 * 1024, signal))).toString("base64");
      }
      const job = await within(prisma.mediaGenerationJob.create({ data: { ownerUserId: person.id, kind: spec.kind, path: parsed.data.path, deadlineAt: new Date(Date.now() + (spec.kind === "image" ? 180_000 : 360_000)) } }));
      const controller = new AbortController(); running.set(job.id, controller);
      // Response delivery is independent of rendering. Credentials remain only
      // in session storage, not in the durable job or inference request.
      void finish(job, spec, login, person.service, controller).catch(() => {});
      res.status(202).json(publicJob(job));
    } catch (error) { if (error instanceof UnsafePathError) res.status(400).json({ code: "INVALID_ARGS", error: "Source and destination paths must identify files without traversal." }); else if (error instanceof MediaGenerationError) res.status(error.status).json({ code: error.code, error: error.message }); else if (error && typeof error === "object" && "code" in error && error.code === "P2002") res.status(429).json({ code: "BUSY", error: "A media job is already active." }); else next(error); }
    finally { submitting = false; }
  });
  router.get("/files/media", guard, async (req, res, next) => {
    const signal = AbortSignal.timeout(10_000), within = <T>(work: Promise<T>) => bounded(work, signal);
    try { const person = await within(actor(req)); await within(expire()); const jobs = await within(prisma.mediaGenerationJob.findMany({ where: { ownerUserId: person.id }, orderBy: { createdAt: "desc" }, take: 20 })); res.json({ jobs: jobs.map(publicJob) }); }
    catch (error) { if (error instanceof MediaGenerationError) res.status(error.status).json({ error: error.message }); else next(error); }
  });
  router.get("/files/media/:id", guard, async (req, res, next) => {
    const signal = AbortSignal.timeout(10_000), within = <T>(work: Promise<T>) => bounded(work, signal);
    try { const person = await within(actor(req)); if (!uuid.safeParse(req.params.id).success) { res.status(404).json({ error: "Job not found." }); return; } await within(expire()); const job = await within(prisma.mediaGenerationJob.findFirst({ where: { id: req.params.id, ownerUserId: person.id } })); if (!job) { res.status(404).json({ error: "Job not found." }); return; } res.json(publicJob(job)); }
    catch (error) { if (error instanceof MediaGenerationError) res.status(error.status).json({ error: error.message }); else next(error); }
  });
  router.post("/files/media/:id/cancel", guard, async (req, res, next) => {
    const signal = AbortSignal.timeout(10_000), within = <T>(work: Promise<T>) => bounded(work, signal);
    try {
      const person = await within(actor(req)); if (!uuid.safeParse(req.params.id).success) { res.status(404).json({ error: "Job not found." }); return; }
      const job = await within(prisma.mediaGenerationJob.findFirst({ where: { id: req.params.id, ownerUserId: person.id } }));
      if (!job) { res.status(404).json({ error: "Job not found." }); return; }
      if (job.status === "saving") { res.status(409).json({ error: "The result is being saved; cancellation is no longer available." }); return; }
      if (job.status === "running") {
        const changed = await within(prisma.mediaGenerationJob.updateMany({ where: { id: job.id, ownerUserId: person.id, status: "running" }, data: { status: "cancelled" } }));
        if (changed.count !== 1) { res.status(409).json({ error: "The job changed state. Check its current status." }); return; }
        running.get(job.id)?.abort(); job.status = "cancelled";
      }
      res.json(publicJob(job));
    } catch (error) { if (error instanceof MediaGenerationError) res.status(error.status).json({ error: error.message }); else next(error); }
  });
  return router;
}
