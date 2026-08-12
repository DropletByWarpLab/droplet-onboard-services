/**
 * Camera API routes — listing, snapshots, events, discovery, and SSE notifications.
 *
 * All camera streams and snapshots are proxied through these authenticated
 * endpoints so camera IPs are never exposed to external clients. Works
 * identically on-LAN and off-LAN via the Nginx HTTPS gateway.
 *
 * ROUTE ORDERING: All fixed-path routes (/cameras/events/*, /cameras/discovered,
 * /cameras/stats, /cameras/drivers) MUST be registered before parameterized
 * routes (/cameras/:name) to avoid shadowing.
 */

import { Router } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import { requireFeatureAccess } from "../middleware/feature-gate.js";
import {
  getCameras,
  getEventsFiltered,
  getRecentEvents,
  getRecordings,
  getRecordingsSummary,
  getReviewsFiltered,
  getStats,
  getTimelineEntries,
  searchEventsSemanticTyped,
  setEventRetention,
  setReviewViewed,
  subscribeCameraEvents,
  isInitialized,
  invalidateCamerasCache,
} from "../services/camera.service.js";
import {
  fetchSnapshot,
  fetchEventThumbnail,
  fetchKnownFaces,
  fetchKnownPlates,
  fetchFaceImage,
  deleteKnownFace,
  deleteFaceImage,
  deleteKnownPlate,
  nameKnownPlate,
  regenerateEventDescription,
  tagEventAsFace,
  openBirdseyeStream,
  openMjpegStream,
  enableDetection,
  disableDetection,
  deleteCamera,
  deleteEvent,
  addCamera,
  syncCamerasFromDb,
  fetchEvents,
  buildRecordingClipUrl,
  buildVodMasterUrl,
  buildVodSegmentUrl,
  fetchHlsPlaylist,
  fetchPtzCapabilities,
  ptzGoToPreset,
  ptzMove,
  restartFrigate,
  type PtzAction,
} from "../services/frigate.client.js";
import { getCameraSystemStatus, type CameraSystemStatus } from "../services/camera-system.service.js";
import {
  discoveryAuthHeaders,
  getCameraCandidates,
  macFromCandidateId,
  mutateLiveCandidate,
} from "../services/camera-candidates.service.js";
import { getCameraStorage } from "../services/camera-storage.service.js";
import {
  reconcileCameraBudgets,
  checkOverAllocation,
  parseCeiling,
  windowsFromSettings,
  type OverAllocation,
  type RetentionWindows,
} from "../services/camera-budget.service.js";
import { isUpstreamUnavailable } from "../lib/upstream-unavailable.js";
import { pipeUpstreamBody } from "../lib/pipe-upstream.js";
import { config } from "../config.js";
import { internalBaseUrl, internalFetch } from "../lib/internal-tls.js";
import { evaluateNetworkCommand, confirmNetworkCommand } from "../services/network-safety.service.js";
import type { ConfirmNetworkCommandError } from "../services/network-safety.service.js";
import { exportClip, signShareUrl, verifyShareUrl } from "../services/clips.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { ncDownloadFile } from "../services/nextcloud.client.js";
import * as groupsSvc from "../services/camera-groups.service.js";
import {
  isValidGroupName,
  isValidGroupIcon,
} from "../services/camera-groups.service.js";
import * as pinsSvc from "../services/camera-pins.service.js";
import {
  getCameraSettings,
  updateCameraSettings,
  type CameraSettingsPatch,
} from "../services/camera-settings.service.js";
import { z } from "zod";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("cameras-routes");

/**
 * Empty CameraSystemStatus served when Frigate is unreachable — the dashboard's
 * System page renders "0 of 0 cameras live" rather than dead-ending on a 500
 * during a Frigate outage. Mirrors models-summary.service.ts's empty-payload
 * degrade. Self-heals on the next poll once Frigate is back (we never cache it).
 *
 * Frozen at declaration so a consumer can never `.push()` into one of the shared
 * array fields and corrupt the constant for every later Frigate-down response
 * (mirrors matter.ts's frozen DISCONNECTED_DEVICES). We keep the
 * `: CameraSystemStatus` annotation for shape-checking and freeze at runtime —
 * a bare `as const` would narrow the arrays to `readonly []`, which isn't
 * assignable to the interface's mutable `Array<…>`. The freeze covers the object
 * itself plus each empty array (a shallow object freeze alone would still leave
 * `.cameraFps.push()` mutating the shared array).
 */
const EMPTY_SYSTEM_STATUS: CameraSystemStatus = {
  version: "unknown",
  uptimeSec: 0,
  cameraCount: 0,
  camerasLive: 0,
  cameraFps: [],
  detectors: [],
  gpus: [],
  storage: [],
  cpuPct: 0,
};
Object.freeze(EMPTY_SYSTEM_STATUS.cameraFps);
Object.freeze(EMPTY_SYSTEM_STATUS.detectors);
Object.freeze(EMPTY_SYSTEM_STATUS.gpus);
Object.freeze(EMPTY_SYSTEM_STATUS.storage);
Object.freeze(EMPTY_SYSTEM_STATUS);

/** Service-to-service auth headers for routing/discovery services. */
function serviceAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (config.SERVICE_SECRET) {
    headers["Authorization"] = `Bearer ${config.SERVICE_SECRET}`;
  }
  return headers;
}

// --- Input validation helpers ---

/** Camera names: alphanumeric, underscores, hyphens only (Frigate convention) */
const CAMERA_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Frigate event IDs: alphanumeric with hyphens/dots (UUID-like or numeric) */
const EVENT_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

/** WARP-1893 — cap on the household-facing camera label. Unlike
 *  CAMERA_NAME_RE this is free text (spaces, accents, emoji all fine); the
 *  only limits are length and control characters. */
const MAX_DISPLAY_NAME_LEN = 64;

function isValidCameraName(name: string): boolean {
  return CAMERA_NAME_RE.test(name);
}

function isValidEventId(id: string): boolean {
  return EVENT_ID_RE.test(id);
}

