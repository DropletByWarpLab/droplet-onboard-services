import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { fileMediaFromPath } from "@droplet/shared-types";
import { err, ncHeaders } from "./_render.js";

const inputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "New personal-root .wav filename, e.g. /narration.wav." },
    text: { type: "string", description: "Speech text, 1–2,000 characters." },
    voice: { type: "string", description: "Optional installed local voice name; omitted uses the server default." },
  },
  required: ["path", "text"],
  additionalProperties: false,
} as const;

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.userId || !ctx.ncToken) return err("AUTH_REQUIRED", "File access is disconnected.");
  if (typeof args.path !== "string" || args.path.length > 255 || !/^\/[^/\\%\x00-\x1f\x7f]+\.wav$/i.test(args.path) || /[\p{Cf}\p{Cs}]/u.test(args.path)) return err("INVALID_PATH", "path must be a new personal-root filename such as /speech.wav");
  if (typeof args.text !== "string" || !args.text.trim() || args.text.length > 2_000 || /\p{Cs}|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(args.text)) return err("INVALID_ARGS", "text must contain 1–2,000 characters without control characters");
  if (args.voice !== undefined && (typeof args.voice !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(args.voice))) return err("INVALID_ARGS", "voice must name an installed local voice");
  const res = await ctx.http.nextcloud.post("/audio", { path: args.path, text: args.text, ...(args.voice !== undefined ? { voice: args.voice } : {}) }, { headers: ncHeaders(ctx), signal: ctx.signal });
  const value: unknown = await res.json().catch(() => null);
  const body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (!res.ok) {
    const code = res.status === 409 ? "ALREADY_EXISTS" : res.status === 401 || res.status === 403 ? "AUTH_REQUIRED" : res.status === 400 ? "INVALID_ARGS" : res.status === 413 ? "TOO_LARGE" : res.status === 429 ? "AUDIO_BUSY" : res.status === 408 ? "AUDIO_TIMEOUT" : "AUDIO_UNAVAILABLE";
    return err(code, typeof body.error === "string" ? body.error : "Local speech creation is unavailable.");
  }
  if (body.path !== args.path || typeof body.filename !== "string" || body.filename !== args.path.slice(1) || body.mimeType !== "audio/wav" || typeof body.bytes !== "number" || !Number.isInteger(body.bytes) || body.bytes < 46 || body.bytes > 10 * 1024 * 1024 || typeof body.durationSeconds !== "number" || !Number.isFinite(body.durationSeconds) || body.durationSeconds <= 0 || body.durationSeconds > 180 || typeof body.sampleRate !== "number" || !Number.isInteger(body.sampleRate) || body.sampleRate < 8_000 || body.sampleRate > 48_000) return err("AUDIO_UNAVAILABLE", "Speech creation returned no valid saved audio metadata.");
  return { ok: true, data: { path: body.path, filename: body.filename, mimeType: "audio/wav", bytes: body.bytes, sampleRate: body.sampleRate, durationSeconds: body.durationSeconds, ...(typeof body.voice === "string" ? { voice: body.voice } : {}), warnings: Array.isArray(body.warnings) ? body.warnings.filter((warning): warning is string => typeof warning === "string") : [], media: fileMediaFromPath(body.path, { name: body.filename, mimeType: "audio/wav", size: body.bytes }) } };
}

const tool: Tool = {
  name: "create_audio",
  description: "Create a downloadable WAV speech file using local Kokoro/Piper voices. Refuses overwrite. Saves to personal files without playing on the room speaker.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};
export default tool;
