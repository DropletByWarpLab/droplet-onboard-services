/**
 * WARP-1036 — `/api/voice/*`: dashboard-facing proxy in front of the
 * voice-io container (the always-on "hey droplet" assistant).
 *
 * voice-io has NO auth of its own — it binds on the internal Docker
 * network only — so this route is the auth wall, exactly like the
 * admin-rag-eval proxy. Owner/admin only: `/say` drives the room speaker,
 * and voice-io's status carries the last transcript + reply (private speech
 * in the room), which this proxy STRIPS from `GET /voice/status` unless the
 * caller asks for them (WARP-3396, below). Service principals are denied by
 * the same guard (`requireRole` never lists the `service` role here) — the one
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
import { serviceBearerHeader, VOICE_IO_TOKEN_ENV } from "../lib/service-bearer.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import type { ActivitySeverityName } from "../services/audit-signing.service.js";

const logger = createLogger("voice");

const DEFAULT_VOICE_IO_URL = "http://voice-io:8086";

/** Status/devices are in-memory reads on voice-io — fast. */
const READ_TIMEOUT_MS = 10_000;

/** `/voice/say` waits for CPU synthesis and playback. */
const SAY_TIMEOUT_MS = 90_000;

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
 * WARP-3710 - `/voice/mic/restart` waits (up to ~15 s) for the replacement
 * capture stream, optionally after a DSP reboot (<= 10 s) and a second
 * re-pick once the chip has re-enumerated, so it can legitimately run
 * ~40 s. Sized above that so a slow-but-successful restart never reads as
 * "voice unavailable".
 */
const MIC_RESTART_TIMEOUT_MS = 50_000;

/**
 * WARP-3710 - `/voice/mic/test` captures up to 10 s and, when asked,
 * plays the clip back (another <= 10 s) before answering.
 */
const MIC_TEST_TIMEOUT_MS = 35_000;
const MIC_TEST_SECONDS_MIN = 1;
const MIC_TEST_SECONDS_MAX = 10;

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
const voiceIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
const speakingVoiceSchema = z.object({ voice: voiceIdSchema }).strict();

/** Mirrors voice-io's MeasureRequest bounds (main.py). */
const MEASURE_KINDS = new Set(["noise_floor", "speech_peak"]);
const MEASURE_SECONDS_MIN = 1;
const MEASURE_SECONDS_MAX = 30;

/** WARP-1059 — mirrors voice-io's CalibrationModeRequest ttl_s bounds. */
const CALIBRATION_MODE_TTL_MIN_S = 5;
const CALIBRATION_MODE_TTL_MAX_S = 300;

/**
 * Speaker output volume — mirrors voice-io's VolumeRequest: EXACTLY one
 * of an integer `level` (0-100), an integer `change` (-100..100) or a
 * boolean `muted`. Strict, no coercion, unknown keys rejected — same
 * reasoning as `/voice/enabled`: the proxy and the box must read a body
 * the same way, so a string "true" can never mute the speaker here and
 * mean something else there.
 */
const volumeRequestSchema = z.union([
  z.object({ level: z.number().int().min(0).max(100) }).strict(),
  z.object({ change: z.number().int().min(-100).max(100) }).strict(),
  z.object({ muted: z.boolean() }).strict(),
]);

/** The fields of voice-io's POST /voice/volume answer the audit row reads. */
const volumeChangeSchema = z.object({
  level: z.number(),
  muted: z.boolean(),
  previous_level: z.number(),
  previous_muted: z.boolean(),
});

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
  /** Reshapes the relayed JSON (WARP-3396: drop the transcript fields). */
  transform?: (payload: unknown) => unknown,
): Promise<number> {
  return (await proxyWithPayload(res, method, path, body, timeoutMs, transform)).status;
}

/**
 * `proxy()`, also handing back the payload it relayed — for a write whose
 * audit row quotes the box's answer (the volume it actually landed on)
 * rather than the request. Same fetch, same 503 contract.
 */
