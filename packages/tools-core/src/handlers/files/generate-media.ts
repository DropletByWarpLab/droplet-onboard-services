import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { fileMediaFromPath, parseChatMedia } from "@droplet/shared-types";
import { err, ncHeaders } from "./_render.js";

const inputSchema = {
  type: "object",
  properties: {
    action: { type: "string", description: "create(default)|status|list|cancel." },
    job_id: { type: "string", description: "Returned ID for status/cancel." },
    kind: { type: "string", description: "image or video." },
    path: { type: "string", description: "New personal-root .png/.mp4 filename." },
    prompt: { type: "string", description: "Image/edit/video description." },
    source_path: { type: "string", description: "Optional PNG/JPEG/WebP file; video needs LTX." },
    mask_path: { type: "string", description: "Optional image mask; white changes." },
    options: { type: "object", description: "Optional width,height,steps,seed; video frames (8n+1,9–49) and fps (8–24)." },
  }, additionalProperties: false,
} as const;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function savedJob(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || !uuid.test(value.id) || (value.kind !== "image" && value.kind !== "video") || typeof value.path !== "string" || !/^\/[^/\\%\x00-\x1f\x7f]+\.(png|mp4)$/i.test(value.path) || !value.path.toLowerCase().endsWith(value.kind === "image" ? ".png" : ".mp4") || !["running", "saving", "succeeded", "failed", "cancelled"].includes(String(value.status))) return null;
  const result: Record<string, unknown> = { id: value.id, kind: value.kind, path: value.path, status: value.status };
  if (typeof value.createdAt === "string") result.createdAt = value.createdAt;
  if (typeof value.error === "string") result.error = value.error;
  const media = parseChatMedia(value);
  if (value.status === "running" || value.status === "saving") {
    if (media.length !== 1 || media[0].kind !== "media_job" || media[0].jobId !== value.id) return null;
    result.media = media;
  } else if (value.status === "succeeded") {
    const mime = value.kind === "image" ? "image/png" : "video/mp4";
    const expected = fileMediaFromPath(value.path, { mimeType: mime, size: value.bytes as number });
    if (typeof value.bytes !== "number" || !Number.isInteger(value.bytes) || value.bytes < 1 || value.bytes > 20 * 1024 * 1024 || value.mimeType !== mime || typeof value.seed !== "number" || !Number.isInteger(value.seed) || value.seed < 0 || value.seed > 2147483647 || !(value.kind === "image" ? value.engine === "sdxl" : value.engine === "wan" || value.engine === "ltx") || media.length !== 1 || media[0].kind !== "file" || media[0].path !== value.path || media[0].mimeType !== mime || media[0].size !== value.bytes || media[0].name !== expected.name || media[0].previewUrl !== expected.previewUrl || media[0].downloadUrl !== expected.downloadUrl) return null;
    Object.assign(result, { bytes: value.bytes, mimeType: mime, media });
    result.seed = value.seed;
    result.engine = value.engine;
    if (Array.isArray(value.warnings) && value.warnings.every((item) => typeof item === "string")) result.warnings = value.warnings;
  }
  return result;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId) return err("AUTH_REQUIRED", "Media creation needs an acting person.");
  const action = args.action ?? "create";
  if (!["create", "status", "list", "cancel"].includes(String(action))) return err("INVALID_ARGS", "action must be create, status, list or cancel");
  const id = args.job_id;
  if ((action === "status" || action === "cancel") && (typeof id !== "string" || !uuid.test(id))) return err("INVALID_ARGS", "job_id must be a returned job id");
  const options = { headers: ncHeaders(ctx), signal: ctx.signal };
  let response: Response;
  if (action === "status") response = await ctx.http.nextcloud.get(`/media/${encodeURIComponent(id as string)}`, options);
  else if (action === "list") response = await ctx.http.nextcloud.get("/media", options);
  else if (action === "cancel") response = await ctx.http.nextcloud.post(`/media/${encodeURIComponent(id as string)}/cancel`, {}, options);
  else {
    if (!ctx.ncToken) return err("AUTH_REQUIRED", "File access is disconnected.");
    if ((args.kind !== "image" && args.kind !== "video") || typeof args.path !== "string" || args.path.length > 255 || !/^\/[^/\\%\x00-\x1f\x7f]+\.(png|mp4)$/i.test(args.path) || !args.path.toLowerCase().endsWith(args.kind === "image" ? ".png" : ".mp4") || typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.length > 4000) return err("INVALID_ARGS", "Supply image/video kind, a new personal-root PNG/MP4 path and a prompt up to 4,000 characters.");
    for (const key of ["source_path", "mask_path"]) {
      const path = args[key];
      if (path !== undefined && (typeof path !== "string" || path.length > 4096 || !path.startsWith("/") || /[\\%\x00-\x1f\x7f]/.test(path) || path.split("/").slice(1).some((part) => !part || part === "." || part === "..") || !/\.(png|jpe?g|webp)$/i.test(path))) return err("INVALID_ARGS", "Source images must be PNG, JPEG or WebP file paths without traversal.");
    }
    if (args.mask_path !== undefined && (args.kind !== "image" || typeof args.source_path !== "string")) return err("INVALID_ARGS", "Image masks require a source image.");
    if (args.options !== undefined && (!args.options || typeof args.options !== "object" || Array.isArray(args.options))) return err("INVALID_ARGS", "options must be an object.");
    const { action: _action, job_id: _job, ...body } = args;
    response = await ctx.http.nextcloud.post("/media", body, options);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = response.status === 404 ? "NOT_FOUND" : response.status === 409 ? "CONFLICT" : response.status === 429 ? "BUSY" : response.status === 401 || response.status === 403 ? "AUTH_REQUIRED" : response.status === 400 ? "INVALID_ARGS" : "MEDIA_UNAVAILABLE";
    return err(code, body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "Local media generation is unavailable.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return err("MEDIA_UNAVAILABLE", "Media generation returned an invalid job.");
  const data = body as Record<string, unknown>;
  if (action === "list") {
    if (!Array.isArray(data.jobs) || data.jobs.length > 20) return err("MEDIA_UNAVAILABLE", "Media generation returned an invalid job list.");
    const jobs = data.jobs.map(savedJob);
    if (jobs.some((job) => job === null)) return err("MEDIA_UNAVAILABLE", "Media generation returned an invalid job list.");
    return { ok: true, data: { jobs } };
  }
  const job = savedJob(data);
  if (!job || ((action === "status" || action === "cancel") && job.id !== id) || (action === "create" && (job.path !== args.path || job.kind !== args.kind))) return err("MEDIA_UNAVAILABLE", "Media generation returned an invalid job.");
  return { ok: true, data: job };
}
export default {
  name: "generate_media",
  description: "Local image/edit/short-video job; card shows saved file. Status when asked; pending is not success. Missing models fail; no overwrite.",
  inputSchema, requiresWrite: true, requiresConfirmation: false, handler,
} satisfies Tool;
