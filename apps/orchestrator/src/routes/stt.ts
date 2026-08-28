/**
 * WARP-844 — `POST /api/stt`: speech-to-text for the dashboard's chat
 * voice input.
 *
 * The browser captures raw 16-bit little-endian mono PCM via Web Audio
 * (no MediaRecorder containers, so no ffmpeg anywhere) and posts it as
 * `application/octet-stream` with the sample rate in `?rate=`. The route
 * streams it to the wyoming-faster-whisper sidecar — the SAME container
 * voice-io uses — over the Wyoming TCP protocol and returns `{ text }`.
 *
 * Availability: the whisper container ships under the `linux` compose
 * profile (production appliances). On macOS dev installs (or whenever the
 * sidecar is down) the route answers 503 `stt_unavailable` and the
 * dashboard hides/disables the mic gracefully.
 *
 * STT_URL mirrors voice-io's convention (`tcp://host:port`).
 */
import { Router, type Request } from "express";
import express from "express";
import { requireRole } from "../middleware/auth.js";
import {
  transcribePcm,
  SttUnavailableError,
} from "../services/stt.client.js";

const DEFAULT_STT_URL = "tcp://wyoming-faster-whisper:10300";

/** Whisper decodes on shared appliance CPU; each transcription holds a
 *  worker for seconds. Bound concurrent requests so an authenticated
 *  client (or several open tabs) can't queue unbounded work onto the
 *  sidecar — excess callers get 429 and simply retry their dictation. */
const MAX_CONCURRENT_TRANSCRIPTIONS = 2;

/** 16 kHz × 2 bytes × 60 s ≈ 1.9 MB; 10 MB allows ~5 min of speech. */
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export function createSttRouter(): Router {
  const router = Router();
  let inFlight = 0;

  router.post(
    "/stt",
    requireRole("owner", "admin", "family", "guest"),
    express.raw({ type: () => true, limit: `${MAX_AUDIO_BYTES}b` }),
    async (req: Request, res, next) => {
      if (inFlight >= MAX_CONCURRENT_TRANSCRIPTIONS) {
        res.setHeader("Retry-After", "2");
        res.status(429).json({ error: "stt_busy" });
        return;
      }
      inFlight++;
      try {
        const pcm = req.body as Buffer;
        if (!Buffer.isBuffer(pcm) || pcm.length < 2) {
          res.status(400).json({ error: "empty_audio" });
          return;
        }
        // CodeQL js/type-confusion-through-parameter-tampering: `?rate=a&rate=b`
        // arrives as an array — only a single string (or absence) is a rate.
        const rawRate = req.query.rate;
        if (rawRate !== undefined && typeof rawRate !== "string") {
          res.status(400).json({ error: "invalid_rate" });
          return;
        }
        const rate = Number.parseInt(rawRate ?? "16000", 10);
        if (!Number.isFinite(rate) || rate < 8000 || rate > 48000) {
          res.status(400).json({ error: "invalid_rate" });
          return;
        }
        const text = await transcribePcm({
          url: process.env.STT_URL ?? DEFAULT_STT_URL,
          pcm,
          rate,
        });
        res.json({ text });
      } catch (err) {
        if (err instanceof SttUnavailableError) {
          // eslint-disable-next-line no-console
          console.warn("[stt] unavailable:", err.message);
          res.status(503).json({ error: "stt_unavailable" });
          return;
        }
        next(err);
      } finally {
        inFlight--;
      }
    },
  );

  return router;
}
