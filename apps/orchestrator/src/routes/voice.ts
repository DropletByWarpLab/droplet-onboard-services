/**
 * WARP-1036 — `/api/voice/*`: dashboard-facing proxy in front of the
 * voice-io container (the always-on "hey droplet" assistant).
 *
 * voice-io has NO auth of its own — it binds on the internal Docker
 * network only — so this route is the auth wall, exactly like the
 * admin-rag-eval proxy. Owner/admin only: voice status exposes the last
 * transcript + reply (household-private speech), and `/say` drives the
 * room speaker. Service principals are denied by the same guard
 * (`requireRole` never lists the `service` role here) — the one
 * exception is POST /voice/events (WARP-1058), which is the inverse:
 * ONLY the `_service:voice` principal may push pipeline events into
 * the activity chain, and every human role is denied.
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
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { createLogger } from "../lib/logger.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import type { ActivitySeverityName } from "../services/audit-signing.service.js";

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

/**
 * WARP-1057 — `/voice/restart-processor` execs `xvf_host REBOOT 1` on
 * the box (voice-io's subprocess deadline is 10 s by default); double
 * that so a slow USB control write never reads as "voice unavailable".
 */
const RESTART_TIMEOUT_MS = 20_000;

/**
 * WARP-1599 — `/voice/enabled` is not a read, so it does not get the
 * read budget. On ENABLE voice-io runs `_build_and_start_pipeline()`
 * inline — the very function its own `startup()` hands to a worker
 * thread precisely because it blocks. Worst case, summed: persona
 * `get_block()` 2 s + the ipapi.co geo lookup 5 s + `pipeline.start()`'s
 * three synchronous upstream probes (STT 5 s, TTS 5 s, LLM 2 s) ≈ 19 s.
 * Disable is bounded too — `stop(timeout=5.0)` joins two threads.
 *
 * Typical is sub-second, but a WAN hiccup or a wedged worker walks past
 * 10 s, and an abort there is not a cosmetic 503: the box has already
 * flipped, the non-2xx skips `recordActivity`, and the audit chain ends
 * up with no record of the single most consequential thing an admin can
 * do to this surface. Sized the same way RESTART_TIMEOUT_MS above is —
 * double the real upstream budget — so only a genuinely stuck box times
 * out.
 */
const ENABLED_TIMEOUT_MS = 40_000;

/** Mirrors voice-io's own SayRequest bound (main.py: max 2000 chars). */
const MAX_SAY_TEXT_CHARS = 2000;

/** Mirrors voice-io's MeasureRequest bounds (main.py). */
const MEASURE_KINDS = new Set(["noise_floor", "speech_peak"]);
const MEASURE_SECONDS_MIN = 1;
const MEASURE_SECONDS_MAX = 30;

/** WARP-1059 — mirrors voice-io's CalibrationModeRequest ttl_s bounds. */
const CALIBRATION_MODE_TTL_MIN_S = 5;
const CALIBRATION_MODE_TTL_MAX_S = 300;

/**
 * WARP-1058 — voice-io → activity-chain event bridge.
 *
 * voice-io pushes pipeline events (wake outcomes, DSP wedge/recovery)
 * to POST /api/voice/events over the SAME channel it already uses for
 * /api/llm/chat and /api/persona/prompt: HTTP with the
 * `ORCHESTRATOR_TOKEN` bearer, which authMiddleware resolves to the
 * `_service:voice` principal. The orchestrator — not voice-io — owns
 * the signed rows' copy: the wire carries only a typed event plus
 * measured context (score/threshold/model), and this table maps it to
 * the §3.4 outcome wording the /voice feed renders verbatim. A
 * compromised or buggy container can therefore never inject arbitrary
 * text into the audit chain.
 *
 * `person` is "Guest" on every wake row until voice enrollment
 * (WARP-1056) lands — §3.3: unrecognized voices are guests.
 */
const VOICE_EVENT_ROWS: Record<
  string,
  { severity: ActivitySeverityName; what: string; person?: string }
> = {
  wake_answered: { severity: "info", what: "Answered", person: "Guest" },
  wake_heard: {
    severity: "info",
    what: "Heard the wake word",
    person: "Guest",
  },
  wake_ignored: {
    severity: "info",
    what: "Ignored — below confidence",
    person: "Guest",
  },
  wake_missed: { severity: "warn", what: "Missed wake word", person: "Guest" },
  dsp_wedge: { severity: "err", what: "Mic processor stopped responding" },
  dsp_recovered: { severity: "info", what: "Mic processor recovered" },
};

