/**
 * WARP-1056 — `/api/voice/profiles` + `/api/voice/enroll/*`: the
 * dashboard-facing wall in front of voice-io's per-person voiceprint
 * endpoints (Flow B enrollment, profile rows, remove).
 *
 * Lives in its own router (not routes/voice.ts) so the WARP-1058
 * activity-feed work on that file (#1081) and this ticket compose with
 * a trivial rebase; the proxy contract below is the same one voice.ts
 * established (WARP-1036): voice-io has NO auth of its own, this route
 * is the owner/admin wall, connection failures answer 503
 * `voice_unavailable`, upstream HTTP errors relay verbatim.
 *
 * Person model (design brief §3.3): enrollment ATTACHES a voiceprint to
 * an EXISTING person — it never creates one. That rule is enforced
 * here: /voice/enroll/start resolves the target user row in Prisma and
 * 404s before voice-io is ever asked to record anyone. The voiceprint
 * itself (a 512-float embedding, biometric-adjacent) lives ONLY on the
 * box in voice-io's named volume — never in Postgres (so no dependency
 * on the WARP-242 brain-encryption work), and never in any response
 * relayed here (voice-io strips it; we only add display names).
 *
 * HARD RULE (brief §5, FEATURES.md §6): voice identity PERSONALIZES,
 * it never AUTHENTICATES. Nothing in this router mints a session,
 * token, or role from a voice match, and no caller may treat a match
 * as an approval — confirm-tier actions still route to the
 * dashboard/phone for the explicit confirm. voice-io's /speaker/match
 * is deliberately NOT proxied to the dashboard: the browser has a
 * logged-in user already; matching is an on-box concern.
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { createLogger } from "../lib/logger.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";

const logger = createLogger("voice-profiles");

const DEFAULT_VOICE_IO_URL = "http://voice-io:8086";

/** Profile listing / session discard are in-memory + tiny-file reads. */
const READ_TIMEOUT_MS = 10_000;

/**
 * Enrollment capture/verify block for the on-box recording window
 * (5–6 s) plus embedding; generous so a slow ALSA open never reads as
 * "voice unavailable" mid-enrollment (same posture as voice.ts's
 * MEASURE_TIMEOUT_MS).
 */
const CAPTURE_TIMEOUT_MS = 45_000;

/** Mirrors voice-io's USER_ID_RE (path-traversal gate on the box side —
 *  rejecting here too keeps garbage out of the proxy hop entirely). */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Mirrors voice-io's enrollment session ids (secrets.token_hex(16)). */
const SESSION_ID_RE = /^[a-f0-9]{32}$/;

function voiceIoBaseUrl(): string {
  const url = internalBaseUrl(process.env.VOICE_IO_URL ?? DEFAULT_VOICE_IO_URL);
  return url.replace(/\/+$/, "");
}

/** Same relay contract as voice.ts's proxy(): upstream status + JSON
 *  verbatim, 503 `voice_unavailable` on unreachable. Returns the JSON
 *  payload (already sent) so callers can enrich follow-up work —
 *  `undefined` means the response was NOT 2xx. */
async function proxy(
  res: Response,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs: number = READ_TIMEOUT_MS,
  transform?: (payload: unknown) => Promise<unknown> | unknown,
): Promise<unknown | undefined> {
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
    const text = await upstream.text();
    let payload: unknown = {};
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }
    const ok = upstream.status >= 200 && upstream.status < 300;
    if (ok && transform) {
      // Enrichment must never turn a completed upstream write into a
      // 500 — fall back to the raw payload if the join fails.
      try {
        payload = await transform(payload);
      } catch (err) {
        logger.warn(
          { err: (err as Error)?.message, target },
          "voice profile enrichment failed — relaying raw payload",
        );
      }
    }
    res.status(upstream.status).json(payload);
    return ok ? payload : undefined;
  } catch (err) {
    logger.warn(
      { err: (err as Error)?.message, target, method },
      "voice-io proxy fetch failed — treating as unavailable",
    );
    res.status(503).json({ error: "voice_unavailable" });
    return undefined;
  }
}

interface UpstreamProfile {
  user_id: string;
  confused_with?: string | null;
  [key: string]: unknown;
}