async function proxyWithPayload(
  res: Response,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs: number = READ_TIMEOUT_MS,
  /** Reshapes the relayed JSON (WARP-3396: drop the transcript fields). */
  transform?: (payload: unknown) => unknown,
): Promise<{ status: number; payload: unknown }> {
  const target = `${voiceIoBaseUrl()}${path}`;
  try {
    const init: RequestInit = {
      method,
      // WARP-3625: voice-io fails closed without the shared service bearer.
      headers: { Accept: "application/json", ...serviceBearerHeader(VOICE_IO_TOKEN_ENV) },
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
    const relayed = transform ? transform(payload) : payload;
    res.status(upstream.status).json(relayed);
    return { status: upstream.status, payload: relayed };
  } catch (err) {
    // Connection refused / DNS failure (profile inactive) or timeout.
    logger.warn(
      { err: (err as Error)?.message, target, method },
      "voice-io proxy fetch failed — treating as unavailable",
    );
    const payload = { error: "voice_unavailable" };
    res.status(503).json(payload);
    return { status: 503, payload };
  }
}

/**
 * WARP-3396 — what was last SAID in the room and what the assistant answered.
 * voice-io keeps them until the next wake; nothing on the dashboard's Voice
 * page or the Home row reads them, yet the page polls the status every second,
 * so they sat in every open tab's memory, HAR export and proxy log. The
 * default status answer leaves them out.
 */
const TRANSCRIPT_FIELDS = [
  "last_transcript",
  "last_transcript_at",
  "last_response",
  "last_response_at",
] as const;

function withoutTranscript(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const out: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  for (const field of TRANSCRIPT_FIELDS) delete out[field];
  return out;
}

export function createVoiceRouter(): Router {
  const router = Router();

  // Owner/admin only across the whole surface — the guard's allowlist
  // never includes `service`, so service principals are denied too.
  const guard = requireRole("owner", "admin");

  // `?include=transcript` is the setup wizard's voice step asking for "what it
  // heard" during its one try-it; owner/admin only like the rest of the route.
  router.get("/voice/status", guard, async (req, res) => {
    const withTranscript = req.query.include === "transcript";
    await proxy(
      res,
      "GET",
      "/voice/status",
      undefined,
      READ_TIMEOUT_MS,
      withTranscript ? undefined : withoutTranscript,
    );
  });

  // WARP-3710: inputs/outputs with score + bus, best first, and the active
  // pair. A superset of the old /audio/devices answer (its keys survive).
  router.get("/voice/devices", guard, async (_req, res) => {
    await proxy(res, "GET", "/voice/devices");
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
    const voice: unknown = req.body?.voice;
    if (voice !== undefined && !voiceIdSchema.safeParse(voice).success) {
      res.status(400).json({ error: "invalid_voice" });
      return;
    }
    // A temporary preview. voice-io checks the running service's installed
    // allowlist; the preview never changes the persisted speaking voice.
    const body: { text: string; voice?: string } = { text };
    if (typeof voice === "string") body.voice = voice;
    await proxy(res, "POST", "/voice/say", body, SAY_TIMEOUT_MS);
  });

  router.get("/voice/speaking-voice", guard, async (_req, res) => {
    await proxy(res, "GET", "/voice/speaking-voice");
  });

  router.post("/voice/speaking-voice", guard, async (req, res) => {
    const parsed = speakingVoiceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_voice" });
      return;
    }
    const { status, payload } = await proxyWithPayload(res, "POST", "/voice/speaking-voice", parsed.data);
    if (status < 200 || status >= 300) return;
    // The response also carries an optional storage fault; read only the
    // validated voice for the audit row, never client-supplied copy.
    const voice = typeof payload === "object" && payload !== null
      ? (payload as { voice?: unknown }).voice : undefined;
    if (!voiceIdSchema.safeParse(voice).success) return;
    void recordActivity({
      kind: "voice", severity: "info", sourceIcon: "volume-2",
      what: "Speaking voice changed", sub: null,
      refs: { surface: "voice-speaking-voice", voice, upstreamStatus: status },
      actor: actorFromRequest(req),
    });
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

  // ── WARP-3710: mic recovery - restart (re-pick + reopen) and test ──

  router.post("/voice/mic/restart", guard, async (req: Request, res) => {
    // Strict boolean, no coercion - voice-io's model is StrictBool too, so a
    // truthy string can never reboot hardware by accident.
    const dspReboot: unknown = req.body?.dspReboot;
    if (dspReboot !== undefined && typeof dspReboot !== "boolean") {
      res.status(400).json({ error: "invalid_dsp_reboot" });
      return;
    }
    const body: { dspReboot?: boolean } = {};
    if (typeof dspReboot === "boolean") body.dspReboot = dspReboot;
    const { status, payload } = await proxyWithPayload(
      res,
      "POST",
      "/voice/mic/restart",
      body,
      MIC_RESTART_TIMEOUT_MS,
    );
    // A write that drives hardware always leaves an activity row, success
    // or failure (same posture as restart-processor). Fire-and-forget
    // after the response is committed.
    const ok = status >= 200 && status < 300;
    const device =
      ok && typeof payload === "object" && payload !== null
        ? (payload as { device?: unknown }).device
        : undefined;
    void recordActivity({
      kind: "voice",
      severity: ok ? "info" : "err",
      sourceIcon: "mic",
      what: ok ? "Microphone restarted" : "Microphone restart failed",
      sub:
        typeof device === "string"
          ? `Now using ${device}${body.dspReboot ? " · DSP rebooted" : ""}`
          : body.dspReboot
            ? "Device re-pick with DSP reboot"
            : "Device re-pick",
      refs: { surface: "voice-mic-restart", upstreamStatus: status },
      actor: actorFromRequest(req),
    });
  });

  router.post("/voice/mic/test", guard, async (req, res) => {
    const playback: unknown = req.body?.playback;
    if (playback !== undefined && typeof playback !== "boolean") {
      res.status(400).json({ error: "invalid_playback" });
      return;
    }
    const seconds: unknown = req.body?.duration_s;
    if (seconds !== undefined) {
      if (
        typeof seconds !== "number" ||
        !Number.isFinite(seconds) ||
        seconds < MIC_TEST_SECONDS_MIN ||
        seconds > MIC_TEST_SECONDS_MAX
      ) {
        res.status(400).json({ error: "invalid_duration" });
        return;
      }
    }
    const body: { playback?: boolean; duration_s?: number } = {};
    if (typeof playback === "boolean") body.playback = playback;
    if (typeof seconds === "number") body.duration_s = seconds;
    await proxy(res, "POST", "/voice/mic/test", body, MIC_TEST_TIMEOUT_MS);
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

  // ── Speaker output volume ──
  //
  // voice-io owns the level: one persisted {level, muted} on the box,
  // shared with the spoken "turn it up / mute" commands it handles
  // locally. This is the dashboard's way in — owner/admin only, like
  // /say, because it drives the room speaker and a mute silences the
  // household's assistant.

  router.get("/voice/volume", guard, async (_req, res) => {
    await proxy(res, "GET", "/voice/volume");
  });

  router.post("/voice/volume", guard, async (req: Request, res) => {
    const parsed = volumeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_volume" });
      return;
    }
    // Only the validated field is forwarded (the schemas are .strict()).
    const { status, payload } = await proxyWithPayload(
      res,
      "POST",
      "/voice/volume",
      parsed.data,
    );
    // Audited like the sibling voice settings writes (/enabled,
    // /calibration). Only on success — a rejected or unreachable write
    // changed nothing on the box. The row quotes the level the box
    // actually landed on (clamped), not the request. Fire-and-forget
    // after the response is committed; recordActivity swallows failures.
    if (status < 200 || status >= 300) return;
    const landed = volumeChangeSchema.safeParse(payload);
    if (!landed.success) {
      // voice-io and this route ship together; a 2xx without the state
      // fields is a contract break worth seeing, not a quiet skip.
      logger.warn(
        { upstreamStatus: status },
        "voice-io volume change answered without its state — no activity row",
      );
      return;
    }
    const { level, muted, previous_level, previous_muted } = landed.data;
    const requested = parsed.data;
    let what: string;
    let sub: string;
    if ("muted" in requested) {
      what = muted ? "Speaker muted" : "Speaker unmuted";
      sub = muted
        ? "Droplet's spoken replies are silent until the speaker is unmuted"
        : `Volume ${level}`;
    } else {
      what = `Volume set to ${level}`;
      sub = `Was ${previous_level}${previous_muted ? ", muted" : ""}`;
    }
    void recordActivity({
      kind: "voice",
      severity: "info",
      sourceIcon: muted ? "volume-x" : "volume-2",
      what,
      sub,
      refs: { surface: "voice-volume", upstreamStatus: status },
      actor: actorFromRequest(req),
    });
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
