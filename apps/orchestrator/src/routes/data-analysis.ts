import { Router, type Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { fileMediaFromPath } from "@droplet/shared-types";
import { requireRoleOrMcpService } from "../middleware/auth.js";
import { checkSpaceAccess } from "../middleware/space.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { resolveAssertedNextcloudLogin } from "../services/asserted-nextcloud-login.service.js";
import { getNcToken, resolveNcToken } from "../services/nextcloud-session.service.js";
import { isPathUnderUser } from "../services/brain-memory.service.js";
import { ncFetchFileResponse, ncUploadFile, ncCreateDirectory, ncGetFileId } from "../services/nextcloud.client.js";
import { resolveFileDepartment, upsertFileRegistryEntry } from "../services/file-registry.service.js";
import { createDataAnalysisClient, readAnalysisBytes, ANALYSIS_INPUT_BYTES, type AnalysisClient, type AnalysisSource } from "../services/data-analysis.service.js";
import { SandboxError } from "../services/sandbox.client.js";
import { UnsafePathError } from "../lib/unsafe-path-error.js";
import { recordActivity } from "../services/activity.singleton.js";
import { invalidatePrefix } from "../services/cache.service.js";

const sourceSchema = z.object({
  path: z.string().min(1).max(4096).optional(),
  item_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
}).strict().refine((s) => Boolean(s.path) !== Boolean(s.item_id), "source needs exactly one path or item_id");
const schema = z.object({
  code: z.string().min(1).max(64_000),
  inputs: z.record(z.unknown()).default({}),
  sources: z.array(sourceSchema).max(4).default([]),
}).strict();
const ALLOWED_ROLES = new Set(["owner", "admin", "family"]);
const rateLimit = createRateLimit("data-analysis", { windowMs: 60_000, limit: 20 });
let activeAnalyses = 0;

class AnalysisRouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function formatFor(name: string): "csv" | "xlsx" {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension !== "csv" && extension !== "xlsx") throw new AnalysisRouteError(400, "Analysis sources must be UTF-8 CSV or XLSX files.");
  return extension;
}