const voiceEventSchema = z.object({
  type: z.enum([
    "wake_answered",
    "wake_heard",
    "wake_ignored",
    "wake_missed",
    "dsp_wedge",
    "dsp_recovered",
  ]),
  /** Event wall time (epoch seconds) — the reporter queues events, so
   *  "now" at record time can lag the actual detection by seconds. */
  at: z.number().finite().optional(),
  score: z.number().finite().optional(),
  threshold: z.number().finite().optional(),
  model: z.string().max(200).optional(),
});

/** Clamp a caller-supplied event time into a sane window so a skewed
 *  container clock can't back- or forward-date signed rows. */
const EVENT_AT_MAX_PAST_S = 3600;
const EVENT_AT_MAX_FUTURE_S = 60;

function eventDate(atS: number | undefined, nowMs: number): Date {
  if (atS === undefined) return new Date(nowMs);
  const atMs = atS * 1000;
  if (
    atMs < nowMs - EVENT_AT_MAX_PAST_S * 1000 ||
    atMs > nowMs + EVENT_AT_MAX_FUTURE_S * 1000
  ) {
    return new Date(nowMs);
  }
  return new Date(atMs);
}

/**
 * Guard for the event bridge: EXACTLY the voice-io service principal.
 * Humans (any role) are denied — voice events describe what the box
 * heard; a dashboard session has no business forging them — and so is
 * every other service principal (mcp/email/…), which keeps the coarse
 * `service` role from becoming an audit-row injection path.
 */
function requireVoiceServicePrincipal(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (req.user?.id === "_service:voice" && req.user.role === "service") {
    next();
    return;
  }
  res.status(403).json({ error: "Forbidden: voice-io service only" });
}

function voiceIoBaseUrl(): string {
  // WARP-236: https:// + client cert when internal mTLS is on (identity when off).
  const url = internalBaseUrl(process.env.VOICE_IO_URL ?? DEFAULT_VOICE_IO_URL);
  return url.replace(/\/+$/, "");
}

/**
 * Proxy one request to voice-io and relay its status + JSON verbatim.
 * Centralises the 503-on-unreachable contract so every endpoint behaves
 * identically when the `linux` profile is inactive. Returns the HTTP
 * status it relayed (503 on unreachable) so a caller that audits the
 * outcome (WARP-1057 restart) doesn't need its own fetch path.
 */
