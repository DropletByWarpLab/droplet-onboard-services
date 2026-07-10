/**
 * WARP-1036 — `/api/voice/*`: dashboard-facing proxy in front of the
 * voice-io container (the always-on "hey droplet" assistant).
 *
 * voice-io has NO auth of its own — it binds on the internal Docker
 * network only — so this route is the auth wall, exactly like the
 * admin-rag-eval proxy. Owner/admin only: voice status exposes the last
 * transcript + reply (household-private speech), and `/say` drives the
 * room speaker. Service principals are denied by the same guard
 * (`requireRole` never lists the `service` role here).
 *
 * Availability: voice-io ships under the `linux` compose profile
 * (production appliances). On macOS dev installs (or whenever the
 * container is down) the proxy fetch fails and every route answers
 * 503 `voice_unavailable` — the setup wizard's voice step keys its
 * auto-skip on exactly that shape (mirrors stt.ts's `stt_unavailable`
 * contract). An upstream HTTP error (voice-io reachable but the
 * pipeline faulted) is relayed verbatim instead, so a real fault stays
 * visible rather than reading as "not installed".
 */
import { Router, type Response } from "express";
import { requireRole } from "../middleware/auth.js";
import { createLogger } from "../lib/logger.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";

const logger = createLogger("voice");

const DEFAULT_VOICE_IO_URL = "http://voice-io:8086";

/** Status/devices are in-memory reads on voice-io — fast. */
const READ_TIMEOUT_MS = 10_000;

/** `/voice/say` blocks for Piper synthesis + full playback duration. */
const SAY_TIMEOUT_MS = 30_000;

/**
 * WARP-1055 — `/audio/measure` blocks for the requested capture window
 * (up to 30 s) and `/audio/echo-check` for playback + simultaneous
 * capture. Generous so a slow ALSA open on the box never reads as
 * "voice unavailable" mid-wizard.
 */
const MEASURE_TIMEOUT_MS = 45_000;
const ECHO_CHECK_TIMEOUT_MS = 30_000;

/** Mirrors voice-io's own SayRequest bound (main.py: max 2000 chars). */
const MAX_SAY_TEXT_CHARS = 2000;

/** Mirrors voice-io's MeasureRequest bounds (main.py). */
const MEASURE_KINDS = new Set(["noise_floor", "speech_peak"]);
const MEASURE_SECONDS_MIN = 1;
const MEASURE_SECONDS_MAX = 30;

/** WARP-1059 — mirrors voice-io's CalibrationModeRequest ttl_s bounds. */
const CALIBRATION_MODE_TTL_MIN_S = 5;
const CALIBRATION_MODE_TTL_MAX_S = 300;

function voiceIoBaseUrl(): string {
  // WARP-236: https:// + client cert when internal mTLS is on (identity when off).
  const url = internalBaseUrl(process.env.VOICE_IO_URL ?? DEFAULT_VOICE_IO_URL);
  return url.replace(/\/+$/, "");
}

/**
 * Proxy one request to voice-io and relay its status + JSON verbatim.
 * Centralises the 503-on-unreachable contract so every endpoint behaves
 * identically when the `linux` profile is inactive.
 */
