/**
 * Camera clip + live URL service.
 *
 * Three responsibilities:
 *  1. Export a time-range clip from Frigate (HTTP GET on its export endpoint)
 *     and stash the resulting MP4 into the user's Nextcloud at
 *     `/Clips/{camera}/{timestamp}.mp4` so it shows up in the Files app and
 *     in the dashboard's Clips tab.
 *  2. Issue short-lived signed share URLs (HMAC of DEVICE_SECRET + payload)
 *     so the LLM can hand the user a link they can forward without a
 *     session cookie. URLs expire on a deadline embedded in the token.
 *  3. Build live-stream URLs the dashboard can render directly. For v1
 *     that's just the existing snapshot endpoint polled — Frigate's
 *     go2rtc HLS feed is a follow-up because it requires HLS player JS
 *     in the dashboard.
 *
 * Why not just expose Frigate's URL directly? The cameras live on a
 * separate VLAN (192.168.100.0/24) that's NOT routable from the user's
 * device. Frigate is the only thing that can reach them. Proxying through
 * the orchestrator means clip URLs work from anywhere the dashboard does.
 */

import crypto from "node:crypto";
import path from "node:path";
import { ncCreateDirectory, ncUploadFile } from "./nextcloud.client.js";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("clips");

const FRIGATE_URL = config.FRIGATE_URL;
const EXPORT_TIMEOUT_MS = 60_000;
const MAX_CLIP_BYTES = 500 * 1024 * 1024; // 500 MB cap per export

const CLIPS_NC_ROOT = "/Clips";

export interface ExportInput {
  camera: string;
  startsAt: Date;
  endsAt: Date;
}

export interface ExportResult {
  ncPath: string;          // Path inside the user's Nextcloud
  bytes: number;
  durationSec: number;
}

const CAMERA_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function assertCameraName(name: string): void {
  if (!CAMERA_NAME_RE.test(name)) {
    throw new Error("invalid_camera_name");
  }
}

function fmtClipFilename(d: Date): string {
  // Use UTC so filenames sort correctly regardless of host TZ. Phones display
  // them in their local time when previewing the file.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z.mp4`;
}

/** Export a clip from Frigate and copy the bytes into Nextcloud. Returns
 *  the Nextcloud path (relative to the user's root). */
export async function exportClip(
  ncToken: string,
  userId: string,
  input: ExportInput,
): Promise<ExportResult> {
  assertCameraName(input.camera);
  const startEpoch = Math.floor(input.startsAt.getTime() / 1000);
  const endEpoch = Math.floor(input.endsAt.getTime() / 1000);
  if (endEpoch <= startEpoch) throw new Error("endsAt must be after startsAt");
  const durationSec = endEpoch - startEpoch;
  // Cap export duration. The byte cap below is the real safety; this is
  // a "don't make Frigate work for 10 minutes synthesising one mp4"
  // policy. Lifted from 30 → 60 in Phase 3.2A when the recordings page
  // started exporting full-hour windows by default. Anything longer
  // should be done as a chunked job (deferred to Phase 5).
  if (durationSec > 60 * 60) throw new Error("clip duration capped at 60 minutes");

  // Frigate exposes export at /api/<camera>/recordings/<start>/<end>/clip.mp4
  // (epoch seconds). It returns the rendered MP4 directly.
  const url = `${FRIGATE_URL}/api/${encodeURIComponent(input.camera)}/recordings/${startEpoch}/${endEpoch}/clip.mp4`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
  let buffer: Buffer;
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) {
      throw new Error(`frigate_export_failed: ${resp.status} ${resp.statusText}`);
    }
    // Read with a hard byte cap so a runaway recording can't OOM us.
    const reader = resp.body?.getReader();
    if (!reader) throw new Error("frigate_export_no_body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_CLIP_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error(`clip too large (>${MAX_CLIP_BYTES} bytes)`);
      }
      chunks.push(value);
    }
    buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  } finally {
    clearTimeout(timer);
  }

  // Ensure /Clips and /Clips/{camera} exist. mkdir is idempotent at the NC
  // layer (returns 405 on already-exists, which the client treats as ok).
  const cameraDir = `${CLIPS_NC_ROOT}/${input.camera}`;
  await ncCreateDirectory(ncToken, userId, CLIPS_NC_ROOT);
  await ncCreateDirectory(ncToken, userId, cameraDir);

  const filename = fmtClipFilename(input.startsAt);
  await ncUploadFile(ncToken, userId, cameraDir, filename, buffer);

  const ncPath = path.posix.join(cameraDir, filename);
  logger.info({ ncPath, bytes: buffer.byteLength, durationSec }, "clip exported");
  return { ncPath, bytes: buffer.byteLength, durationSec };
}