export function createDataAnalysisRouter(prisma: PrismaClient, client: AnalysisClient = createDataAnalysisClient()): Router {
  const router = Router();
  router.post("/files/analyze", rateLimit, requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    if (activeAnalyses >= 2) { res.status(429).json({ error: "Data analysis is busy. Try again when a running analysis finishes." }); return; }
    activeAnalyses++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 55_000);
    const cancelled = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", cancelled);
    const bounded = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(new SandboxError("Data analysis was cancelled.", "TIMEOUT"));
      if (controller.signal.aborted) { abort(); void work.catch(() => {}); return; }
      controller.signal.addEventListener("abort", abort, { once: true });
      void work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
    });
    try {
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) { res.status(400).json({ error: parsed.error.issues.map((i) => i.message).join("; ") }); return; }
      const service = req.user?.id === "_service:mcp" && req.user.role === "service";
      const acting = service ? await bounded(resolveAssertedUser(prisma, req.header("x-nextcloud-user") ?? "")) : null;
      if (acting && !acting.ok) { res.status(403).json({ error: "Acting person must resolve to one active user." }); return; }
      const person = acting?.ok ? acting.user : req.user;
      if (!person || !ALLOWED_ROLES.has(person.role)) { res.status(403).json({ error: "Data analysis is not permitted for this role." }); return; }
      const userId = person.id;
      let fileIdentity: { token: string; login: string } | undefined;
      async function identity() {
        if (fileIdentity) return fileIdentity;
        const token = service ? (req.header("x-nextcloud-token") ?? "").trim() : await bounded(resolveNcToken(req));
        if (!token) throw new AnalysisRouteError(401, "File access is disconnected. Sign in with your password to reconnect it.");
        if (service) {
          const resolved = await bounded(resolveAssertedNextcloudLogin(prisma, req.header("x-nextcloud-user") ?? ""));
          if (!resolved.ok || resolved.userId !== userId) throw new AnalysisRouteError(403, "Acting person has no available File Store account.");
          fileIdentity = { token, login: resolved.login };
        } else {
          if (!req.user?.username) throw new AnalysisRouteError(401, "Sign in again to reconnect file access.");
          fileIdentity = { token, login: req.user.username };
        }
        return fileIdentity;
      }
      const sources: AnalysisSource[] = [];
      let sourceBytes = 0;
      for (const source of parsed.data.sources) {
        let name: string;
        let bytes: Buffer;
        if (source.item_id) {
          const item = await bounded(prisma.brainMemoryItem.findUnique({ where: { id: source.item_id } }));
          if (!item || item.userId !== userId || !item.hasOriginalBytes || !isPathUnderUser(userId, item.storagePath)) {
            throw new AnalysisRouteError(404, "Source attachment not found.");
          }
          if (item.ingestPolicy === "await_approval") throw new AnalysisRouteError(409, "This attachment is awaiting approval; approve it before analysis.");
          name = item.filename;
          formatFor(name);
          bytes = await bounded(readAnalysisBytes(Readable.toWeb(createReadStream(item.storagePath)) as ReadableStream<Uint8Array>, ANALYSIS_INPUT_BYTES - sourceBytes, controller.signal));
        } else {
          const path = source.path!;
          name = path.split("/").pop() ?? "";
          formatFor(name);
          const { token, login } = await identity();
          // WebDAV has its own path guard and caller token ACL. Enforce the
          // registered department's reader grant before fetching bytes too.
          const fileId = await bounded(ncGetFileId(token, login, path, controller.signal));
          if (fileId === null) throw new AnalysisRouteError(404, "Source file not found.");
          const departmentId = await bounded(resolveFileDepartment(prisma, fileId));
          if (departmentId) {
            const access = await bounded(checkSpaceAccess(prisma, req as Request, { id: userId, role: person.role }, departmentId, "reader"));
            if (!access.allowed) throw new AnalysisRouteError(access.status, access.error);
          }
          const response = await bounded(ncFetchFileResponse(token, login, path, undefined, controller.signal));
          if (!response) throw new AnalysisRouteError(404, "Source file not found.");
          bytes = await bounded(readAnalysisBytes(response.body, ANALYSIS_INPUT_BYTES - sourceBytes, controller.signal));
        }
        sourceBytes += bytes.byteLength;
        sources.push({ name, format: formatFor(name), contentBase64: bytes.toString("base64") });
      }
      const result = await bounded(client.analyze(parsed.data.code, parsed.data.inputs, sources, controller.signal));
      // Validate ALL files before the first write. Never accept arbitrary paths
      // or active content formats from a Python result / compromised peer.
      if (result.artifacts.length > 8) throw new AnalysisRouteError(502, "Analysis returned too many artifacts.");
      const seen = new Set<string>();
      const files = result.artifacts.map((artifact) => {
        if (!artifact || typeof artifact !== "object" || typeof artifact.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_. -]{0,79}$/.test(artifact.name) || artifact.name.includes("..") || seen.has(artifact.name)) {
          throw new AnalysisRouteError(502, "Analysis returned an invalid artifact name.");
        }
        seen.add(artifact.name);
        const expected = artifact.name.toLowerCase().endsWith(".csv") ? "text/csv" : artifact.name.toLowerCase().endsWith(".svg") ? "image/svg+xml" : null;
        if (!expected || artifact.mimeType !== expected || typeof artifact.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(artifact.contentBase64)) {
          throw new AnalysisRouteError(502, "Analysis returned an invalid artifact format.");
        }
        const bytes = Buffer.from(artifact.contentBase64, "base64");
        if (bytes.byteLength > 512_000 || bytes.toString("base64") !== artifact.contentBase64) throw new AnalysisRouteError(502, "Analysis artifact is oversized or malformed.");
        return { name: artifact.name, mimeType: artifact.mimeType, bytes };
      });
      const artifacts: { path: string; name: string; mimeType: string; bytes: number }[] = [];
      const artifactErrors: { name: string; error: string }[] = [];
      const warnings = [...result.warnings];
      if (files.length) {
        const current = await bounded(resolveAssertedUser(prisma, userId));
        if (!current.ok || current.user.id !== userId || !ALLOWED_ROLES.has(current.user.role)) throw new AnalysisRouteError(403, "The acting person was disabled or lost permission before results could be saved.");
        const stored = await identity();
        const token = service ? await bounded(getNcToken(userId)) : await bounded(resolveNcToken(req));
        if (!token) throw new AnalysisRouteError(401, "File access disconnected before the results could be saved.");
        const login = stored.login;
        if (service) {
          const currentLogin = await bounded(resolveAssertedNextcloudLogin(prisma, userId));
          if (!currentLogin.ok || currentLogin.userId !== userId || currentLogin.login !== login) throw new AnalysisRouteError(403, "The acting person's File Store account changed before results could be saved.");
        }
        // A fresh private folder for every invocation, outside all shared
        // mounts. No user/model path, overwrite, or run-workspace access.
        const directory = `/Analysis-${randomUUID()}`;
        await bounded(ncCreateDirectory(token, login, directory, controller.signal));
        for (const file of files) {
          const path = `${directory}/${file.name}`;
          try {
            if (controller.signal.aborted) {
              artifactErrors.push({ name: file.name, error: "The result-saving deadline was reached before this artifact could be saved." });
              continue;
            }
            await bounded(ncUploadFile(token, login, directory, file.name, file.bytes, { ifNoneMatch: true, signal: controller.signal }));
            artifacts.push({ path, name: file.name, mimeType: file.mimeType, bytes: file.bytes.byteLength });
          } catch { artifactErrors.push({ name: file.name, error: "The analysis succeeded but storage did not confirm this artifact. Retry with a fresh invocation." }); continue; }
          try {
            // Confirmed storage must survive a slow metadata peer. Limit the
            // whole bookkeeping phase, keeping time for remaining outputs.
            let metadataTimer: ReturnType<typeof setTimeout> | undefined;
            try {
              await bounded(Promise.race([
                (async () => {
                  const fileId = await ncGetFileId(token, login, path, controller.signal);
                  if (fileId === null) throw new Error("metadata unavailable");
                  await upsertFileRegistryEntry(prisma, { ncFileId: fileId, ownerUserId: userId, path, departmentId: null, sizeBytes: file.bytes.byteLength });
                })(),
                new Promise<never>((_resolve, reject) => { metadataTimer = setTimeout(() => reject(new Error("metadata deadline")), 3000); }),
              ]));
            } finally { if (metadataTimer) clearTimeout(metadataTimer); }
          } catch { warnings.push(`${file.name}: saved; metadata registration is pending.`); }
        }
        await bounded(invalidatePrefix(`files:list:${login}:`)).catch(() => {});
      }
      void recordActivity({ kind: "file", severity: "info", sourceIcon: "file", what: "Data analysis completed", sub: "Sandbox Python", refs: { sourceCount: sources.length, artifactPaths: artifacts.map((a) => a.path) }, actor: { type: service ? "ai" : "user", id: userId } });
      res.json({ ...result, warnings, artifacts, artifactErrors, media: artifacts.map((a) => fileMediaFromPath(a.path, { name: a.name, mimeType: a.mimeType, size: a.bytes })) });
    } catch (error) {
      if (controller.signal.aborted) { if (!res.destroyed) res.status(408).json({ error: "Data analysis exceeded the 55 second request deadline or was cancelled." }); return; }
      if (error instanceof AnalysisRouteError) { res.status(error.status).json({ error: error.message }); return; }
      if (error instanceof UnsafePathError) { res.status(400).json({ error: error.message }); return; }
      if (error instanceof SandboxError) {
        res.status(error.code === "NOT_CONFIGURED" ? 503 : error.code === "UNREACHABLE" ? 502 : error.code === "TIMEOUT" ? 408 : 400).json({ error: error.message }); return;
      }
      next(error);
    } finally { activeAnalyses--; clearTimeout(timer); res.removeListener("close", cancelled); }
  });
  return router;
}
