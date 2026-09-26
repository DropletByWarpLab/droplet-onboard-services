/**
 * WARP-3122 part 2 — short-lived signed URLs for recordings HLS segments.
 *
 * ## Why
 *
 * Native clients play recordings with AVPlayer. AVFoundation refuses HLS
 * media segments answered by a custom resource loader (CoreMediaErrorDomain
 * -12881), so the only way to authorize a segment without putting the bearer
 * in `AVURLAssetHTTPHeaderFieldsKey` is for the segment URL itself to carry
 * the authorization. The playlist (fetched with the bearer, through the
 * client's shared session) hands out URLs signed for THAT user, THAT camera,
 * THAT recording window and THAT segment, for a few minutes.
 *
 * ## The contract
 *
 *   GET /api/cameras/:name/playback.segment
 *       ?after=<unix>&before=<unix>&seg=<file>&u=<userId>&exp=<unix>&sig=<b64url>
 *
 *   sig = base64url(HMAC-SHA256(K, JSON.stringify(
 *           ["v1", name, after, before, seg, exp, u])))
 *   K   = HMAC-SHA256(DEVICE_SECRET, "droplet-hls-segment-url:v1")
 *
 * `after`/`before`/`exp` are signed as the literal query strings the box
 * emitted, so re-parsing (the range clamp) can never change what was signed.
 *
 * ## What a signature buys, and what it does not
 *
 * A valid signature stands in for the bearer on that one route only. It
 * does NOT skip any authorization: it becomes `req.user` for the signing
 * person (re-read from the database on every request), and the request then
 * runs the same pipeline as a bearer request — denylist, password-change
 * gate, the cameras module gate and per-person feature access, the role
 * check and the per-camera grant. A person deactivated, demoted or removed
 * from the camera after the playlist was served stops getting segments.
 * An invalid or expired signature is simply ignored, so a caller that also
 * sends a bearer or cookie (the web dashboard) still gets through on that.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { isWeakDeviceSecret } from "../lib/device-secret.js";
import { createLogger } from "../lib/logger.js";
import { isUserDenied } from "./auth-denylist.service.js";
import type { AuthUser } from "../middleware/auth.js";

const logger = createLogger("segment-url-signing");

/** Roles that may reach the camera surface at all (mirrors CAMERA_VIEW_ROLES). */
const SEGMENT_ROLES: ReadonlySet<string> = new Set(["owner", "admin", "family"]);

/**
 * TTL ruling (WARP-3122): a VOD playlist is fetched ONCE and then played to
 * the end, so the signature must outlive the recording it covers. Minimum
 * 10 minutes, otherwise the window length plus 5 minutes of pause/seek
 * slack, capped at 2 hours so a leaked URL is never good for long. A
 * recording longer than ~1 h 55 min needs a playlist refresh to keep
 * playing past the cap.
 */
export const SEGMENT_SIG_MIN_TTL_SEC = 10 * 60;
export const SEGMENT_SIG_SLACK_SEC = 5 * 60;
export const SEGMENT_SIG_MAX_TTL_SEC = 2 * 60 * 60;
/** Clock skew allowed on the `exp` upper bound. */
export const SEGMENT_SIG_SKEW_SEC = 60;

export function segmentSignatureTtlSec(after: number, before: number): number {
  const duration = Math.max(0, before - after);
  return Math.min(
    SEGMENT_SIG_MAX_TTL_SEC,
    Math.max(SEGMENT_SIG_MIN_TTL_SEC, duration + SEGMENT_SIG_SLACK_SEC),
  );
}

/** Domain-separated sub-key: DEVICE_SECRET also keys share URLs and claim codes. */
function segmentKey(): Buffer | null {
  const secret = process.env.DEVICE_SECRET;
  if (isWeakDeviceSecret(secret)) return null;
  return createHmac("sha256", secret as string).update("droplet-hls-segment-url:v1").digest();
}

function mac(key: Buffer, fields: string[]): Buffer {
  return createHmac("sha256", key).update(JSON.stringify(["v1", ...fields])).digest();
}

export interface SegmentSigFields {
  camera: string;
  after: string;
  before: string;
  seg: string;
  userId: string;
  exp: string;
}

/**
 * Query suffix (`&u=…&exp=…&sig=…`) authorizing one segment, or `""` when the
 * box has no usable DEVICE_SECRET — the URL then needs the bearer, as before.
 */
export function signSegmentQuery(f: Omit<SegmentSigFields, "exp">, expUnix: number): string {
  const key = segmentKey();
  if (!key) return "";
  const exp = String(expUnix);
  const sig = mac(key, [f.camera, f.after, f.before, f.seg, exp, f.userId]).toString("base64url");
  return `&u=${encodeURIComponent(f.userId)}&exp=${exp}&sig=${sig}`;
}

/** PURE apart from the clock and the key. Constant-time compare. */
export function verifySegmentSignature(f: SegmentSigFields, sig: string, nowSec = Date.now() / 1000): boolean {
  const key = segmentKey();
  if (!key) return false;
  // Upper bound too: the box never signs past the TTL cap, so an `exp` beyond
  // it (plus clock skew) is not one this box issued at the current rules.
  if (!/^\d{1,12}$/.test(f.exp)) return false;
  const exp = Number(f.exp);
  if (exp <= nowSec || exp > nowSec + SEGMENT_SIG_MAX_TTL_SEC + SEGMENT_SIG_SKEW_SEC) return false;
  const expected = mac(key, [f.camera, f.after, f.before, f.seg, f.exp, f.userId]);
  const provided = Buffer.from(sig, "base64url");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * WARP-3122 — set ONLY by `createSignedSegmentRouter` after a valid,
       * unexpired segment signature for a still-active person. authMiddleware
       * adopts it as `req.user` when the request carries no credential.
       */
      signedSegmentUser?: AuthUser;
    }
  }
}

function q(req: Request, name: string): string | null {
  const v = req.query[name];
  return typeof v === "string" ? v : null;
}

/**
 * Mounted in app.ts right before authMiddleware. Never answers a request
 * itself: it only resolves the signing person and calls next().
 */
export function createSignedSegmentRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get("/cameras/:name/playback.segment", (req, _res, next) => {
    const sig = q(req, "sig");
    if (!sig) return next();
    const fields = {
      camera: req.params.name,
      after: q(req, "after"),
      before: q(req, "before"),
      seg: q(req, "seg"),
      userId: q(req, "u"),
      exp: q(req, "exp"),
    };
    if (Object.values(fields).some((v) => v === null)) return next();
    if (!verifySegmentSignature(fields as SegmentSigFields, sig)) {
      logger.debug({ camera: fields.camera }, "segment signature invalid or expired; falling back to bearer");
      return next();
    }
    const userId = fields.userId as string;
    void (async () => {
      const [dbUser, denied] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { id: true, username: true, displayName: true, role: true, directoryStatus: true, accessRoleId: true },
        }),
        isUserDenied(userId),
      ]);
      if (!dbUser || denied || dbUser.directoryStatus !== "ACTIVE" || !SEGMENT_ROLES.has(dbUser.role)) {
        logger.info({ userId, camera: fields.camera }, "signed segment refused: signer no longer active or allowed");
        return;
      }
      req.signedSegmentUser = {
        id: dbUser.id,
        username: dbUser.username,
        displayName: dbUser.displayName,
        role: dbUser.role,
        accessRoleId: dbUser.accessRoleId ?? null,
      };
    })()
      .catch((err) => {
        // Fail closed: no principal, so authMiddleware answers 401.
        logger.error({ err }, "signed segment principal lookup failed");
      })
      .finally(() => next());
  });
  return router;
}