async function proxy(
  res: Response,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<number> {
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
    return upstream.status;
  } catch (err) {
    // Connection refused / DNS failure (profile inactive) or timeout.
    logger.warn(
      { err: (err as Error)?.message, target, method },
      "voice-io proxy fetch failed — treating as unavailable",
    );
    res.status(503).json({ error: "voice_unavailable" });
    return 503;
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
    const status = await proxy(res, "POST", "/voice/calibration", body);
    // WARP-1058 — a persisted calibration is a hardware-tuning write;
    // it leaves an activity row like the restart below. Only on
    // success: a rejected/failed apply changed nothing on the box.
    // Fire-and-forget after the response is committed (recordActivity
    // swallows recorder failures).
    if (status >= 200 && status < 300) {
      const record = body as Record<string, unknown>;
      const floor = record.noise_floor_dbfs;
      const wakes = record.wake_detections;
      const subParts: string[] = [];
      if (typeof floor === "number" && Number.isFinite(floor)) {
        subParts.push(`noise floor ${floor} dB`);
      }
      if (typeof wakes === "number" && Number.isFinite(wakes)) {
        subParts.push(`wake word ${wakes}/3`);
      }
      void recordActivity({
        kind: "voice",
        severity: "ok",
        sourceIcon: "mic",
        what: "Calibration applied",
        sub: subParts.length > 0 ? subParts.join(" · ") : null,
        refs: { surface: "voice-calibration", upstreamStatus: status },
        actor: actorFromRequest(req),
      });
    }
  });

  // ── WARP-1057: XVF3800 DSP restart (wedge recovery) ──

  router.post("/voice/restart-processor", guard, async (req: Request, res) => {
    // No client-controlled parameters — the action IS the payload.
    // voice-io execs `xvf_host REBOOT 1` (the host watchdog's exact
    // heal); the DSP re-enumerates over ~10 s and the flatline flag
    // clears once audio flows again.
    const status = await proxy(
      res,
      "POST",
      "/voice/restart-processor",
      {},
      RESTART_TIMEOUT_MS,
    );
    // Audited like the sibling write surfaces (scenes, people, device
    // identity): a write that drives hardware always leaves an activity
    // row, success or failure. Fire-and-forget AFTER the response is
    // committed — an audit hiccup must never turn a completed DSP
    // reboot into a 500 (recordActivity swallows recorder failures).
    const ok = status >= 200 && status < 300;
    void recordActivity({
      // WARP-1058: kind `voice` (was `system`) so restarts surface in
      // the /voice "Recent voice activity" feed's kind filter — the
      // §6.3 self-heal-transparency row.
      kind: "voice",
      severity: ok ? "info" : "err",
      sourceIcon: "mic",
      what: ok ? "Voice processor restarted" : "Voice processor restart failed",
      sub: "XVF3800 DSP reboot (xvf_host REBOOT 1)",
      refs: { surface: "voice-restart-processor", upstreamStatus: status },
      actor: actorFromRequest(req),
    });
  });

  // ── WARP-1599: the voice kill switch ──

  router.post("/voice/enabled", guard, async (req: Request, res) => {
    // Strict boolean, no coercion. voice-io's own model is StrictBool
    // precisely so a string "false" can never silence the box by
    // accident; the proxy has to agree with it, or the same request
    // would mean two different things depending on which layer read it.
    // Rejecting here also means a malformed body never reaches the box.
    const enabled: unknown = req.body?.enabled;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "invalid_enabled" });
      return;
    }
    // ENABLED_TIMEOUT_MS, not the read budget: enabling builds and
    // starts the whole pipeline inline (see the constant). A concurrent
    // toggle's 409 (voice-io's non-blocking lock) relays verbatim like
    // any other upstream status.
    const status = await proxy(
      res,
      "POST",
      "/voice/enabled",
      { enabled },
      ENABLED_TIMEOUT_MS,
    );
    // Silencing the household assistant is the single most consequential
    // thing an admin can do to this surface — it leaves a row so nobody
    // is left wondering why Droplet stopped answering. Only on success:
    // a 409/422/503 changed nothing on the box, so a row would be a lie.
    // Fire-and-forget AFTER the response is committed — an audit hiccup
    // must never turn a committed toggle into an error (recordActivity
    // swallows recorder failures).
    if (status >= 200 && status < 300) {
      void recordActivity({
        // kind `voice`, not `system`, on WARP-1058's precedent: the row
        // belongs in the /voice feed, keyed to `/api/activity?kind=voice`.
        kind: "voice",
        severity: "info",
        sourceIcon: "mic",
        what: enabled ? "Voice turned on" : "Voice turned off",
        sub: enabled
          ? "Droplet is listening for the wake word again"
          : "Droplet stopped listening — the wake word is off until voice is turned back on",
        refs: { surface: "voice-enabled", upstreamStatus: status },
        actor: actorFromRequest(req),
      });
    }
  });

  // ── WARP-1058: voice-io → activity-chain event bridge ──

  router.post(
    "/voice/events",
    requireVoiceServicePrincipal,
    async (req: Request, res) => {
      const parsed = voiceEventSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_event",
          details: parsed.error.flatten(),
        });
        return;
      }
      const { type, at, score, threshold, model } = parsed.data;
      const row = VOICE_EVENT_ROWS[type]!;
      const refs: Record<string, unknown> = {
        surface: "voice-io",
        principal: req.user!.id,
      };
      if (row.person !== undefined) refs.person = row.person;
      if (score !== undefined) refs.score = score;
      if (threshold !== undefined) refs.threshold = threshold;
      if (model !== undefined) refs.model = model;
      // Awaited so the reporter's sequential queue preserves event
      // order in the chain; recordActivity swallows recorder failures.
      const recorded = await recordActivity({
        kind: "voice",
        severity: row.severity,
        sourceIcon: "mic",
        what: row.what,
        sub: row.person ?? null,
        refs,
        actor: actorFromRequest(req),
        at: eventDate(at, Date.now()),
      });
      res.status(202).json({ recorded: recorded !== null });
    },
  );

  return router;
}
