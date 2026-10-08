import { Router } from "express";
import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { z } from "zod";
import { fileMediaFromPath } from "@droplet/shared-types";
import { config } from "../config.js";
import { requireRoleOrMcpService } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { resolveAssertedNextcloudLogin } from "../services/asserted-nextcloud-login.service.js";
import { getNcToken, resolveNcToken } from "../services/nextcloud-session.service.js";
import { ncGetFileId, ncUploadFile, NcPreconditionFailedError } from "../services/nextcloud.client.js";
import { upsertFileRegistryEntry } from "../services/file-registry.service.js";
import { invalidatePrefix } from "../services/cache.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { synthesizeWav, TtsUnavailableError, TTS_PCM_BYTES, type SynthesizeOptions, type SynthesizedWav } from "../services/tts.client.js";

const schema = z.object({
  // Personal root only: a user-selected nested path can address a shared
  // mount. Moving the completed file uses the existing space-aware file API.
  path: z.string().max(255).regex(/^\/[^/\\%\x00-\x1f\x7f]+\.wav$/i, "path must be a personal-root filename such as /speech.wav").refine((s) => !/[\p{Cf}\p{Cs}]/u.test(s), "path must not contain hidden controls"),
  text: z.string().min(1).max(2_000).refine((s) => Boolean(s.trim()) && !/\p{Cs}|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(s), "text must contain speech without control characters"),
  voice: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, "voice must name an installed local voice").optional(),
}).strict();
const ALLOWED_ROLES = new Set(["owner", "admin", "family"]);
const rateLimit = createRateLimit("audio-creation", { windowMs: 60_000, limit: 10 });
let activeRequests = 0;
export type AudioSynthesizer = (options: SynthesizeOptions) => Promise<SynthesizedWav>;

/** Saves local speech as a file; never invokes voice-io or the room speaker.
 * TTS URL comes from operator configuration, never from request arguments. */