// ── Share-URL signing ──
//
// A share URL is a regular orchestrator URL with a `?share=` query param
// containing `<base64url(payload)>.<base64url(hmac)>` where payload is
// `{u: ncPath, x: expiryEpoch}`. The signing key is DEVICE_SECRET. The URL
// resolves to GET /api/clips/share/<file.mp4>?share=... which streams the
// MP4 from Nextcloud after verifying the signature + expiry.
//
// Why not JWT? Because we don't want a JWT library dep just for this, and
// our payload is tiny. The HMAC pattern is identical security-wise to a
// JWT with HS256.

const TOKEN_VERSION = 1;

interface SharePayload {
  v: number;     // version
  u: string;     // user id (Nextcloud username)
  p: string;     // ncPath
  x: number;     // expiry epoch seconds
}

function signingKey(): Buffer {
  const k = process.env.DEVICE_SECRET;
  if (!k) {
    // Fail loud regardless of NODE_ENV. A dev fallback constant would be
    // identical on every install — anyone who reads the source could forge
    // a token and exercise the pre-auth share endpoint. Tests set
    // DEVICE_SECRET in their setup; if you're seeing this in a fresh dev
    // env, add `DEVICE_SECRET=any-string-you-want` to your .env.
    throw new Error("DEVICE_SECRET must be set to sign or verify share URLs");
  }
  return Buffer.from(k);
}

function b64url(buf: Buffer): string {
  // Base64 of a Buffer carries at most two `=` pads, so the strip is bounded:
  // `=+$` re-scans an unbounded run from every offset (CodeQL js/polynomial-redos).
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/={1,2}$/, "");
}
function fromB64url(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

/** Defense-in-depth path validation. Reject traversal markers (raw and
 *  percent-decoded) so a caller can't sign a token whose ncPath escapes the
 *  signing user's Nextcloud namespace. Mirrors PR #1's validateNcPath. */
function assertSafeNcPath(ncPath: string): string {
  if (typeof ncPath !== "string") throw new Error("nc_path must be a string");
  if (ncPath.length === 0) throw new Error("nc_path is required");
  if (ncPath.length > 4096) throw new Error("nc_path too long");
  if (ncPath.includes("\0")) throw new Error("null byte in nc_path");
  let decoded = ncPath;
  for (let i = 0; i < 4 && decoded.includes("%"); i++) {
    let next: string;
    try { next = decodeURIComponent(decoded); } catch { throw new Error("malformed percent-encoding in nc_path"); }
    if (next === decoded) break;
    decoded = next;
  }
  for (const candidate of [ncPath, decoded]) {
    if (candidate.split(/[\\/]/).some((seg) => seg === "..")) {
      throw new Error("nc_path traversal not allowed");
    }
  }
  return decoded.startsWith("/") ? decoded : "/" + decoded;
}

export function signShareUrl(
  userId: string,
  ncPath: string,
  ttlSec: number,
): string {
  const safePath = assertSafeNcPath(ncPath);
  const payload: SharePayload = {
    v: TOKEN_VERSION,
    u: userId,
    p: safePath,
    x: Math.floor(Date.now() / 1000) + Math.max(60, Math.min(86400, ttlSec)),
  };
  const payloadStr = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = crypto.createHmac("sha256", signingKey()).update(payloadStr).digest();
  return `${payloadStr}.${b64url(sig)}`;
}

export interface VerifiedShare {
  userId: string;
  ncPath: string;
}

export function verifyShareUrl(token: string): VerifiedShare | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const dot = token.lastIndexOf(".");
  const payloadStr = token.slice(0, dot);
  const sigStr = token.slice(dot + 1);
  let expectedSig: Buffer;
  try {
    expectedSig = crypto.createHmac("sha256", signingKey()).update(payloadStr).digest();
  } catch {
    return null;
  }
  const providedSig = fromB64url(sigStr);
  if (providedSig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;

  let payload: SharePayload;
  try {
    payload = JSON.parse(fromB64url(payloadStr).toString("utf8"));
  } catch {
    return null;
  }
  if (payload.v !== TOKEN_VERSION) return null;
  if (typeof payload.u !== "string" || typeof payload.p !== "string") return null;
  if (typeof payload.x !== "number" || Date.now() / 1000 > payload.x) return null;

  return { userId: payload.u, ncPath: payload.p };
}