export function createVoiceProfilesRouter(prisma: PrismaClient): Router {
  const router = Router();

  // Owner/admin only across the whole surface, exactly like voice.ts —
  // the guard's allowlist never includes `service`.
  const guard = requireRole("owner", "admin");

  /** Resolve display names for the profile rows (and the §7.6
   *  "Sometimes confused with [Name]" note). Fresh join per request —
   *  voice-io stores only ids (data minimization), names may drift. */
  async function withNames(payload: unknown): Promise<unknown> {
    const profiles = (payload as { profiles?: UpstreamProfile[] })?.profiles;
    if (!Array.isArray(profiles) || profiles.length === 0) return payload;
    const ids = [
      ...new Set(
        profiles.flatMap((p) =>
          [p.user_id, p.confused_with].filter(
            (v): v is string => typeof v === "string" && v.length > 0,
          ),
        ),
      ),
    ];
    const users = await prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true, username: true },
    });
    const nameById = new Map(
      users.map((u) => [u.id, u.displayName || u.username]),
    );
    return {
      ...(payload as object),
      profiles: profiles.map((p) => ({
        ...p,
        display_name: nameById.get(p.user_id) ?? null,
        confused_with_name: p.confused_with
          ? (nameById.get(p.confused_with) ?? null)
          : null,
      })),
    };
  }

  // ── GET /api/voice/profiles — §3.3 "Who Droplet recognizes" ──
  router.get("/voice/profiles", guard, async (_req, res) => {
    await proxy(
      res,
      "GET",
      "/speaker/profiles",
      undefined,
      READ_TIMEOUT_MS,
      withNames,
    );
  });

  // ── POST /api/voice/enroll/start — open a Flow B session ──
  router.post("/voice/enroll/start", guard, async (req, res) => {
    const userId: unknown = req.body?.userId;
    if (typeof userId !== "string" || !USER_ID_RE.test(userId)) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    // §3.3 enforcement: enrollment attaches to an EXISTING person and
    // never creates one — an unknown id dies here, before the box is
    // ever asked to record anybody.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!user) {
      res.status(404).json({ error: "person_not_found" });
      return;
    }
    await proxy(res, "POST", "/speaker/enroll/start", { user_id: userId });
  });

  /** Validate + forward one session-scoped enrollment call. */
  function sessionBody(req: Request, res: Response): string | null {
    const sessionId: unknown = req.body?.sessionId;
    if (typeof sessionId !== "string" || !SESSION_ID_RE.test(sessionId)) {
      res.status(400).json({ error: "invalid_session_id" });
      return null;
    }
    return sessionId;
  }

  // ── POST /api/voice/enroll/capture — one scripted line (§5 step 2) ──
  router.post("/voice/enroll/capture", guard, async (req, res) => {
    const sessionId = sessionBody(req, res);
    if (!sessionId) return;
    const replaceIndex: unknown = req.body?.replaceIndex;
    if (
      replaceIndex !== undefined &&
      (typeof replaceIndex !== "number" ||
        !Number.isInteger(replaceIndex) ||
        replaceIndex < 0)
    ) {
      res.status(400).json({ error: "invalid_replace_index" });
      return;
    }
    const body: { session_id: string; replace_index?: number } = {
      session_id: sessionId,
    };
    if (typeof replaceIndex === "number") body.replace_index = replaceIndex;
    await proxy(
      res,
      "POST",
      "/speaker/enroll/capture",
      body,
      CAPTURE_TIMEOUT_MS,
    );
  });

  // ── POST /api/voice/enroll/verify — the no-script proof (§5 step 3) ──
  router.post("/voice/enroll/verify", guard, async (req, res) => {
    const sessionId = sessionBody(req, res);
    if (!sessionId) return;
    await proxy(
      res,
      "POST",
      "/speaker/enroll/verify",
      { session_id: sessionId },
      CAPTURE_TIMEOUT_MS,
    );
  });

  // ── POST /api/voice/enroll/commit — the ONE write of Flow B ──
  router.post("/voice/enroll/commit", guard, async (req: Request, res) => {
    const sessionId = sessionBody(req, res);
    if (!sessionId) return;
    const payload = await proxy(res, "POST", "/speaker/enroll/commit", {
      session_id: sessionId,
    });
    if (payload === undefined) return; // nothing was written
    // Audited like the sibling voice write (WARP-1057 restart): a write
    // that stores biometric-adjacent data always leaves an activity
    // row. Fire-and-forget after the response — an audit hiccup never
    // turns a committed voiceprint into a 500.
    const profile = (payload as { profile?: { user_id?: string } })?.profile;
    const userId = profile?.user_id;
    const user = userId
      ? await prisma.user
          .findUnique({
            where: { id: userId },
            select: { displayName: true, username: true },
          })
          .catch(() => null)
      : null;
    void recordActivity({
      kind: "system",
      severity: "ok",
      sourceIcon: "mic",
      what: "Voice profile saved",
      sub: user
        ? `Voiceprint enrolled for ${user.displayName || user.username} · stored on this box only`
        : "Voiceprint enrolled · stored on this box only",
      refs: { surface: "voice-enrollment", userId: userId ?? null },
      actor: actorFromRequest(req),
    });
  });

  // ── DELETE /api/voice/enroll/:sessionId — cancel, discards now ──
  router.delete("/voice/enroll/:sessionId", guard, async (req, res) => {
    const sessionId = req.params.sessionId ?? "";
    if (!SESSION_ID_RE.test(sessionId)) {
      res.status(400).json({ error: "invalid_session_id" });
      return;
    }
    // "Cancel deletes these recordings now" — no audit row for a
    // discard; nothing was ever persisted.
    await proxy(res, "DELETE", `/speaker/enroll/${sessionId}`);
  });

  // ── DELETE /api/voice/profiles/:userId — remove (Write, destructive) ──
  router.delete("/voice/profiles/:userId", guard, async (req: Request, res) => {
    const userId = req.params.userId ?? "";
    if (!USER_ID_RE.test(userId)) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const payload = await proxy(
      res,
      "DELETE",
      `/speaker/profiles/${userId}`,
    );
    if (payload === undefined) return;
    if ((payload as { deleted?: boolean })?.deleted !== true) return; // no-op repeat
    const user = await prisma.user
      .findUnique({
        where: { id: userId },
        select: { displayName: true, username: true },
      })
      .catch(() => null);
    void recordActivity({
      kind: "system",
      severity: "info",
      sourceIcon: "mic",
      what: "Voice profile removed",
      sub: user
        ? `Voiceprint for ${user.displayName || user.username} deleted from this box`
        : "Voiceprint deleted from this box",
      refs: { surface: "voice-enrollment", userId },
      actor: actorFromRequest(req),
    });
  });

  return router;
}