async function proxy(
  res: Response,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<void> {
  const target = `${voiceIoBaseUrl()}${path}`;
  try {
    const init: RequestInit = {
      method,
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (method === "POST") {
      init.headers = {
        ...(init.headers as Record<string, string>),
        "Content-Type": "application/json",
      };
      init.body = JSON.stringify(body ?? {});
    }
    const upstream = await internalFetch(target, init);

    // Relay upstream status + JSON verbatim (FastAPI always answers JSON);
    // fall back to a clean shape if a body somehow isn't parseable.
    const text = await upstream.text();
    let payload: unknown = {};
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    res.status(upstream.status).json(payload);
  } catch (err) {
    // Connection refused / DNS failure (profile inactive) or timeout.
    logger.warn(
      { err: (err as Error)?.message, target, method },
      "voice-io proxy fetch failed — treating as unavailable",
    );
    res.status(503).json({ error: "voice_unavailable" });
  }
}

export function createVoiceRouter(): Router {
  const router = Router();

  // Owner/admin only across the whole surface — the guard's allowlist
  // never includes `service`, so service principals are denied too.
  const guard = requireRole("owner", "admin");

  router.get("/voice/status", guard, async (_req, res) => {
    await proxy(res, "GET", "/voice/status");
  });

  router.get("/voice/devices", guard, async (_req, res) => {
    await proxy(res, "GET", "/audio/devices");
  });

  router.post("/voice/say", guard, async (req, res) => {
    const text: unknown = req.body?.text;
    if (typeof text !== "string" || text.trim().length === 0) {
      res.status(400).json({ error: "empty_text" });
      return;
    }
    if (text.length > MAX_SAY_TEXT_CHARS) {
      res.status(400).json({ error: "text_too_long" });
      return;
    }
    // Only `text` is forwarded — the voice (Piper model) stays the
    // box-configured default; the wizard's speaker test has no business
    // switching voices.
    await proxy(res, "POST", "/voice/say", { text }, SAY_TIMEOUT_MS);
  });

  // ── WARP-1055: calibration wizard measurement + persistence ──

  router.post("/voice/measure", guard, async (req, res) => {
    const kind: unknown = req.body?.kind;
    if (typeof kind !== "string" || !MEASURE_KINDS.has(kind)) {
      res.status(400).json({ error: "invalid_kind" });
      return;
    }
    const seconds: unknown = req.body?.seconds;
    if (seconds !== undefined) {
      if (
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds < MEASURE_SECONDS_MIN ||
        seconds > MEASURE_SECONDS_MAX
      ) {
        res.status(400).json({ error: "invalid_seconds" });
        return;
      }
    }
    // Only the validated fields are forwarded; when `seconds` is absent
    // voice-io applies its own per-kind default.
    const body: { kind: string; seconds?: number } = { kind };
    if (typeof seconds === "number") body.seconds = seconds;
    await proxy(res, "POST", "/audio/measure", body, MEASURE_TIMEOUT_MS);
  });

  router.post("/voice/echo-check", guard, async (_req, res) => {
    // Fully automatic on the box side (play a tone + listen for it) —
    // no client-controlled parameters to validate or forward.
    await proxy(res, "POST", "/audio/echo-check", {}, ECHO_CHECK_TIMEOUT_MS);
  });

  // ── WARP-1059: calibration mode (wizard-scoped wake suppression) ──
  //
  // The wizard enters/renews this around its measure/echo/wake-test
  // windows so the spec phrase can't start a full assistant turn (STT
  // pausing the detector, the reply spoken through the box speaker
  // polluting a measurement). voice-io keeps wake DETECTION counting;
  // the mode auto-expires (TTL) so an abandoned wizard can never leave
  // the assistant deaf.

  router.post("/voice/calibration-mode", guard, async (req, res) => {
    const ttl: unknown = req.body?.ttl_s;
    if (ttl !== undefined) {
      if (
        typeof ttl !== "number" ||
        !Number.isFinite(ttl) ||
        ttl < CALIBRATION_MODE_TTL_MIN_S ||
        ttl > CALIBRATION_MODE_TTL_MAX_S
      ) {
        res.status(400).json({ error: "invalid_ttl" });
        return;
      }
    }
    // Only the validated field is forwarded; when `ttl_s` is absent
    // voice-io applies its own default.
    const body: { ttl_s?: number } = {};
    if (typeof ttl === "number") body.ttl_s = ttl;
    await proxy(res, "POST", "/voice/calibration-mode", body);
  });

  router.delete("/voice/calibration-mode", guard, async (_req, res) => {
    // Idempotent exit — voice-io answers {active: false} even when the
    // pipeline never started, so wizard close paths can fire it blind.
    await proxy(res, "DELETE", "/voice/calibration-mode");
  });

  router.get("/voice/calibration", guard, async (_req, res) => {
    await proxy(res, "GET", "/voice/calibration");
  });

  router.post("/voice/calibration", guard, async (req, res) => {
    // Shape validation belongs to voice-io's pydantic model (it 422s
    // with field-level detail we relay verbatim); here we only reject
    // bodies that aren't JSON objects at all.
    const body: unknown = req.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      res.status(400).json({ error: "invalid_calibration" });
      return;
    }
    await proxy(res, "POST", "/voice/calibration", body);
  });

  return router;
}