export function createAudioRouter(prisma: PrismaClient, ttsUrl: string, synthesize: AudioSynthesizer = synthesizeWav): Router {
  const router = Router();
  router.post("/files/audio", rateLimit, requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ code: "INVALID_ARGS", error: parsed.error.issues.map((i) => i.message).join("; ") }); return; }
    if (activeRequests >= 2) { res.status(429).json({ code: "AUDIO_BUSY", error: "Local speech creation is busy. Try again when it finishes." }); return; }
    activeRequests++;
    const controller = new AbortController();
    // Finish within MCP's 60 second transport ceiling. The shared signal
    // also stops the local TTS socket and any pending WebDAV operation.
    const timer = setTimeout(() => controller.abort(), 55_000);
    const cancelled = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", cancelled);
    // Also bound database/session work, whose APIs do not accept a signal.
    // Late completions are observed but cannot advance this route to a write.
    const bounded = <T>(work: Promise<T>): Promise<T> => new Promise((resolve, reject) => {
      const abort = () => reject(new TtsUnavailableError("CANCELLED", "Speech creation was cancelled."));
      if (controller.signal.aborted) { abort(); void work.catch(() => {}); return; }
      controller.signal.addEventListener("abort", abort, { once: true });
      void work.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
    });
    try {
      const service = req.user?.id === "_service:mcp" && req.user.role === "service";
      const acting = service ? await bounded(resolveAssertedUser(prisma, req.header("x-nextcloud-user") ?? "")) : null;
      if (acting && !acting.ok) { res.status(403).json({ code: "FORBIDDEN", error: "Acting person must resolve to one active user." }); return; }
      const person = acting?.ok ? acting.user : req.user;
      if (!person || !ALLOWED_ROLES.has(person.role)) { res.status(403).json({ code: "FORBIDDEN", error: "Speech creation is not permitted for this role." }); return; }
      // Human callers cannot select another person's token or login by header.
      let token = service ? (req.header("x-nextcloud-token") ?? "").trim() : await bounded(resolveNcToken(req));
      if (!token) { res.status(401).json({ code: "AUTH_REQUIRED", error: "File access is disconnected. Sign in with your password to reconnect it." }); return; }
      let login: string;
      if (service) {
        const identity = await bounded(resolveAssertedNextcloudLogin(prisma, req.header("x-nextcloud-user") ?? ""));
        if (!identity.ok || identity.userId !== person.id) { res.status(403).json({ code: "FORBIDDEN", error: "Acting person has no available File Store account." }); return; }
        login = identity.login;
      } else {
        if (!req.user?.username) { res.status(401).json({ code: "AUTH_REQUIRED", error: "Sign in again to reconnect file access." }); return; }
        login = req.user.username;
      }
      const path = parsed.data.path;
      if (await bounded(ncGetFileId(token, login, path, controller.signal)) !== null) { res.status(409).json({ code: "ALREADY_EXISTS", error: "A file already exists at this path. Choose another name.", path }); return; }
      const audio = await bounded(synthesize({ url: ttsUrl, text: parsed.data.text, ...(parsed.data.voice ? { voice: parsed.data.voice } : {}), signal: controller.signal }));
      // Keep the write boundary bounded even when an injected/alternate client
      // supplies a result. The production client validates every PCM event.
      if (!audio || !Buffer.isBuffer(audio.wav) || audio.wav.length < 46 || audio.wav.length > TTS_PCM_BYTES + 44 || audio.wav.toString("ascii", 0, 4) !== "RIFF" || audio.wav.toString("ascii", 8, 16) !== "WAVEfmt " || audio.wav.readUInt32LE(4) !== audio.wav.length - 8 || audio.wav.readUInt32LE(16) !== 16 || audio.wav.readUInt16LE(20) !== 1 || audio.wav.readUInt16LE(22) !== 1 || audio.wav.readUInt16LE(32) !== 2 || audio.wav.readUInt16LE(34) !== 16 || audio.wav.toString("ascii", 36, 40) !== "data" || audio.wav.readUInt32LE(40) !== audio.wav.length - 44 || (audio.wav.length - 44) % 2 !== 0 || !Number.isInteger(audio.sampleRate) || audio.sampleRate < 8000 || audio.sampleRate > 48000 || audio.wav.readUInt32LE(24) !== audio.sampleRate || audio.wav.readUInt32LE(28) !== audio.sampleRate * 2 || audio.durationSeconds !== (audio.wav.length - 44) / (audio.sampleRate * 2) || audio.durationSeconds > 180) {
        throw new TtsUnavailableError("PROTOCOL_ERROR", "The local speech server returned an invalid WAV file.");
      }
      if (controller.signal.aborted) throw new TtsUnavailableError("CANCELLED", "Speech creation was cancelled.");
      // Synthesis is long enough for an administrator to revoke this person
      // or for their final sign-in to end. Re-check the active role and File
      // Store session at the write boundary; captured headers are not a lease.
      if (config.AUTH_ENABLED || person.id !== "dev") {
        const current = await bounded(resolveAssertedUser(prisma, person.id));
        if (!current.ok || current.user.id !== person.id || !ALLOWED_ROLES.has(current.user.role)) {
          res.status(403).json({ code: "FORBIDDEN", error: "Speech creation access was revoked before the file could be saved." }); return;
        }
        if (service) {
          const identity = await bounded(resolveAssertedNextcloudLogin(prisma, person.id));
          if (!identity.ok || identity.userId !== person.id || identity.login !== login) {
            res.status(403).json({ code: "FORBIDDEN", error: "The acting person's File Store account changed before the file could be saved." }); return;
          }
        }
      }
      const liveToken = service ? await bounded(getNcToken(person.id)) : await bounded(resolveNcToken(req));
      if (!liveToken) {
        res.status(401).json({ code: "AUTH_REQUIRED", error: "File access disconnected before the speech could be saved. Sign in again to reconnect it." }); return;
      }
      token = liveToken;
      await bounded(ncUploadFile(token, login, "/", path.slice(1), audio.wav, { ifNoneMatch: true, signal: controller.signal }));
      const warnings: string[] = [];
      // Registry is best-effort under the existing file API's contract; a saved
      // file still returns a usable card during a metadata service outage.
      try {
        const fileId = await bounded(ncGetFileId(token, login, path, controller.signal));
        if (fileId === null) warnings.push("The file was saved; metadata registration is pending.");
        else await bounded(upsertFileRegistryEntry(prisma, { ncFileId: fileId, ownerUserId: person.id, path, departmentId: null, sizeBytes: audio.wav.length, sha256: createHash("sha256").update(audio.wav).digest("hex") }));
      } catch { warnings.push("The file was saved; metadata registration is pending."); }
      await bounded(invalidatePrefix(`files:list:${login}:`)).catch(() => {});
      void recordActivity({ kind: "file", severity: "info", sourceIcon: "file", what: "Speech audio created", sub: path, refs: { path, bytes: audio.wav.length }, actor: { type: service ? "ai" : "user", id: person.id } });
      res.json({ path, filename: path.slice(1), mimeType: "audio/wav", bytes: audio.wav.length, sampleRate: audio.sampleRate, durationSeconds: audio.durationSeconds, ...(audio.voice ? { voice: audio.voice } : {}), warnings, media: fileMediaFromPath(path, { name: path.slice(1), mimeType: "audio/wav", size: audio.wav.length }) });
    } catch (error) {
      if (error instanceof NcPreconditionFailedError) { res.status(409).json({ code: "ALREADY_EXISTS", error: "A file already exists at this path. Choose another name.", path: parsed.data.path }); return; }
      if (controller.signal.aborted) { if (!res.destroyed) res.status(408).json({ code: "AUDIO_TIMEOUT", error: "Speech creation exceeded the request deadline or was cancelled." }); return; }
      if (error instanceof TtsUnavailableError) {
        const status = error.code === "BUSY" ? 429 : error.code === "INVALID_TEXT" || error.code === "INVALID_VOICE" ? 400 : error.code === "TOO_LARGE" ? 413 : error.code === "TIMEOUT" || error.code === "CANCELLED" ? 408 : 503;
        res.status(status).json({ code: error.code === "NOT_CONFIGURED" || error.code === "UNREACHABLE" || error.code === "PROTOCOL_ERROR" || error.code === "SYNTHESIS_FAILED" ? "AUDIO_UNAVAILABLE" : `AUDIO_${error.code}`, error: error.message }); return;
      }
      next(error);
    } finally { activeRequests--; clearTimeout(timer); res.removeListener("close", cancelled); }
  });
  return router;
}