export function createCamerasRouter(prisma: PrismaClient): Router {
  const router = Router();

  // #11: after any change to the set of cameras the DB knows about, reconcile
  // Frigate's config so entries orphaned by a prior version / Postgres wipe
  // (e.g. camera_192_168_20_176) are pruned. Best-effort — a Frigate failure
  // must not fail the DB op; the prune is idempotent and the next mutation
  // retries it.
  async function reconcileFrigateCameras(): Promise<void> {
    // WARP-1286 follow-up: every caller reaches here right after a DB mutation
    // to the camera set (add/accept/reject/delete). Bust the 5s `cameras:list`
    // cache centrally so a stale snapshot can't survive the mutation — a
    // deleted/rejected camera resurrecting, or a freshly added one staying
    // invisible, for up to CACHE_TTL. Runs before (and independently of) the
    // best-effort Frigate prune below: a Frigate failure must not skip the
    // invalidation, and `invalidateCamerasCache()` is itself non-throwing.
    await invalidateCamerasCache();
    try {
      const all = await prisma.camera.findMany({ select: { name: true } });
      const removed = await syncCamerasFromDb(all.map((c) => c.name));
      if (removed.length > 0) {
        logger.info({ removed }, "Reconciled Frigate cameras after DB change");
      }
    } catch (err) {
      logger.warn({ err }, "Frigate camera reconciliation failed (non-fatal)");
    }
  }

  // ==========================================================================
  // FIXED-PATH ROUTES (must be registered before :name parameterized routes)
  // ==========================================================================

  // --- Camera groups ---
  //
  // Operator-defined logical groupings rendered as a navigation rail above
  // the cameras grid. Membership is many-to-many via CameraGroupMember;
  // see services/camera-groups.service.ts for the data model + DTO shape.
  //
  // Routes are registered before /cameras/:name for the same reason as the
  // clips routes below: parameterized :name would otherwise shadow
  // /cameras/groups and resolve as a camera literally named "groups".

  router.get("/cameras/groups", async (_req, res, next) => {
    try {
      const groups = await groupsSvc.listGroups(prisma);
      res.json({ groups });
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin + family.
  router.post("/cameras/groups", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const { name, icon, cameraNames } = req.body ?? {};
      if (!isValidGroupName(name)) {
        return res.status(400).json({ error: "Invalid group name" });
      }
      if (!isValidGroupIcon(icon)) {
        return res.status(400).json({ error: "Invalid group icon" });
      }
      if (
        cameraNames !== undefined &&
        (!Array.isArray(cameraNames) ||
          cameraNames.some((s) => typeof s !== "string" || !isValidCameraName(s)))
      ) {
        return res.status(400).json({ error: "cameraNames must be a list of camera names" });
      }
      const group = await groupsSvc.createGroup(prisma, {
        name,
        icon: icon ?? null,
        cameraNames: cameraNames as string[] | undefined,
      });
      res.status(201).json({ group });
    } catch (err) {
      // Unique constraint on name → 409 with a friendly message
      if ((err as { code?: string })?.code === "P2002") {
        return res.status(409).json({ error: "A group with that name already exists" });
      }
      next(err);
    }
  });

  router.patch("/cameras/groups/:id", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const { name, icon, sortOrder } = req.body ?? {};
      if (name !== undefined && !isValidGroupName(name)) {
        return res.status(400).json({ error: "Invalid group name" });
      }
      if (icon !== undefined && !isValidGroupIcon(icon)) {
        return res.status(400).json({ error: "Invalid group icon" });
      }
      if (
        sortOrder !== undefined &&
        (typeof sortOrder !== "number" || !Number.isFinite(sortOrder))
      ) {
        return res.status(400).json({ error: "sortOrder must be a number" });
      }
      const group = await groupsSvc.updateGroup(prisma, req.params.id, {
        name,
        icon,
        sortOrder,
      });
      if (!group) return res.status(404).json({ error: "Group not found" });
      res.json({ group });
    } catch (err) {
      if ((err as { code?: string })?.code === "P2002") {
        return res.status(409).json({ error: "A group with that name already exists" });
      }
      next(err);
    }
  });

  router.delete("/cameras/groups/:id", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const ok = await groupsSvc.deleteGroup(prisma, req.params.id);
      if (!ok) return res.status(404).json({ error: "Group not found" });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/groups/:id/members", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const { cameraNames } = req.body ?? {};
      if (
        !Array.isArray(cameraNames) ||
        cameraNames.some((s) => typeof s !== "string" || !isValidCameraName(s))
      ) {
        return res
          .status(400)
          .json({ error: "cameraNames must be a list of camera names" });
      }
      const group = await groupsSvc.addMembers(
        prisma,
        req.params.id,
        cameraNames,
      );
      if (!group) return res.status(404).json({ error: "Group not found" });
      res.json({ group });
    } catch (err) {
      next(err);
    }
  });

  router.delete(
    "/cameras/groups/:id/members/:cameraName",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        if (!isValidCameraName(req.params.cameraName)) {
          return res.status(400).json({ error: "Invalid camera name" });
        }
        const group = await groupsSvc.removeMember(
          prisma,
          req.params.id,
          req.params.cameraName,
        );
        if (!group) return res.status(404).json({ error: "Group not found" });
        res.json({ group });
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Camera pins ---
  //
  // Per-user "pinned" cameras — an operator preference that lifts the
  // cameras they actually watch above the alphabetical grid. Pins are
  // keyed on userId + cameraName (Frigate camera name) rather than a
  // Camera FK because they're pure prefs: if the underlying camera
  // disappears we filter the dangling pin on read instead of cascading
  // deletes. See services/camera-pins.service.ts for rationale.
  //
  // Route ordering: /cameras/pins/reorder is registered before
  // /cameras/pins/:cameraName so the literal path matches first; both
  // also live above /cameras/:name for the standard fixed-vs-param
  // shadowing reason called out in the file header.

  router.get("/cameras/pins", async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const pins = await pinsSvc.listPins(prisma, req.user.id);
      res.json({ pins });
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/pins", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const { cameraName } = req.body ?? {};
      if (typeof cameraName !== "string" || !isValidCameraName(cameraName)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const pin = await pinsSvc.addPin(prisma, req.user.id, cameraName);
      res.status(201).json({ pin });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/cameras/pins/reorder", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const { cameraNames } = req.body ?? {};
      if (
        !Array.isArray(cameraNames) ||
        cameraNames.some(
          (s) => typeof s !== "string" || !isValidCameraName(s),
        )
      ) {
        return res
          .status(400)
          .json({ error: "cameraNames must be a list of camera names" });
      }
      const pins = await pinsSvc.reorderPins(
        prisma,
        req.user.id,
        cameraNames,
      );
      res.json({ pins });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/cameras/pins/:cameraName", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!req.user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      if (!isValidCameraName(req.params.cameraName)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      await pinsSvc.removePin(prisma, req.user.id, req.params.cameraName);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // --- Clips (PR #3) ---
  //
  // These MUST come before /cameras/:name. Otherwise Express routes
  // GET /cameras/clips to the :name handler with name="clips" and the LLM
  // tool list_clips silently returns a single "camera" record.

  router.get("/cameras/clips", async (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const camera = req.query.camera as string | undefined;
      if (camera && !isValidCameraName(camera)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const events = (await fetchEvents(limit, camera)) as Array<Record<string, unknown>>;
      const clips = events
        .filter((e) => e.has_clip === true)
        .map((e) => ({
          id: e.id,
          camera: e.camera,
          label: e.label,
          score: e.score,
          start_time: e.start_time,
          end_time: e.end_time,
          thumbnail_url: `/api/cameras/events/${encodeURIComponent(String(e.id))}/thumbnail`,
          clip_url: `/api/cameras/clips/event/${encodeURIComponent(String(e.id))}`,
        }));
      res.json({ clips });
    } catch (err) {
      next(err);
    }
  });

  router.get("/cameras/clips/event/:eventId", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.eventId)) {
        return res.status(400).json({ error: "Invalid event id" });
      }
      const url = `${config.FRIGATE_URL}/api/events/${encodeURIComponent(req.params.eventId)}/clip.mp4`;
      const upstream = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `frigate ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      if (upstream.body) {
        pipeUpstreamBody(upstream.body, res);
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  // Sharing a clip mints a public "anyone with the link" signed URL to private
  // footage that is unauthenticated for its whole TTL. This is a Tier-2 action,
  // so the route runs through the network-safety evaluator and answers a 202
  // `confirmation_required` (with a confirmation token) on the first call —
  // exactly like the firewall writes. The AI's share_clip tool (requiresWrite +
  // requiresConfirmation) reaches this via the MCP service principal, so the
  // agent can NEVER sign a URL in a single unattended tool call: it must surface
  // an approval chip and only the human can confirm. (The MCP principal is also
  // barred from the confirm endpoint, so it can't self-approve — see
  // network-mcp-service-rbac.test.ts.)
  router.post("/cameras/clips/share", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      const schema = z.object({
        nc_path: z.string().min(1).max(2048),
        ttl_minutes: z.number().int().min(1).max(1440).optional(),
        // Present only on the post-confirmation re-issue: the token the human
        // received in the first call's 202. Absent → first (unconfirmed) call.
        confirmation_token: z.string().min(1).max(256).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      }

      const isMcp = req.user?.id === "_service:mcp";

      // Resolve the Nextcloud user the URL is signed for. Human sessions use
      // their own username; the MCP service principal (req.user.username ===
      // "_service:mcp") forwards the real human's NC user in X-Nextcloud-User,
      // honored ONLY for that trusted principal (mirrors the /api/files routes).
      let userId: string | undefined;
      if (isMcp) {
        const hdr = req.header("X-Nextcloud-User");
        userId = typeof hdr === "string" && hdr.length > 0 ? hdr : undefined;
      } else {
        userId = req.user?.username;
      }
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      // Defense-in-depth path check — mirrors PR #1's validateNcPath logic so
      // a caller can't sign a token whose ncPath traverses out of their own
      // Nextcloud namespace. Whether Sabre/DAV would also reject is immaterial
      // — we don't want to rely on it. Run BEFORE the confirmation mint so a
      // malformed path 400s rather than parking a pending token.
      const pathValid = isSafeNcPath(parsed.data.nc_path);
      if (!pathValid.ok) {
        return res.status(400).json({ error: pathValid.error });
      }

      // Post-confirmation re-issue: the caller echoes the token from the 202.
      // The MCP principal is BARRED from confirming (mirrors the human-only
      // /network/command/confirm guard) — the whole point is that the agent
      // can mint a 202 but a human, not the agent, must approve it. Without
      // this bar the agent could re-call with the token it just received and
      // self-approve, defeating the gate.
      if (parsed.data.confirmation_token) {
        if (isMcp) {
          return res.status(403).json({
            error: "share_clip confirmation must come from a signed-in user, not the assistant",
          });
        }
        const confirmRes = await confirmNetworkCommand(
          prisma,
          parsed.data.confirmation_token,
          req.user?.id,
          { operation: "share_clip", entityId: "camera.clip.share" },
        );
        if (!confirmRes.confirmed) {
          const code: ConfirmNetworkCommandError = confirmRes.code;
          return res.status(400).json({ error: confirmRes.reason, code });
        }
        const ttlSec = (parsed.data.ttl_minutes ?? 60) * 60;
        const token = signShareUrl(userId, pathValid.path, ttlSec);
        const filename = pathValid.path.split("/").pop() ?? "clip.mp4";
        return res.json({
          url: `/api/cameras/clips/share/${encodeURIComponent(filename)}?t=${encodeURIComponent(token)}`,
          expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
        });
      }

      // First call — Tier-2 confirmation gate. evaluateNetworkCommand classifies
      // share_clip as Tier 2 → requiresConfirmation, and this route answers 202
      // with a token. The URL is signed only AFTER a human confirms and the
      // caller re-issues this request with `confirmation_token`.
      const result = await evaluateNetworkCommand(
        prisma,
        "camera.clip.share",
        "share_clip",
        { nc_path: pathValid.path, ttl_minutes: parsed.data.ttl_minutes ?? 60 },
        req.user?.id,
      );
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          operation: "share_clip",
          tier: result.tier,
          reason: result.reason,
          confirmationToken: result.confirmationToken,
          expiresIn: 60,
        });
      }

      // Tier-1 fallthrough (not expected for share_clip, but keep the
      // contract honest if the classification ever changes).
      const ttlSec = (parsed.data.ttl_minutes ?? 60) * 60;
      const token = signShareUrl(userId, pathValid.path, ttlSec);
      const filename = pathValid.path.split("/").pop() ?? "clip.mp4";
      res.json({
        url: `/api/cameras/clips/share/${encodeURIComponent(filename)}?t=${encodeURIComponent(token)}`,
        expires_at: new Date(Date.now() + ttlSec * 1000).toISOString(),
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Face recognition (Phase 7.5) ---
  //
  // GET /cameras/faces — list known people + thumbnail URLs
  // GET /cameras/faces/:name/images/:image — proxy a training image
  // DELETE /cameras/faces/:name — remove a person + all their images
  // DELETE /cameras/faces/:name/images/:image — remove one training image
  // POST /cameras/faces/:name/from-event/:eventId — tag an event's
  //   detected face as this person (uses Frigate's sub_label endpoint
  //   which adds the snapshot to the recogniser)
  //
  // Names + image filenames are tightened past Frigate's anything-goes
  // because we splice them straight into upstream URLs.

  const FACE_NAME_RE = /^[a-zA-Z0-9_ -]{1,40}$/;
  const FACE_IMAGE_RE = /^[a-zA-Z0-9._-]{1,100}\.(jpg|jpeg|png|webp)$/i;

  router.get("/cameras/faces", async (_req, res, next) => {
    try {
      const faces = await fetchKnownFaces();
      // Rewrite image URLs to point at our proxy.
      const out = faces.map((f) => ({
        name: f.name,
        images: f.images.map((img) => ({
          name: img.name,
          imageUrl: `/api/cameras/faces/${encodeURIComponent(f.name)}/images/${encodeURIComponent(img.name)}`,
        })),
      }));
      res.json({ faces: out });
    } catch (err) {
      next(err);
    }
  });

  router.get("/cameras/faces/:name/images/:image", async (req, res, next) => {
    try {
      if (!FACE_NAME_RE.test(req.params.name)) {
        return res.status(400).json({ error: "Invalid face name" });
      }
      if (!FACE_IMAGE_RE.test(req.params.image)) {
        return res.status(400).json({ error: "Invalid image name" });
      }
      const upstream = await fetchFaceImage(req.params.name, req.params.image);
      res.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") || "image/jpeg",
      );
      res.setHeader("Cache-Control", "private, max-age=3600");
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  router.delete("/cameras/faces/:name", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!FACE_NAME_RE.test(req.params.name)) {
        return res.status(400).json({ error: "Invalid face name" });
      }
      await deleteKnownFace(req.params.name);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.delete(
    "/cameras/faces/:name/images/:image",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        if (!FACE_NAME_RE.test(req.params.name)) {
          return res.status(400).json({ error: "Invalid face name" });
        }
        if (!FACE_IMAGE_RE.test(req.params.image)) {
          return res.status(400).json({ error: "Invalid image name" });
        }
        await deleteFaceImage(req.params.name, req.params.image);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/cameras/faces/:name/from-event/:eventId",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        if (!FACE_NAME_RE.test(req.params.name)) {
          return res.status(400).json({ error: "Invalid face name" });
        }
        if (!isValidEventId(req.params.eventId)) {
          return res.status(400).json({ error: "Invalid event ID" });
        }
        await tagEventAsFace(req.params.eventId, req.params.name);
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  // --- License plates (Phase 7.6) ---

  const PLATE_RE = /^[A-Z0-9 -]{1,16}$/i;
  const PLATE_NAME_RE = /^[a-zA-Z0-9_ '.-]{1,60}$/;

  router.get("/cameras/plates", async (_req, res, next) => {
    try {
      const plates = await fetchKnownPlates();
      res.json({ plates });
    } catch (err) {
      next(err);
    }
  });

  router.put("/cameras/plates/:plate", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!PLATE_RE.test(req.params.plate)) {
        return res.status(400).json({ error: "Invalid plate format" });
      }
      const name = String((req.body ?? {}).name ?? "").trim();
      if (!PLATE_NAME_RE.test(name)) {
        return res.status(400).json({ error: "Invalid plate name" });
      }
      await nameKnownPlate(req.params.plate, name);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.delete("/cameras/plates/:plate", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!PLATE_RE.test(req.params.plate)) {
        return res.status(400).json({ error: "Invalid plate format" });
      }
      await deleteKnownPlate(req.params.plate);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // --- Birdseye live (Phase 6.2) ---
  //
  // Frigate's auto-composited multi-camera MJPEG stream. Cameras with
  // current motion get foregrounded automatically; the operator gets
  // a single "what's happening anywhere?" feed without paying for
  // every camera's bandwidth.
  //
  // Fixed path because /cameras/birdseye/live has 3 segments — adding
  // it here keeps it next to the system route which has the same
  // ordering rationale.

  router.get("/cameras/birdseye/live", async (req, res, next) => {
    try {
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      const upstream = await openBirdseyeStream(ctrl.signal);
      const contentType =
        upstream.headers.get("content-type") ||
        "multipart/x-mixed-replace;boundary=frame";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "close");
      if (!upstream.body) {
        return res.status(502).json({ error: "Frigate returned no body" });
      }
      pipeUpstreamBody(upstream.body, res);
    } catch (err) {
      // Birdseye is optional — Frigate returns 404 if no camera is
      // configured for birdseye output. Surface that as a clean 404
      // so the dashboard can show "Birdseye not configured."
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404")) {
        return res
          .status(404)
          .json({ error: "Birdseye not enabled in Frigate config" });
      }
      next(err);
    }
  });

  // --- System status (Phase 5) ---
  //
  // Typed wrapper around Frigate's /api/stats + /api/version. The raw
  // /cameras/stats route below stays — it's the LLM tool's escape
  // hatch for the full payload. This one is what the dashboard's
  // /cameras/system page renders.
  //
  // Registered in the fixed-path section because `/cameras/system`
  // (2 path segments after /api) would otherwise be matched by
  // `/cameras/:name` with name="system".

  router.get("/cameras/system", async (_req, res, next) => {
    try {
      const status = await getCameraSystemStatus();
      res.json({ status });
    } catch (err) {
      if (isUpstreamUnavailable(err)) {
        logger.warn({ err }, "Frigate unreachable; serving empty system status");
        res.json({ status: EMPTY_SYSTEM_STATUS });
        return;
      }
      next(err);
    }
  });

  // --- Storage breakdown (WARP-1850) ---
  //
  // Per-camera recording usage + measured bitrate, merged with the
  // recordings-volume totals. Same fixed-path reasoning as /cameras/system
  // above: `/cameras/storage` would otherwise match `/cameras/:name`.
  //
  // Deliberately NOT degraded to an empty payload the way /cameras/system
  // is. An empty breakdown reads as "no camera is using disk", which is
  // indistinguishable from a healthy idle system — the exact misreading
  // that let WARP-1849's dead purge look fine for its entire life. A
  // storage surface that cannot reach Frigate must say so.
  router.get("/cameras/storage", async (_req, res, next) => {
    try {
      const storage = await getCameraStorage();
      res.json(storage);
    } catch (err) {
      if (isUpstreamUnavailable(err)) {
        logger.warn({ err }, "Frigate unreachable; cannot report camera storage");
        return res.status(503).json({
          error: "storage_unavailable",
          message: "Storage usage is unavailable while the camera service is unreachable.",
        });
      }
      next(err);
    }
  });

  // --- Storage budget (WARP-1851) ---
  //
  // GET  /cameras/:name/budget  — current allocation state
  // PATCH /cameras/:name/budget — set or clear it
  //
  // The GET exists because without it the allocation was write-only: nothing
  // returned `retentionMode` / `storageBudgetBytes`, so the dashboard control
  // rendered blank over a stored budget and the operator could not see what
  // they had set.
  router.get("/cameras/:name/budget", async (req, res, next) => {
    try {
      const name = req.params.name;
      if (!CAMERA_NAME_RE.test(name)) {
        return res.status(400).json({ error: "invalid camera name" });
      }
      const camera = await prisma.camera.findUnique({ where: { name } });
      if (!camera) return res.status(404).json({ error: "camera not found" });

      // Budgets are per-camera but the volume is shared, so this camera's
      // allocation is not readable on its own: an operator who has promised
      // 3 TB across a 2 TB drive will not get the per-camera retention shown
      // here once the drive fills and Frigate starts evicting oldest-first.
      // Reported alongside, so the number and its caveat arrive together.
      //
      // Advisory, so a Frigate outage degrades it to `null` rather than
      // failing a read the DB could otherwise answer in full.
      let overAllocation: OverAllocation | null = null;
      try {
        const [budgeted, storage] = await Promise.all([
          prisma.camera.findMany({
            where: { retentionMode: "BUDGET" },
            select: { storageBudgetBytes: true },
          }),
          getCameraStorage(),
        ]);
        overAllocation = checkOverAllocation(
          budgeted.map((c) => c.storageBudgetBytes),
          storage.volume?.totalBytes ?? null,
        );
      } catch (err) {
        logger.warn(
          { camera: name, err },
          "could not compute fleet over-allocation; reporting it as unknown",
        );
      }

      res.json({
        retentionMode: camera.retentionMode,
        budgetBytes:
          camera.storageBudgetBytes === null
            ? null
            : Number(camera.storageBudgetBytes),
        retentionCeiling: parseCeiling(camera.retentionCeiling),
        overAllocation,
      });
    } catch (err) {
      next(err);
    }
  });

  // `budgetBytes: null` clears the budget and returns the camera to MANUAL.
  // Its retention keeps whatever value it currently has — clearing an
  // allocation must never be the thing that deletes footage.
  //
  // Setting a budget captures the camera's CURRENT windows as the ceiling the
  // controller scales against, then runs one reconcile pass immediately. The
  // earlier version deferred everything to the 03:40 cron while the response
  // stated the new retention as fact, so for up to 24h the operator was told
  // something Frigate was not doing.
  router.patch(
    "/cameras/:name/budget",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const name = req.params.name;
        if (!CAMERA_NAME_RE.test(name)) {
          return res.status(400).json({ error: "invalid camera name" });
        }

        const camera = await prisma.camera.findUnique({ where: { name } });
        if (!camera) {
          return res.status(404).json({ error: "camera not found" });
        }

        const raw = (req.body ?? {}) as { budgetBytes?: unknown };
        if (!("budgetBytes" in raw)) {
          return res.status(400).json({ error: "budgetBytes is required" });
        }

        if (raw.budgetBytes === null) {
          await prisma.camera.update({
            where: { name },
            data: {
              retentionMode: "MANUAL",
              storageBudgetBytes: null,
              retentionCeiling: Prisma.DbNull,
            },
          });
          return res.json({
            retentionMode: "MANUAL",
            budgetBytes: null,
            note: "Retention stays where it is; clearing a budget deletes nothing.",
          });
        }

        // Typed check before the numeric one: `Number()` coerces `true` to 1
        // and `[]` to 0, so a malformed client could otherwise store a 1-byte
        // budget — which is "valid" to a `> 0` test and would drive every
        // retention window to its floor on the next pass.
        const budget = typeof raw.budgetBytes === "number" ? raw.budgetBytes : Number.NaN;
        if (!Number.isFinite(budget) || budget <= 0) {
          return res
            .status(400)
            .json({ error: "budgetBytes must be a positive number of bytes, or null" });
        }

        // Capture the ceiling from live config BEFORE switching mode, so the
        // controller scales against what the operator actually had.
        let ceiling: RetentionWindows | null = null;
        try {
          ceiling = windowsFromSettings(await getCameraSettings(name));
        } catch (err) {
          // Frigate unreachable: refuse rather than storing a budget with no
          // ceiling. A ceiling guessed later could raise a window the
          // operator had switched off, which is the defect this design
          // exists to avoid.
          logger.warn(
            { camera: name, err },
            "cannot read camera settings to capture a retention ceiling",
          );
          return res.status(503).json({
            error: "camera_service_unavailable",
            message:
              "Couldn't read this camera's current retention, so the budget wasn't saved. Try again when the camera service is reachable.",
          });
        }

        await prisma.camera.update({
          where: { name },
          data: {
            retentionMode: "BUDGET",
            storageBudgetBytes: BigInt(Math.round(budget)),
            retentionCeiling: ceiling as unknown as object,
          },
        });

        // Apply now rather than promising what the cron will do later.
        //
        // This is a FLEET pass, not a single-camera one — it reconciles every
        // budget-managed camera, so editing one camera can also re-apply
        // another that has drifted outside its dead band (and Frigate restarts
        // a camera on every config write). Acceptable at appliance camera
        // counts, and the alternative — a single-camera path — would be a
        // second implementation of the same control loop to keep in step.
        //
        // The budget is ALREADY COMMITTED at this point. If the pass throws
        // (Frigate dropping between the write above and the read inside), the
        // request must not 500: that reads as "nothing was saved" when the
        // allocation is in fact stored, and the 03:40 cron will apply it. Fail
        // to an honest 200 that says exactly that.
        let applied: { windows: RetentionWindows } | undefined;
        let held: { reason: string } | undefined;
        let failed: { error: string } | undefined;
        try {
          const pass = await reconcileCameraBudgets(prisma);
          applied = pass.applied.find((a) => a.camera === name);
          held = pass.held.find((h) => h.camera === name);
          failed = pass.failed.find((f) => f.camera === name);
        } catch (err) {
          logger.warn(
            { camera: name, err },
            "budget stored but the immediate reconcile pass failed",
          );
          failed = { error: err instanceof Error ? err.message : String(err) };
        }

        res.json({
          retentionMode: "BUDGET",
          budgetBytes: budget,
          retentionCeiling: ceiling,
          applied: applied?.windows ?? null,
          note: failed
            ? `Budget saved, but adjusting retention failed: ${failed.error}`
            : applied
              ? undefined
              : (held?.reason ?? "Budget saved; retention is already within it."),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // WARP-171: per-route guard. owner ONLY — restarting the Frigate
  // container drops every active stream and pauses event recording
  // for the duration. Matches the matrix's service-restart row.
  router.post("/cameras/system/restart", requireRole("owner"), async (req, res, next) => {
    try {
      // Restart is destructive (every camera goes dark for ~10s) so we
      // gate it behind the network-command tier-2 confirmation flow.
      // Same pattern as camera disable/delete.
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma,
        "frigate.system",
        "restart_frigate",
        {},
        userId,
      );
      if ("blocked" in result && result.blocked) {
        return res
          .status(429)
          .json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          tier: result.tier,
          expiresIn: 60,
        });
      }
      await restartFrigate();
      res.json({ status: "restarting" });
    } catch (err) {
      next(err);
    }
  });

  // --- List all cameras ---
  router.get("/cameras", async (_req, res, next) => {
    try {
      // WARP-475 (G3) shipped a `retention` block here, read from the
      // `hardware.camera_retention_days` / `hardware.event_retention_days`
      // WorkspaceSetting rows. WARP-1849 removed it: those rows fed only
      // the nightly purge cron, which called Frigate endpoints that do not
      // exist (405) and so enforced nothing. Nothing rendered the block
      // either — the §2.5 notice it was built for was never wired up.
      //
      // Retention now lives in exactly one place: Frigate's own config,
      // which Frigate enforces per camera. Keeping a second copy in
      // WorkspaceSetting is the drift that produced this bug. Per-camera
      // windows are served by `GET /api/cameras/:name/settings`; the
      // appliance-wide defaults are the top-level `record:` block in
      // docker/frigate/config.yml, inherited by every camera.
      if (!isInitialized()) {
        return res.json({ cameras: [], _status: "disconnected" });
      }
      const cameras = await getCameras(prisma);
      res.json({ cameras });
    } catch (err) {
      next(err);
    }
  });

  // --- Manually add a camera (name + RTSP URL) ---
  router.post("/cameras", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const { name, rtspUrl, manufacturer, model } = req.body;
      if (!name || typeof name !== "string" || !isValidCameraName(name)) {
        return res.status(400).json({ error: "Invalid camera name (alphanumeric + underscores/hyphens, 1-64 chars)" });
      }
      if (!rtspUrl || typeof rtspUrl !== "string") {
        return res.status(400).json({ error: "Missing rtspUrl" });
      }
      if (!/^rtsps?:\/\/.+/.test(rtspUrl)) {
        return res.status(400).json({ error: "rtspUrl must start with rtsp:// or rtsps://" });
      }

      // Add to Frigate
      const success = await addCamera(name, rtspUrl);
      if (!success) {
        return res.status(500).json({ error: "Failed to add camera to Frigate" });
      }

      // Upsert DB record
      const displayName = name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      await prisma.camera.upsert({
        where: { name },
        create: {
          name,
          displayName,
          manufacturer: manufacturer || null,
          model: model || null,
          ipAddress: new URL(rtspUrl.replace("rtsp://", "http://").replace("rtsps://", "https://")).hostname || "",
          enabled: true,
          autoDiscovered: false,
          lastSeen: new Date(),
        },
        update: {
          displayName,
          manufacturer: manufacturer || undefined,
          model: model || undefined,
          enabled: true,
          lastSeen: new Date(),
        },
      });

      // #11: same best-effort prune as accept/reject/delete — without it an
      // add-only operator keeps stale orphaned Frigate entries forever.
      await reconcileFrigateCameras();

      res.json({ status: "ok", camera: name });
    } catch (err) {
      next(err);
    }
  });

  // --- Trigger a discovery scan ---
  //
  // WARP-1462: admit the MCP service principal alongside the human roles. The
  // scan_for_cameras LLM tool dispatches through `_service:mcp`; a plain
  // requireRole would 403 it before the scan could run (the phantom-target
  // class WARP-1439 fixed for the read tools). Same human set as before —
  // requiresWrite is enforced tool-side, and a discovery scan is non-destructive.
  router.post("/cameras/scan", requireRoleOrMcpService("owner", "admin", "family"), async (_req, res) => {
    try {
      // NET-05: camera-discovery now gates /scan behind DEVICE_SECRET.
      // Forward it like /drivers/fix below, else this proxied call 403s and
      // the manual-scan button breaks.
      const resp = await internalFetch(`${internalBaseUrl(config.CAMERA_DISCOVERY_URL)}/scan`, {
        method: "POST",
        headers: discoveryAuthHeaders(),
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: "Scan failed" });
      }
      const result = (await resp.json()) as Record<string, unknown>;

      // WARP-1847: return what the scan actually found, not just how many.
      // The scan runs synchronously upstream, so by here the pending map is
      // already up to date and the caller can render a list without a second
      // round-trip and without guessing when to poll. `known`/`pending` counts
      // are preserved for the scan_for_cameras LLM tool, which passes this
      // envelope straight through.
      let cameras: unknown[] = [];
      try {
        cameras = (await getCameraCandidates(prisma)).candidates;
      } catch (err) {
        // A scan that ran is still a success; losing the list just means the
        // client falls back to its GET /cameras/discovered poll.
        logger.warn({ err }, "scan completed but candidate list could not be read");
      }
      res.json({ ...result, cameras });
    } catch {
      // Camera-discovery service may not be running (it's in full profile)
      res.json({
        status: "scan_unavailable",
        cameras: [],
        message: "Camera discovery service is not running. Start it with: docker compose --profile full up camera-discovery",
      });
    }
  });

  // --- Filtered events listing (Events page, Phase 2) ---
  //
  // Cursor pagination: the dashboard passes back the smallest
  // `start_time` from the previous page as `before`. The route returns
  // `nextCursor` (number | null) so the client doesn't have to recompute
  // it. Limit is clamped at 200; Frigate accepts up to 1000 but the
  // dashboard's grid renders ~50 comfortably.
  //
  // Filters: `cameras` (csv), `labels` (csv), `min_score`, `before`,
  // `after`, `has_clip`, `has_snapshot`. Anything not supplied is
  // ignored. Camera names + label strings are validated; numeric fields
  // are checked for finiteness.
  router.get("/cameras/events", async (req, res, next) => {
    try {
      const q = req.query as Record<string, string | undefined>;

      // Validate cameras csv
      let cameras: string[] | undefined;
      if (q.cameras) {
        cameras = q.cameras.split(",").map((s) => s.trim()).filter(Boolean);
        if (cameras.some((c) => !isValidCameraName(c))) {
          return res.status(400).json({ error: "Invalid camera name in cameras param" });
        }
      }

      // Validate labels csv (Frigate labels are lowercase alphanumeric +
      // underscore; cap length defensively).
      let labels: string[] | undefined;
      if (q.labels) {
        labels = q.labels.split(",").map((s) => s.trim()).filter(Boolean);
        if (labels.some((l) => !/^[a-z0-9_-]{1,32}$/i.test(l))) {
          return res.status(400).json({ error: "Invalid label in labels param" });
        }
      }

      const numOrUndef = (v: string | undefined): number | undefined => {
        if (v === undefined) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const boolOrUndef = (v: string | undefined): boolean | undefined => {
        if (v === undefined) return undefined;
        if (v === "1" || v === "true") return true;
        if (v === "0" || v === "false") return false;
        return undefined;
      };

      const minScore = numOrUndef(q.min_score);
      if (minScore !== undefined && (minScore < 0 || minScore > 1)) {
        return res.status(400).json({ error: "min_score must be between 0 and 1" });
      }

      const limitRaw = parseInt(q.limit || "50", 10);
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);

      const result = await getEventsFiltered({
        cameras,
        labels,
        minScore,
        before: numOrUndef(q.before),
        after: numOrUndef(q.after),
        hasClip: boolOrUndef(q.has_clip),
        hasSnapshot: boolOrUndef(q.has_snapshot),
        limit,
      });
      res.json(result);
    } catch (err) {
      if (isUpstreamUnavailable(err)) {
        logger.warn({ err }, "Frigate unreachable; serving empty events list");
        res.json({ events: [], nextCursor: null });
        return;
      }
      next(err);
    }
  });

  // --- GenAI event description regeneration (Phase 7.7) ---
  //
  // Frigate's optional genai feature writes natural-language event
  // descriptions onto the event payload. The dashboard shows them
  // in the EventClipModal when present; this endpoint asks Frigate
  // to (re)generate one if the operator wants a refresh — useful
  // when an event ended right as the operator opened it and the
  // description hasn't landed yet.
  router.post(
    "/cameras/events/:eventId/regenerate-description",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        if (!isValidEventId(req.params.eventId)) {
          return res.status(400).json({ error: "Invalid event ID" });
        }
        try {
          await regenerateEventDescription(req.params.eventId);
          res.status(202).json({ status: "queued" });
        } catch (err) {
          if (err instanceof Error && err.message === "genai_disabled") {
            return res.status(503).json({
              error:
                "GenAI descriptions aren't enabled on this Frigate. Add a `genai` block to config.yml under your camera, save from the System page, and try again.",
            });
          }
          throw err;
        }
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Retain-indefinitely toggle (Phase 2.2) ---
  //
  // POST { retain: boolean } — sets or clears the Frigate-side
  // `retain_indefinitely` flag on an event. Operators use this to mark
  // an event "Saved" so the cluster doesn't get swept during the next
  // retention pass. Idempotent on Frigate's end. Returns 204 since the
  // dashboard already has the event DTO and just needs to flip the
  // boolean locally on success.
  router.post("/cameras/events/:eventId/retain", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.eventId)) {
        return res.status(400).json({ error: "Invalid event ID format" });
      }
      const retain = req.body?.retain;
      if (typeof retain !== "boolean") {
        return res.status(400).json({ error: "retain must be a boolean" });
      }
      await setEventRetention(req.params.eventId, retain);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // --- Delete a single event + its clip (WARP-1440) ---
  //
  // Permanently removes the Frigate event, its saved clip, and its
  // snapshot from disk. Destructive and irreversible, so the guard
  // follows the two precedents that apply:
  //
  //   - Human roles: owner/admin/family — the same set every other
  //     destructive camera route admits (DELETE /cameras/:name,
  //     DELETE /cameras/faces/:name, DELETE /cameras/plates/:plate).
  //   - MCP service principal: admitted via requireRoleOrMcpService,
  //     mirroring POST /cameras/clips/share — the delete_clip LLM tool
  //     dispatches through `_service:mcp`, and a plain requireRole
  //     would 403 it before the delete could run. The unattended-agent
  //     risk is covered on the tool side: delete_clip is
  //     requiresConfirmation with a handler-enforced two-step
  //     (confirmation_required until the user approves and the call is
  //     re-issued with confirmed: true), same contract as memory_forget.
  router.delete(
    "/cameras/events/:eventId",
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        if (!isValidEventId(req.params.eventId)) {
          return res.status(400).json({ error: "Invalid event ID format" });
        }
        try {
          await deleteEvent(req.params.eventId);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg === "event_not_found") {
            return res.status(404).json({ error: "Event not found" });
          }
          // Any other Frigate failure (non-2xx, timeout, unreachable) is
          // an upstream error — surface it as 502 with the message so the
          // caller can tell "Frigate said no" from "we blew up".
          logger.warn(
            { err, eventId: req.params.eventId },
            "Frigate event delete failed",
          );
          return res.status(502).json({ error: msg });
        }
        res.json({ status: "deleted", event: req.params.eventId });
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Reviews (Frigate 0.13+ severity-grouped clusters) ---
  //
  // Same filter shape as /cameras/events but the unit is a Review item
  // (cluster) rather than an event. Severity values are validated to a
  // small allow-list — Frigate's wire string is mirrored back, but
  // anything outside `alert | detection | significant_motion` is
  // treated as a 400 to keep us from silently dropping unknown
  // severities into the SQL filter.
  //
  // Cursor pagination is identical to the events route (`before` =
  // smallest start_time of the previous page).
  router.get("/cameras/reviews", async (req, res, next) => {
    try {
      const q = req.query as Record<string, string | undefined>;

      let cameras: string[] | undefined;
      if (q.cameras) {
        cameras = q.cameras.split(",").map((s) => s.trim()).filter(Boolean);
        if (cameras.some((c) => !isValidCameraName(c))) {
          return res.status(400).json({ error: "Invalid camera name in cameras param" });
        }
      }

      let severity: string[] | undefined;
      if (q.severity) {
        severity = q.severity.split(",").map((s) => s.trim()).filter(Boolean);
        const allowed = new Set(["alert", "detection", "significant_motion"]);
        if (severity.some((s) => !allowed.has(s))) {
          return res.status(400).json({ error: "Invalid severity (allowed: alert, detection, significant_motion)" });
        }
      }

      const numOrUndef = (v: string | undefined): number | undefined => {
        if (v === undefined) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const boolOrUndef = (v: string | undefined): boolean | undefined => {
        if (v === undefined) return undefined;
        if (v === "1" || v === "true") return true;
        if (v === "0" || v === "false") return false;
        return undefined;
      };

      const limitRaw = parseInt(q.limit || "50", 10);
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);

      const result = await getReviewsFiltered({
        cameras,
        severity,
        before: numOrUndef(q.before),
        after: numOrUndef(q.after),
        reviewed: boolOrUndef(q.reviewed),
        limit,
      });
      res.json(result);
    } catch (err) {
      if (isUpstreamUnavailable(err)) {
        logger.warn({ err }, "Frigate unreachable; serving empty reviews list");
        res.json({ reviews: [], nextCursor: null });
        return;
      }
      next(err);
    }
  });

  /** Frigate review IDs are UUID-ish — looser than event IDs but bound
   *  to the same character class. Same regex serves both. */
  router.post("/cameras/reviews/:reviewId/viewed", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.reviewId)) {
        return res.status(400).json({ error: "Invalid review ID format" });
      }
      await setReviewViewed(req.params.reviewId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Review preview clip (Frigate-rendered cluster summary mp4).
  router.get("/cameras/reviews/:reviewId/preview", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.reviewId)) {
        return res.status(400).json({ error: "Invalid review ID format" });
      }
      const url = `${config.FRIGATE_URL}/api/review/${encodeURIComponent(req.params.reviewId)}/preview.mp4`;
      const upstream = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `frigate ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      if (upstream.body) {
        pipeUpstreamBody(upstream.body, res);
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  // Review thumbnail.
  router.get("/cameras/reviews/:reviewId/thumbnail", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.reviewId)) {
        return res.status(400).json({ error: "Invalid review ID format" });
      }
      const url = `${config.FRIGATE_URL}/api/review/${encodeURIComponent(req.params.reviewId)}/thumbnail.jpg`;
      const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `frigate ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  // --- Semantic event search (Phase 7.4) ---
  //
  // Frigate 0.14+ exposes /api/events/search with CLIP embeddings.
  // Same filter surface as /cameras/events but ranked by similarity
  // to a natural-language query. The search type ("thumbnail" vs
  // "description") picks which embedding to query. We default to
  // "thumbnail" — visual similarity matches operator intuition for
  // "find me events that look like this."
  //
  // Frigate returns 404/501 if the embeddings stack isn't enabled
  // in the YAML; we map that to 503 + a hint so the dashboard can
  // surface it inline.
  //
  // Registered before /cameras/events/:eventId/snapshot so the
  // literal "search" path matches first; the param-suffix route is
  // 4 segments anyway (events/<id>/snapshot) so they don't actually
  // collide, but ordering keeps the diff readable.
  router.get("/cameras/events/search", async (req, res, next) => {
    try {
      const q = req.query as Record<string, string | undefined>;
      const query = String(q.query ?? "").trim();
      if (!query) {
        return res.status(400).json({ error: "query is required" });
      }
      if (query.length > 500) {
        return res.status(400).json({ error: "query too long (max 500 chars)" });
      }

      let cameras: string[] | undefined;
      if (q.cameras) {
        cameras = q.cameras.split(",").map((s) => s.trim()).filter(Boolean);
        if (cameras.some((c) => !isValidCameraName(c))) {
          return res.status(400).json({ error: "Invalid camera name" });
        }
      }
      let labels: string[] | undefined;
      if (q.labels) {
        labels = q.labels.split(",").map((s) => s.trim()).filter(Boolean);
        if (labels.some((l) => !/^[a-z0-9_-]{1,32}$/i.test(l))) {
          return res.status(400).json({ error: "Invalid label" });
        }
      }
      const numOrUndef = (v: string | undefined) => {
        if (v === undefined) return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };
      const minScore = numOrUndef(q.min_score);
      if (minScore !== undefined && (minScore < 0 || minScore > 1)) {
        return res.status(400).json({ error: "min_score must be 0..1" });
      }
      const limitRaw = parseInt(q.limit || "50", 10);
      const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 200);

      const searchType = q.search_type === "description" ? "description" : "thumbnail";

      try {
        const result = await searchEventsSemanticTyped({
          query,
          searchType,
          cameras,
          labels,
          minScore,
          before: numOrUndef(q.before),
          after: numOrUndef(q.after),
          limit,
        });
        res.json(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === "semantic_search_disabled") {
          return res.status(503).json({
            error:
              "Semantic search isn't enabled on this Frigate. Add `semantic_search.enabled: true` to config.yml under your model section, save from the System page, and try again.",
          });
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  // --- Event snapshot (proxied from Frigate) ---
  //
  // Companion to the existing thumbnail route — returns the full-resolution
  // saved snapshot for events with `has_snapshot=true`. The events page
  // shows this in the playback modal alongside the clip when no clip was
  // recorded.
  router.get("/cameras/events/:eventId/snapshot", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.eventId)) {
        return res.status(400).json({ error: "Invalid event ID format" });
      }
      const url = `${config.FRIGATE_URL}/api/events/${encodeURIComponent(req.params.eventId)}/snapshot.jpg`;
      const upstream = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `frigate ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=3600");
      const buffer = Buffer.from(await upstream.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  // --- SSE stream for real-time events ---
  router.get("/cameras/events/sse", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);

    const heartbeat = setInterval(() => {
      res.write(`: heartbeat\n\n`);
    }, 30_000);

    const unsubscribe = subscribeCameraEvents((event) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        // Client may have disconnected
      }
    });

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  // --- Recent events across all cameras ---
  router.get("/cameras/events/recent", async (req, res, next) => {
    try {
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const events = await getRecentEvents(limit);
      res.json({ events });
    } catch (err) {
      if (isUpstreamUnavailable(err)) {
        logger.warn({ err }, "Frigate unreachable; serving empty recent events");
        res.json({ events: [] });
        return;
      }
      next(err);
    }
  });

  // --- Event thumbnail (proxied from Frigate) ---
  router.get("/cameras/events/:eventId/thumbnail", async (req, res, next) => {
    try {
      if (!isValidEventId(req.params.eventId)) {
        return res.status(400).json({ error: "Invalid event ID format" });
      }
      const frigateResp = await fetchEventThumbnail(req.params.eventId);
      const contentType = frigateResp.headers.get("content-type") || "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=3600");
      const buffer = Buffer.from(await frigateResp.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  // --- Discovered cameras (found on the network, not yet adopted) ---
  //
  // WARP-1847: live-first. This used to answer from Postgres alone, filtering
  // `enabled: false, autoDiscovered: true` — rows the discovery upsert never
  // wrote in that shape (Camera.enabled defaults to true), so the list was
  // structurally always empty and the operator had no way to see what was on
  // the network. getCameraCandidates() reads camera-discovery's live pending
  // map and falls back to those DB rows when the service isn't running.
  //
  // Response is an envelope, not a bare array: `discoveryOnline` is the
  // difference between "nothing on your network" and "the scanner isn't
  // running", and the dashboard must be able to say which.
  router.get("/cameras/discovered", async (_req, res, next) => {
    try {
      const { candidates, discoveryOnline } = await getCameraCandidates(prisma);
      res.json({ cameras: candidates, discoveryOnline });
    } catch (err) {
      next(err);
    }
  });

  // --- Accept a discovered camera (adopt it into Frigate) ---
  //
  // Two id shapes, because there are two sources of truth (WARP-1847):
  //   `mac:<MAC>` → a live camera-discovery record. Only that service holds the
  //                 probed RTSP URL, and it verifies the stream before adding,
  //                 so the accept has to happen there.
  //   <uuid>      → a legacy DB row (or the DB-only fallback list).
  //
  // requireRoleOrMcpService, not requireRole: the accept_discovered_camera LLM
  // tool now dispatches through here (WARP-1847 — it can't flip `enabled` on a
  // `mac:` id that has no row), and it arrives as `_service:mcp`. A plain
  // requireRole would 403 it, shipping the tool registered but dead — the exact
  // class WARP-1462 fixed for /cameras/scan, and what tools-mcp-admission.test.ts
  // exists to catch. requiresWrite is enforced tool-side.
  router.post("/cameras/discovered/:id/accept", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      const mac = macFromCandidateId(req.params.id);
      if (mac) {
        const result = await mutateLiveCandidate(mac, "accept");
        if (!result.ok) {
          // Mirror the upstream status so a 422 ("stream did not verify — needs
          // credentials or a corrected path") reads as an actionable message
          // instead of a generic failure. 5xx is normalised to 502: the caller
          // didn't do anything wrong, the upstream did.
          const status = result.status >= 500 ? 502 : result.status;
          return res.status(status).json({
            error: result.message ?? "Camera discovery could not add this camera",
          });
        }
        // The camera is in Frigate now; keep the DB in step. The MQTT
        // camera_accepted event upserts the row too, but that's asynchronous —
        // doing it here means the very next GET /api/cameras reflects the add.
        await prisma.camera.updateMany({
          where: { macAddress: { in: [mac, mac.toLowerCase()] } },
          data: { enabled: true },
        });
        await reconcileFrigateCameras();
        return res.json({ status: "accepted" });
      }

      const camera = await prisma.camera.update({
        where: { id: req.params.id },
        data: { enabled: true },
      });
      await reconcileFrigateCameras();
      res.json({ status: "accepted", camera: camera.name });
    } catch (err) {
      next(err);
    }
  });

  // --- Reject a discovered camera (stop offering it) ---
  router.post("/cameras/discovered/:id/reject", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      const mac = macFromCandidateId(req.params.id);
      if (mac) {
        const result = await mutateLiveCandidate(mac, "reject");
        if (!result.ok) {
          const status = result.status >= 500 ? 502 : result.status;
          return res.status(status).json({
            error: result.message ?? "Camera discovery could not reject this camera",
          });
        }
        // Discovery remembers the rejected MAC, but a DB row for the same
        // camera would keep it in the fallback list — the rejection has to
        // clear both or the camera reappears.
        await prisma.camera.deleteMany({
          where: {
            macAddress: { in: [mac, mac.toLowerCase()] },
            autoDiscovered: true,
            enabled: false,
          },
        });
        await reconcileFrigateCameras();
        return res.json({ status: "rejected" });
      }

      await prisma.camera.delete({ where: { id: req.params.id } });
      await reconcileFrigateCameras();
      res.json({ status: "rejected" });
    } catch (err) {
      next(err);
    }
  });

  // --- Frigate system stats ---
  router.get("/cameras/stats", async (_req, res, next) => {
    try {
      const stats = await getStats();
      res.json(stats);
    } catch (err) {
      next(err);
    }
  });

  // --- Driver status (proxied from camera-discovery service) ---
  router.get("/cameras/drivers", async (_req, res) => {
    try {
      // NET-05: /drivers is now auth-gated on camera-discovery. Forward
      // DEVICE_SECRET (same pattern as /drivers/fix) so the driver status
      // panel doesn't 403.
      const resp = await internalFetch(`${internalBaseUrl(config.CAMERA_DISCOVERY_URL)}/drivers`, {
        headers: discoveryAuthHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: "Driver check failed" });
      }
      const data = await resp.json();
      res.json(data);
    } catch {
      res.json({
        health: "unknown",
        summary: { note: "Camera discovery service not reachable" },
        kernel_modules: [],
        video_devices: [],
        usb_cameras: [],
        tools: [],
      });
    }
  });

  // WARP-171: per-route guard. owner + admin — Frigate driver install
  // is a system-config mutation, not a household-tier operation.
  // WARP-1528 / ADR-032 §3(b): this trio (drivers + subnet setup/teardown) IS
  // the §9 Cameras `manage` level ("configure cameras — scan, accept,
  // subnets"). The enum floor above is unchanged and still authoritative; the
  // feature gate beside it narrows an Admin-BASED custom role that was granted
  // Cameras at `view`/`act` only. Registered per-route (not at the group) for
  // exactly the §3(b) reason: one floor route group serves two §9 levels.
  router.post("/cameras/drivers/fix", requireRole("owner", "admin"), requireFeatureAccess("cameras", "manage"), async (_req, res, next) => {
    try {
      // Forward DEVICE_SECRET for authentication (the discovery service
      // requires it for kernel module operations like modprobe)
      const resp = await internalFetch(`${internalBaseUrl(config.CAMERA_DISCOVERY_URL)}/drivers/fix`, {
        method: "POST",
        headers: discoveryAuthHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) {
        return res.status(resp.status).json({ error: "Driver fix failed" });
      }
      const data = await resp.json();
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // --- Camera subnet isolation ---
  router.get("/cameras/subnet", async (_req, res) => {
    try {
      const resp = await internalFetch(`${internalBaseUrl(config.ROUTING_SERVICE_URL)}/network/subnets/cameras`, {
        headers: serviceAuthHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) {
        return res.json({ enabled: false, error: "Router not reachable" });
      }
      res.json(await resp.json());
    } catch {
      res.json({ enabled: false, error: "Routing service not reachable" });
    }
  });

  // WARP-171: per-route guard. owner + admin — subnet provisioning
  // is a network-layer write (carves out 192.168.100.0/24 isolation).
  router.post("/cameras/subnet/setup", requireRole("owner", "admin"), requireFeatureAccess("cameras", "manage"), async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "camera.subnet", "camera_subnet_setup", req.body || {}, userId
      );
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          tier: result.tier,
          expiresIn: 60,
        });
      }

      const body = req.body || {};
      const resp = await internalFetch(`${internalBaseUrl(config.ROUTING_SERVICE_URL)}/network/subnets/cameras/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...serviceAuthHeaders() },
        body: JSON.stringify({
          vlan_id: body.vlanId || 100,
          subnet: body.subnet || "192.168.100.1",
          netmask: body.netmask || "255.255.255.0",
          dhcp_start: body.dhcpStart || 100,
          dhcp_limit: body.dhcpLimit || 150,
          leasetime: body.leasetime || "12h",
        }),
        signal: AbortSignal.timeout(30000),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return res.status(resp.status).json(data);
      }
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // WARP-171: per-route guard. owner + admin — same as subnet/setup.
  router.delete("/cameras/subnet", requireRole("owner", "admin"), requireFeatureAccess("cameras", "manage"), async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, "camera.subnet", "camera_subnet_teardown", {}, userId
      );
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          tier: result.tier,
          expiresIn: 60,
        });
      }

      const resp = await internalFetch(`${internalBaseUrl(config.ROUTING_SERVICE_URL)}/network/subnets/cameras`, {
        method: "DELETE",
        headers: serviceAuthHeaders(),
        signal: AbortSignal.timeout(30000),
      });
      const data = await resp.json();
      if (!resp.ok) {
        return res.status(resp.status).json(data);
      }
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  // --- Confirm a camera-domain Tier 2 command (WARP-861) ---
  // Mirrors /switch/command/confirm. The generic /network/command/confirm
  // switch only executes router-domain operations, so the camera tokens
  // minted above (delete_camera / disable_camera / camera_subnet_*) could
  // never be consumed — every camera "Remove" 202'd and silently did
  // nothing. The executors live in this module, so the consumer does too.
  // Role: family stays admitted because the delete/disable mint routes admit
  // family; confirmNetworkCommand pins each token to its minting user, so a
  // family member can never confirm an owner/admin-minted subnet token.
  // WARP-1440: the MCP service principal is admitted so set_camera_detection
  // can complete the WARP-41 disable handshake it starts on /disable — the
  // token-pinned-to-minting-user rule means `_service:mcp` can only ever
  // confirm tokens minted by its own 202.
  router.post("/cameras/command/confirm", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      const userId = req.user?.id;
      const { confirmationToken, operation } = req.body ?? {};
      if (!confirmationToken || typeof confirmationToken !== "string") {
        return res.status(400).json({ error: "Missing 'confirmationToken'", code: "TOKEN_MISSING" });
      }
      // WARP-41 parity with /network/command/confirm: callers must supply
      // the operation name they originally requested (the 202 response does
      // not include it) so a leaked token can't execute something the user
      // never saw.
      if (!operation || typeof operation !== "string") {
        return res.status(400).json({
          error: "Missing 'operation' — clients must supply the operation name they originally requested",
          code: "TOKEN_OPERATION_MISMATCH",
        });
      }
      if (!userId) return res.status(401).json({ error: "UNAUTHORIZED" });
      const result = await confirmNetworkCommand(prisma, confirmationToken, userId, { operation });
      if (!result.confirmed) {
        return res.status(400).json({ error: result.reason, code: result.code });
      }

      const { operation: confirmedOp, params } = result;
      const p = (params || {}) as Record<string, unknown>;
      switch (confirmedOp) {
        case "delete_camera": {
          const name = p.name as string;
          if (!isValidCameraName(name)) {
            return res.status(400).json({ error: "Invalid camera name in confirmed command" });
          }
          await deleteCamera(name);
          await prisma.camera.deleteMany({ where: { name } });
          await reconcileFrigateCameras();
          break;
        }
        case "disable_camera": {
          const name = p.name as string;
          if (!isValidCameraName(name)) {
            return res.status(400).json({ error: "Invalid camera name in confirmed command" });
          }
          await disableDetection(name);
          await prisma.camera.updateMany({ where: { name }, data: { enabled: false } });
          // WARP-1286 follow-up: disable_camera is Tier-2, so THIS confirm
          // handler is the production disable path (the direct /disable route
          // 202s and never runs inline). No reconcile here, so invalidate the
          // list cache explicitly or the `enabled` flag stays stale for CACHE_TTL.
          await invalidateCamerasCache();
          break;
        }
        case "camera_subnet_setup": {
          const resp = await internalFetch(`${internalBaseUrl(config.ROUTING_SERVICE_URL)}/network/subnets/cameras/setup`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...serviceAuthHeaders() },
            body: JSON.stringify({
              vlan_id: (p.vlanId as number) ?? 100,
              subnet: (p.subnet as string) || "192.168.100.1",
              netmask: (p.netmask as string) || "255.255.255.0",
              dhcp_start: (p.dhcpStart as number) ?? 100,
              dhcp_limit: (p.dhcpLimit as number) ?? 150,
              leasetime: (p.leasetime as string) || "12h",
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!resp.ok) {
            return res.status(resp.status).json(await resp.json().catch(() => ({})));
          }
          break;
        }
        case "camera_subnet_teardown": {
          const resp = await internalFetch(`${internalBaseUrl(config.ROUTING_SERVICE_URL)}/network/subnets/cameras`, {
            method: "DELETE",
            headers: serviceAuthHeaders(),
            signal: AbortSignal.timeout(30000),
          });
          if (!resp.ok) {
            return res.status(resp.status).json(await resp.json().catch(() => ({})));
          }
          break;
        }
        default:
          return res.status(400).json({ error: `Unknown operation: ${confirmedOp}` });
      }

      res.json({ status: "ok", operation: confirmedOp, confirmed: true });
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // PARAMETERIZED ROUTES (/cameras/:name) — must come AFTER all fixed paths
  // ==========================================================================

  // --- Single camera details ---
  router.get("/cameras/:name", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const cameras = await getCameras(prisma);
      const camera = cameras.find((c) => c.name === req.params.name);
      if (!camera) {
        return res.status(404).json({ error: "Camera not found" });
      }

      const events = await getRecentEvents(5, req.params.name);
      res.json({ ...camera, recentEvents: events });
    } catch (err) {
      next(err);
    }
  });

  // --- Rename a camera (display name only) — WARP-1893 ---
  //
  // `Camera.name` is the Frigate config key: it names the recording
  // directory, keys the event rows, and roots the MQTT topic tree, so
  // renaming it would orphan every recording the household already has.
  // `displayName` is the human-facing label and the ONLY field this route
  // touches — `name` is never written here.
  //
  // Until now `displayName` was written exactly once, at adoption, as a
  // title-cased transform of the config key (see the manual-add handler
  // above). A camera discovered as `xnv_c8083r_e43022502afd` was therefore
  // stuck displaying "Xnv C8083r E43022502afd" forever, with no way to fix
  // it from any surface. This is the missing write path.
  //
  // requireRoleOrMcpService so the `rename_camera` LLM tool — dispatching
  // as `_service:mcp`, which is neither owner nor admin — can reach it.
  // Human roles are unchanged. Without the MCP variant the tool would ship
  // registered and 403 on every call.
  router.patch(
    "/cameras/:name",
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        if (!isValidCameraName(req.params.name)) {
          return res.status(400).json({ error: "Invalid camera name" });
        }

        const body = (req.body ?? {}) as Record<string, unknown>;
        if (typeof body.displayName !== "string") {
          return res.status(400).json({ error: "displayName must be a string" });
        }
        // NFC once, on write: iOS dictation and some IMEs emit decomposed
        // (NFD) strings, and two byte forms of the same visible name break
        // rename_camera's display-name resolution and read as duplicates.
        const displayName = body.displayName.normalize("NFC").trim();
        if (displayName.length === 0) {
          return res.status(400).json({ error: "displayName cannot be empty" });
        }
        if (displayName.length > MAX_DISPLAY_NAME_LEN) {
          return res
            .status(400)
            .json({ error: `displayName must be ${MAX_DISPLAY_NAME_LEN} characters or fewer` });
        }
        // Control and format characters would corrupt every surface that
        // renders the name (dashboard, OLED, notification bodies) and can
        // smuggle line breaks into log lines.
        if (/[\p{Cc}\p{Cf}]/u.test(displayName)) {
          return res
            .status(400)
            .json({ error: "displayName cannot contain control characters" });
        }

        // Deliberately NOT unique-checked: a household may legitimately have
        // two "Side Gate" cameras, and `Camera.name` remains the unique key.
        //
        // updateMany rather than update: `name` is unique but is not the
        // primary key, and a camera present in Frigate but not yet mirrored
        // into the DB has no row — that is a 404, not a Prisma throw.
        const { count } = await prisma.camera.updateMany({
          where: { name: req.params.name },
          data: { displayName },
        });
        if (count === 0) {
          return res.status(404).json({ error: "Camera not found" });
        }

        // `displayName` is part of the `cameras:list` payload, which
        // getCameras() serves from a 5s cache — without this the rename
        // appears to do nothing for up to CACHE_TTL and the user renames it
        // again. No reconcileFrigateCameras() here: the SET of cameras is
        // unchanged, so Frigate has nothing to sync.
        await invalidateCamerasCache();

        res.json({ status: "renamed", camera: req.params.name, displayName });
      } catch (err) {
        next(err);
      }
    },
  );

  // --- Camera live MJPEG stream (proxied from Frigate — auth-gated) ---
  //
  // Frigate serves a multipart `Content-Type: multipart/x-mixed-replace`
  // stream at `/api/{name}` that any browser will render natively in an
  // <img> as a continuous video feed. Snapshots are good enough for the
  // grid-card thumbnails; this is the path the detail panel uses to give
  // the user a real live view without leaving the Droplet UI.
  //
  // The body has to be piped, not buffered — the stream never EOFs while
  // the camera is up. We hook AbortController to req.close so closing the
  // browser tab unwinds the upstream fetch instead of leaking sockets.
  router.get("/cameras/:name/live", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      const frigateResp = await openMjpegStream(req.params.name, ctrl.signal);
      const contentType =
        frigateResp.headers.get("content-type") ||
        "multipart/x-mixed-replace;boundary=frame";
      res.setHeader("Content-Type", contentType);
      // The stream is live — never let an intermediate cache (browser or
      // upstream proxy) hold a "frame" and replay it.
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Connection", "close");
      if (!frigateResp.body) {
        return res.status(502).json({ error: "Frigate returned no body" });
      }
      pipeUpstreamBody(frigateResp.body, res);
    } catch (err) {
      next(err);
    }
  });

  // --- Camera snapshot (proxied from Frigate — auth-gated) ---
  router.get("/cameras/:name/snapshot", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const height = Math.min(Math.max(parseInt(req.query.h as string) || 480, 100), 1080);
      const frigateResp = await fetchSnapshot(req.params.name, height);
      const contentType = frigateResp.headers.get("content-type") || "image/jpeg";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cache-Control", "public, max-age=5");
      const buffer = Buffer.from(await frigateResp.arrayBuffer());
      res.send(buffer);
    } catch (err) {
      next(err);
    }
  });

  // --- Camera events ---
  router.get("/cameras/:name/events", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const events = await getRecentEvents(limit, req.params.name);
      res.json({ events });
    } catch (err) {
      next(err);
    }
  });

  // --- Enable camera ---
  // WARP-1440: requireRoleOrMcpService so the set_camera_detection LLM tool
  // (dispatching as `_service:mcp`) can toggle; human roles unchanged.
  router.post("/cameras/:name/enable", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      await enableDetection(req.params.name);
      await prisma.camera.updateMany({
        where: { name: req.params.name },
        data: { enabled: true },
      });
      // WARP-1286 follow-up: enable runs inline (not Tier-2, no reconcile), so
      // bust the list cache or the `enabled` flag stays stale for up to CACHE_TTL.
      await invalidateCamerasCache();
      res.json({ status: "enabled", camera: req.params.name });
    } catch (err) {
      next(err);
    }
  });

  // --- Disable camera (Tier 2 — requires confirmation) ---
  // WARP-1440: requireRoleOrMcpService (see /enable). The Tier-2 202 +
  // confirm handshake below applies to the MCP principal exactly as to humans.
  router.post("/cameras/:name/disable", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, `camera.${req.params.name}`, "disable_camera", { name: req.params.name }, userId
      );
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          tier: result.tier,
          expiresIn: 60,
        });
      }

      await disableDetection(req.params.name);
      await prisma.camera.updateMany({
        where: { name: req.params.name },
        data: { enabled: false },
      });
      // WARP-1286 follow-up: defense-in-depth. disable_camera is Tier-2 so in
      // production this branch is unreachable (the guard above 202s and the
      // confirm handler executes); invalidate here too so every disable path is
      // covered if the op is ever allowed inline.
      await invalidateCamerasCache();
      res.json({ status: "disabled", camera: req.params.name });
    } catch (err) {
      next(err);
    }
  });

  // --- Delete camera (Tier 2 — requires confirmation) ---
  router.delete("/cameras/:name", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const userId = req.user?.id;
      const result = await evaluateNetworkCommand(
        prisma, `camera.${req.params.name}`, "delete_camera", { name: req.params.name }, userId
      );
      if ("blocked" in result && result.blocked) {
        return res.status(429).json({ error: result.reason, tier: result.tier, blocked: true });
      }
      if ("requiresConfirmation" in result && result.requiresConfirmation) {
        return res.status(202).json({
          status: "confirmation_required",
          confirmationToken: result.confirmationToken,
          reason: result.reason,
          tier: result.tier,
          expiresIn: 60,
        });
      }

      await deleteCamera(req.params.name);
      await prisma.camera.deleteMany({ where: { name: req.params.name } });
      await reconcileFrigateCameras();
      res.json({ status: "deleted", camera: req.params.name });
    } catch (err) {
      next(err);
    }
  });

  // --- Notification preferences ---
  router.get("/cameras/:name/notifications", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const camera = await prisma.camera.findUnique({ where: { name: req.params.name } });
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      const prefs = await prisma.cameraNotificationPref.findUnique({
        where: { userId_cameraId: { userId: req.user.id, cameraId: camera.id } },
      });

      res.json(
        prefs || { onPerson: true, onVehicle: true, onAnimal: false, onMotion: false }
      );
    } catch (err) {
      next(err);
    }
  });

  router.put("/cameras/:name/notifications", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      if (!req.user) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const camera = await prisma.camera.findUnique({ where: { name: req.params.name } });
      if (!camera) return res.status(404).json({ error: "Camera not found" });

      // Validate boolean types
      const { onPerson, onVehicle, onAnimal, onMotion } = req.body;
      const boolOrUndef = (v: unknown): boolean | undefined =>
        typeof v === "boolean" ? v : undefined;

      const prefs = await prisma.cameraNotificationPref.upsert({
        where: { userId_cameraId: { userId: req.user.id, cameraId: camera.id } },
        create: {
          userId: req.user.id,
          cameraId: camera.id,
          onPerson: boolOrUndef(onPerson) ?? true,
          onVehicle: boolOrUndef(onVehicle) ?? true,
          onAnimal: boolOrUndef(onAnimal) ?? false,
          onMotion: boolOrUndef(onMotion) ?? false,
        },
        update: {
          onPerson: boolOrUndef(onPerson),
          onVehicle: boolOrUndef(onVehicle),
          onAnimal: boolOrUndef(onAnimal),
          onMotion: boolOrUndef(onMotion),
        },
      });

      res.json(prefs);
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // RECORDINGS + TIMELINE (Phase 3.1)
  // ==========================================================================
  //
  // The Recordings page hits these in sequence on load:
  //   1. summary → paint the date picker + hourly heatmap on the
  //      timeline scrubber.
  //   2. recordings → list the actual segments for the chosen window
  //      so we can compute gaps + render a contiguous progress bar.
  //   3. timeline → dot the scrubber where things happened.
  //   4. playback (mp4 range) → the <video> source for the chosen
  //      time slice. Mp4 is sufficient for windows up to ~10 minutes;
  //      Phase 3.2 will add HLS via hls.js for longer scrubs.
  //
  // All routes register under `/cameras/:name/...` because the
  // suffix discriminates them from the bare `/cameras/:name` route
  // (different segment count → no shadowing). Camera name is
  // validated; `before`/`after` are coerced to finite numbers and
  // sanity-bounded to a 31-day window so a malformed request can't
  // make Frigate scan its whole archive.

  router.get("/cameras/:name/recordings/summary", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const days = await getRecordingsSummary(req.params.name);
      res.json({ days });
    } catch (err) {
      next(err);
    }
  });

  router.get("/cameras/:name/recordings", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const range = parseRecordingRange(req);
      if ("error" in range) {
        return res.status(400).json({ error: range.error });
      }
      const segments = await getRecordings(
        req.params.name,
        range.after,
        range.before,
      );
      res.json({ segments });
    } catch (err) {
      next(err);
    }
  });

  router.get("/cameras/:name/timeline", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const range = parseRecordingRange(req);
      if ("error" in range) {
        return res.status(400).json({ error: range.error });
      }
      const entries = await getTimelineEntries(
        req.params.name,
        range.after,
        range.before,
      );
      res.json({ entries });
    } catch (err) {
      next(err);
    }
  });

  /**
   * Range-mp4 playback. Streams Frigate's synthesised clip.mp4 for
   * the requested window. Cap at 30 minutes so a misbehaving caller
   * can't pin a Frigate worker for an hour synthesising one mp4.
   * Long-window playback comes in Phase 3.2 via HLS.
   */
  router.get("/cameras/:name/playback", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const range = parseRecordingRange(req);
      if ("error" in range) {
        return res.status(400).json({ error: range.error });
      }
      const span = range.before - range.after;
      if (span > 30 * 60) {
        return res.status(400).json({
          error: "Playback range exceeds 30 minutes — pick a smaller window or use the export endpoint",
        });
      }

      const url = buildRecordingClipUrl(req.params.name, range.after, range.before);
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      // Recording mp4 synthesis can take a few seconds for longer ranges.
      // Set a generous timeout but still bounded so a stuck request
      // eventually frees the connection.
      const upstream = await fetch(url, {
        signal: AbortSignal.any
          ? AbortSignal.any([ctrl.signal, AbortSignal.timeout(60_000)])
          : ctrl.signal,
      });
      if (!upstream.ok) {
        return res.status(upstream.status).json({ error: `frigate ${upstream.status}` });
      }
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "video/mp4");
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      res.setHeader("Cache-Control", "private, max-age=300");
      if (upstream.body) {
        pipeUpstreamBody(upstream.body, res);
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  // --- HLS playback (Phase 3.2) ---
  //
  // Returns the media playlist for a VOD time range, with segment refs
  // rewritten to point at our segment proxy so .ts files stay LAN-side.
  // Lifts the 30-minute cap of the mp4 playback route — operators can
  // scrub a full hour (or more) without a synthesised stitch.
  //
  // The route resolves Frigate's master playlist, follows it to the
  // first media playlist, then rewrites that playlist's segment refs.
  // A master that's already a media playlist (no #EXT-X-STREAM-INF
  // entries, just segments) is detected and rewritten in place.
  router.get("/cameras/:name/playback.m3u8", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const range = parseRecordingRange(req);
      if ("error" in range) {
        return res.status(400).json({ error: range.error });
      }

      const masterUrl = buildVodMasterUrl(
        req.params.name,
        range.after,
        range.before,
      );
      let playlistText = await fetchHlsPlaylist(masterUrl);

      // If the master references a sub-playlist (most common Frigate
      // shape), follow the first non-comment .m3u8 reference. Otherwise
      // we treat the response as already-a-media-playlist.
      const lines = playlistText.split(/\r?\n/);
      const subRel = lines.find(
        (line) =>
          !line.startsWith("#") &&
          line.trim() !== "" &&
          line.trim().endsWith(".m3u8"),
      );
      if (subRel) {
        const subUrl = new URL(subRel.trim(), masterUrl).href;
        playlistText = await fetchHlsPlaylist(subUrl);
      }

      // Rewrite each segment line to point at our proxy. We pass the
      // range params back through so the segment route knows which VOD
      // window to fetch from. URL-encoding handles segment names with
      // weird characters even though Frigate's emit boring "0.ts".
      const segPrefix = `/api/cameras/${encodeURIComponent(req.params.name)}/playback.segment?after=${range.after}&before=${range.before}&seg=`;
      const rewritten = playlistText
        .split(/\r?\n/)
        .map((line) => {
          if (line.startsWith("#") || line.trim() === "") return line;
          // It's a URL line. Leave absolute URLs alone (defense — Frigate
          // doesn't usually emit them, but a future version might). Otherwise
          // route through our segment proxy.
          if (/^https?:\/\//i.test(line)) return line;
          return `${segPrefix}${encodeURIComponent(line.trim())}`;
        })
        .join("\n");

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.setHeader("Cache-Control", "no-store");
      res.send(rewritten);
    } catch (err) {
      // hls.js retries on transient errors, but a clean 502 is the
      // signal that the upstream is broken (vs 4xx for "you sent us a
      // bad range").
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("HLS playlist")) {
        return res.status(502).json({ error: msg });
      }
      next(err);
    }
  });

  /** Single-segment proxy. Validates `seg` looks like a Frigate segment
   *  name (alphanumeric + .ts/.m4s) so a malicious caller can't slip a
   *  traversal path through. */
  router.get("/cameras/:name/playback.segment", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const range = parseRecordingRange(req);
      if ("error" in range) {
        return res.status(400).json({ error: range.error });
      }
      const seg = String(req.query.seg ?? "");
      // Allow only the segment shapes Frigate emits — alphanumeric +
      // single-segment filename + an extension we expect.
      if (!/^[a-zA-Z0-9_-]{1,64}\.(ts|m4s|mp4)$/.test(seg)) {
        return res.status(400).json({ error: "Invalid segment name" });
      }

      const url = buildVodSegmentUrl(
        req.params.name,
        range.after,
        range.before,
        seg,
      );
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      const upstream = await fetch(url, {
        signal: AbortSignal.any
          ? AbortSignal.any([ctrl.signal, AbortSignal.timeout(30_000)])
          : ctrl.signal,
      });
      if (!upstream.ok) {
        return res.status(upstream.status).end();
      }
      res.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") || "video/MP2T",
      );
      const len = upstream.headers.get("content-length");
      if (len) res.setHeader("Content-Length", len);
      // Each segment is immutable for a given (camera, range, seg)
      // tuple — long cache keeps repeat scrubs cheap.
      res.setHeader("Cache-Control", "private, max-age=3600");
      if (upstream.body) {
        pipeUpstreamBody(upstream.body, res);
      } else {
        res.end();
      }
    } catch (err) {
      next(err);
    }
  });

  // ==========================================================================
  // PER-CAMERA SETTINGS (Phase 4.1)
  // ==========================================================================
  //
  // GET returns a typed slice of Frigate's per-camera config that the
  // dashboard's settings page edits. PATCH accepts a partial update,
  // merges it into Frigate's full config, and POSTs back via
  // /api/config/save?save_option=restart so the change takes effect.
  //
  // The PATCH body is validated structurally here (types) and
  // semantically in the service (ranges). 4xx is preferred over 500
  // for bad input, so we surface the service's `Error.message` when
  // it shape-mismatches obvious things like "threshold > 1".

  router.get("/cameras/:name/settings", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const settings = await getCameraSettings(req.params.name);
      res.json({ settings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return void res.status(404).json({ error: msg });
      next(err);
    }
  });

  // WARP-1440: requireRoleOrMcpService so the set_detection_zones LLM tool
  // (dispatching as `_service:mcp`) can write zones; human roles unchanged.
  router.patch("/cameras/:name/settings", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: CameraSettingsPatch = {};

      // Per-field structural validation. The service does range +
      // semantic checks; we just keep obviously-wrong shapes out of
      // the YAML write path.
      const isBool = (v: unknown): v is boolean => typeof v === "boolean";
      const isFiniteNum = (v: unknown): v is number =>
        typeof v === "number" && Number.isFinite(v);

      if ("detectEnabled" in body) {
        if (!isBool(body.detectEnabled)) {
          return res.status(400).json({ error: "detectEnabled must be boolean" });
        }
        patch.detectEnabled = body.detectEnabled;
      }
      if ("detectFps" in body) {
        if (!isFiniteNum(body.detectFps)) {
          return res.status(400).json({ error: "detectFps must be a number" });
        }
        patch.detectFps = body.detectFps;
      }
      if ("trackedLabels" in body) {
        if (
          !Array.isArray(body.trackedLabels) ||
          body.trackedLabels.some(
            (s) => typeof s !== "string" || !/^[a-z0-9_-]{1,32}$/i.test(s),
          )
        ) {
          return res.status(400).json({
            error: "trackedLabels must be a list of label strings",
          });
        }
        patch.trackedLabels = body.trackedLabels as string[];
      }
      if ("objectFilters" in body) {
        if (
          !body.objectFilters ||
          typeof body.objectFilters !== "object" ||
          Array.isArray(body.objectFilters)
        ) {
          return res.status(400).json({
            error: "objectFilters must be an object",
          });
        }
        const filters: Record<string, { threshold?: number; minScore?: number }> = {};
        for (const [label, raw] of Object.entries(
          body.objectFilters as Record<string, unknown>,
        )) {
          if (!/^[a-z0-9_-]{1,32}$/i.test(label)) {
            return res
              .status(400)
              .json({ error: `Invalid label in objectFilters: ${label}` });
          }
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return res
              .status(400)
              .json({ error: `objectFilters.${label} must be an object` });
          }
          const r = raw as Record<string, unknown>;
          const entry: { threshold?: number; minScore?: number } = {};
          if ("threshold" in r) {
            if (!isFiniteNum(r.threshold)) {
              return res.status(400).json({
                error: `objectFilters.${label}.threshold must be a number`,
              });
            }
            entry.threshold = r.threshold;
          }
          if ("minScore" in r) {
            if (!isFiniteNum(r.minScore)) {
              return res.status(400).json({
                error: `objectFilters.${label}.minScore must be a number`,
              });
            }
            entry.minScore = r.minScore;
          }
          filters[label] = entry;
        }
        patch.objectFilters = filters;
      }
      if ("recordEnabled" in body) {
        if (!isBool(body.recordEnabled)) {
          return res.status(400).json({ error: "recordEnabled must be boolean" });
        }
        patch.recordEnabled = body.recordEnabled;
      }
      // WARP-1849: the four retention windows Frigate 0.17 enforces.
      // The old single `recordRetainDays` mapped to `record.retain`,
      // a key 0.17 rejects outright — see camera-settings.service.ts.
      for (const field of [
        "continuousRetainDays",
        "motionRetainDays",
        "alertsRetainDays",
        "detectionsRetainDays",
      ] as const) {
        if (field in body) {
          if (!isFiniteNum(body[field])) {
            return res.status(400).json({ error: `${field} must be a number` });
          }
          patch[field] = body[field] as number;
        }
      }
      if ("snapshotsEnabled" in body) {
        if (!isBool(body.snapshotsEnabled)) {
          return res
            .status(400)
            .json({ error: "snapshotsEnabled must be boolean" });
        }
        patch.snapshotsEnabled = body.snapshotsEnabled;
      }
      if ("snapshotRetainDays" in body) {
        if (!isFiniteNum(body.snapshotRetainDays)) {
          return res
            .status(400)
            .json({ error: "snapshotRetainDays must be a number" });
        }
        patch.snapshotRetainDays = body.snapshotRetainDays;
      }
      if ("zones" in body) {
        if (!Array.isArray(body.zones)) {
          return res.status(400).json({ error: "zones must be an array" });
        }
        const zones: typeof patch.zones = [];
        for (const raw of body.zones) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return res.status(400).json({ error: "Each zone must be an object" });
          }
          const z = raw as Record<string, unknown>;
          if (typeof z.name !== "string") {
            return res.status(400).json({ error: "Zone name must be a string" });
          }
          if (
            !Array.isArray(z.coordinates) ||
            z.coordinates.some((c) => typeof c !== "number")
          ) {
            return res
              .status(400)
              .json({ error: `Zone ${z.name} coordinates must be a number array` });
          }
          if (z.objects !== undefined && !Array.isArray(z.objects)) {
            return res
              .status(400)
              .json({ error: `Zone ${z.name} objects must be an array` });
          }
          zones.push({
            name: z.name,
            coordinates: z.coordinates as number[],
            objects: Array.isArray(z.objects) ? (z.objects as string[]) : [],
            inertia: typeof z.inertia === "number" ? z.inertia : 3,
          });
        }
        patch.zones = zones;
      }
      if ("motionMasks" in body) {
        if (!Array.isArray(body.motionMasks)) {
          return res.status(400).json({ error: "motionMasks must be an array" });
        }
        const masks: typeof patch.motionMasks = [];
        for (const raw of body.motionMasks) {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return res
              .status(400)
              .json({ error: "Each motion mask must be an object" });
          }
          const m = raw as Record<string, unknown>;
          if (
            !Array.isArray(m.coordinates) ||
            m.coordinates.some((c) => typeof c !== "number")
          ) {
            return res.status(400).json({
              error: "Motion mask coordinates must be a number array",
            });
          }
          masks.push({ coordinates: m.coordinates as number[] });
        }
        patch.motionMasks = masks;
      }

      const settings = await updateCameraSettings(req.params.name, patch);

      // WARP-1851: if this camera is budget-managed and the operator just
      // changed a retention window by hand, that edit IS their new ceiling.
      // Without this the nightly controller would scale against the old
      // ceiling and silently revert them — an edit that appears to save and
      // then quietly undoes itself is worse than one that is refused.
      const touchedRetention =
        patch.continuousRetainDays !== undefined ||
        patch.motionRetainDays !== undefined ||
        patch.alertsRetainDays !== undefined ||
        patch.detectionsRetainDays !== undefined;

      if (touchedRetention) {
        const cam = await prisma.camera.findUnique({
          where: { name: req.params.name },
          select: { retentionMode: true },
        });
        if (cam?.retentionMode === "BUDGET") {
          const ceiling = windowsFromSettings(settings);
          await prisma.camera.update({
            where: { name: req.params.name },
            data: { retentionCeiling: ceiling as unknown as object },
          });
          logger.info(
            { camera: req.params.name, ceiling },
            "manual retention edit raised the budget ceiling for this camera",
          );
        }
      }

      res.json({ settings });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found")) return void res.status(404).json({ error: msg });
      // Surface range/threshold errors as 400 so the dashboard can
      // render them inline next to the offending control.
      if (
        msg.includes("must be between") ||
        msg.includes("Frigate rejected")
      ) {
        return void res.status(400).json({ error: msg });
      }
      next(err);
    }
  });

  // ==========================================================================
  // CLIP EXPORT + SHARE URLS (PR #3)
  // ==========================================================================
  //
  // POST /cameras/:name/clips/export and GET /cameras/:name/live-url stay
  // here because the extra path segments after :name disambiguate them from
  // the bare /cameras/:name handler. The bare-prefix routes
  // (/cameras/clips, /cameras/clips/event/:eventId, /cameras/clips/share)
  // are defined at the TOP of this function above /cameras/:name to avoid
  // the route-shadowing trap documented in the file header.

  /**
   * POST /cameras/:name/clips/export
   *   Export a time-range clip and stash it in /Clips/<camera>/<ts>.mp4 in
   *   the user's Nextcloud. Returns the resulting Nextcloud path so the
   *   dashboard can deep-link into the Files app.
   *
   * WARP-1439 — the export_clip LLM tool dispatches through the MCP service
   * principal (`_service:mcp`), so the guard is requireRoleOrMcpService,
   * mirroring POST /cameras/clips/share and DELETE /cameras/events/:eventId.
   * For that trusted principal ONLY, the per-user Nextcloud credential rides
   * in headers (same posture as the /api/files routes, WARP-861):
   *   X-Nextcloud-Token: the user's NC app-password / session token
   *   X-Nextcloud-User:  the username the export acts as
   * Human sessions keep the session-based resolution (resolveNcToken +
   * req.user.username) unchanged. Unlike share, export needs no confirmation
   * gate: it writes into the caller's own Nextcloud rather than minting a
   * public URL, so it is not a Tier-2 network command.
   */
  router.post("/cameras/:name/clips/export", requireRoleOrMcpService("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const schema = z.object({
        starts_at: z.string().datetime(),
        ends_at: z.string().datetime(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      }
      const isMcp = req.user?.id === "_service:mcp";
      let ncToken: string | null;
      let userId: string | undefined;
      if (isMcp) {
        // No fallback for the service principal: silently exporting as some
        // default user would be a privilege escalation, not a convenience.
        const hdrToken = (req.header("X-Nextcloud-Token") ?? "").trim();
        const hdrUser = (req.header("X-Nextcloud-User") ?? "").trim();
        ncToken = hdrToken.length > 0 ? hdrToken : null;
        userId = hdrUser.length > 0 ? hdrUser : undefined;
      } else {
        ncToken = await resolveNcToken(req);
        userId = req.user?.username;
      }
      if (!ncToken) return res.status(401).json({ error: "nextcloud_session_missing" });
      if (!userId) return res.status(401).json({ error: "unauthenticated" });

      const result = await exportClip(ncToken, userId, {
        camera: req.params.name,
        startsAt: new Date(parsed.data.starts_at),
        endsAt: new Date(parsed.data.ends_at),
      });
      res.status(201).json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "invalid_camera_name") return void res.status(400).json({ error: msg });
      if (msg.includes("must be after")) return void res.status(400).json({ error: msg });
      if (msg.includes("duration capped")) return void res.status(400).json({ error: msg });
      if (msg.includes("clip too large")) return void res.status(413).json({ error: msg });
      if (msg.includes("frigate_export_failed")) return void res.status(502).json({ error: msg });
      next(err);
    }
  });

  // ==========================================================================
  // PTZ (Phase 6.1)
  // ==========================================================================
  //
  // GET /cameras/:name/ptz returns capabilities + preset list (or
  // {supportsPanTilt: false, ...} when the camera isn't a PTZ).
  // POST /cameras/:name/ptz body { action } moves the camera. Each
  // action runs Frigate's continuous-motion API — the dashboard sends
  // a STOP after the operator releases the button, otherwise the
  // camera will keep moving.
  // POST /cameras/:name/ptz/preset body { preset } recalls a saved
  // preset by name.

  router.get("/cameras/:name/ptz", async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const caps = await fetchPtzCapabilities(req.params.name);
      res.json(caps);
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/:name/ptz", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const allowed: PtzAction[] = [
        "MOVE_UP",
        "MOVE_DOWN",
        "MOVE_LEFT",
        "MOVE_RIGHT",
        "ZOOM_IN",
        "ZOOM_OUT",
        "STOP",
      ];
      const action = String((req.body ?? {}).action ?? "");
      if (!allowed.includes(action as PtzAction)) {
        return res.status(400).json({
          error: `action must be one of: ${allowed.join(", ")}`,
        });
      }
      await ptzMove(req.params.name, action as PtzAction);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/cameras/:name/ptz/preset", requireRole("owner", "admin", "family"), async (req, res, next) => {
    try {
      if (!isValidCameraName(req.params.name)) {
        return res.status(400).json({ error: "Invalid camera name" });
      }
      const preset = String((req.body ?? {}).preset ?? "").trim();
      // Frigate preset names are alphanumeric-with-spaces in practice.
      // Tighten to the same character class we use for camera names so
      // a malicious caller can't slip path-traversal through.
      if (!/^[a-zA-Z0-9 _-]{1,64}$/.test(preset)) {
        return res.status(400).json({ error: "Invalid preset name" });
      }
      await ptzGoToPreset(req.params.name, preset);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /cameras/:name/live-url
   *   Returns the dashboard URL the user can open to see a live view.
   *   Intentionally NOT a signed URL — the dashboard handles the playback
   *   via the existing snapshot polling endpoint, which is already
   *   session-authenticated.
   */
  router.get("/cameras/:name/live-url", (req, res) => {
    if (!isValidCameraName(req.params.name)) {
      return res.status(400).json({ error: "Invalid camera name" });
    }
    res.json({
      live_url: `/cameras/${encodeURIComponent(req.params.name)}`,
      snapshot_url: `/api/cameras/${encodeURIComponent(req.params.name)}/snapshot`,
    });
  });

  return router;
}

/**
 * Parse + sanity-check a recording range from query params (`after`,
 * `before` in Unix seconds). Returns `{ after, before }` on success or
 * `{ error }` for the caller to surface as 400.
 *
 * Both bounds must be positive finite numbers, after must be earlier
 * than before, and the total span is capped at 31 days so a careless
 * `?before=0&after=2000000000` doesn't make Frigate scan its whole
 * archive (and our timeline endpoint return 1000s of rows).
 */
function parseRecordingRange(req: import("express").Request):
  | { after: number; before: number }
  | { error: string } {
  const q = req.query as Record<string, string | undefined>;
  const a = Number(q.after);
  const b = Number(q.before);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return { error: "after and before must be Unix-second timestamps" };
  }
  if (a <= 0 || b <= 0) {
    return { error: "after and before must be positive" };
  }
  if (a >= b) {
    return { error: "after must be earlier than before" };
  }
  if (b - a > 31 * 24 * 60 * 60) {
    return { error: "range exceeds 31 days" };
  }
  return { after: a, before: b };
}

/** Defense-in-depth path validation mirroring PR #1's validateNcPath
 *  logic. Reject traversal markers (raw and percent-decoded) so a caller
 *  can't sign a share URL whose ncPath escapes their Nextcloud namespace. */
function isSafeNcPath(input: string): { ok: true; path: string } | { ok: false; error: string } {
  if (input.length > 4096) return { ok: false, error: "nc_path too long" };
  if (input.includes("\0")) return { ok: false, error: "null byte in nc_path" };
  let decoded = input;
  for (let i = 0; i < 4 && decoded.includes("%"); i++) {
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { return { ok: false, error: "malformed percent-encoding in nc_path" }; }
    if (next === decoded) break;
    decoded = next;
  }
  for (const candidate of [input, decoded]) {
    if (candidate.split(/[\\/]/).some((seg) => seg === "..")) {
      return { ok: false, error: "nc_path traversal not allowed" };
    }
  }
  const normalized = decoded.startsWith("/") ? decoded : "/" + decoded;
  return { ok: true, path: normalized };
}

/**
 * Public router for the share endpoint — no auth, signed token in query is
 * the authorization. Mounted in app.ts BEFORE the auth middleware so a
 * forwarded link works without a Droplet session. The Nextcloud token used
 * to actually fetch the file isn't the recipient's — it's an admin-scoped
 * fetch, so the recipient never gets implicit access to anything else.
 */
export function createCameraSharePublicRouter(): Router {
  const router = Router();
  router.get("/cameras/clips/share/:filename", async (req, res, next) => {
    try {
      const token = req.query.t as string | undefined;
      if (!token) return res.status(403).json({ error: "missing_token" });
      const verified = verifyShareUrl(token);
      if (!verified) return res.status(403).json({ error: "invalid_or_expired_token" });

      // Resolve the file via the SAME user's Nextcloud namespace. We don't
      // have their cookie here — a long-lived service-account NC token
      // would be required for true zero-recipient-context fetch, which is
      // a deployment concern. For v1 we return a clear error if the
      // service account isn't configured; the share URL still won't leak
      // because the token verification already passed.
      const ncToken = process.env.NEXTCLOUD_SERVICE_TOKEN;
      if (!ncToken) {
        return res.status(503).json({
          error: "share_service_not_configured",
          hint: "Set NEXTCLOUD_SERVICE_TOKEN to enable cross-session clip sharing.",
        });
      }

      const stream = await ncDownloadFile(ncToken, verified.userId, verified.ncPath);
      if (!stream) return res.status(404).json({ error: "clip_not_found" });

      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Disposition", `inline; filename="${req.params.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`);
      pipeUpstreamBody(stream, res);
    } catch (err) {
      next(err);
    }
  });
  return router;
}
