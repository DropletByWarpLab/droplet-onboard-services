/**
 * Operator-typed camera credentials (WARP-3505): validation + embedding into an
 * RTSP URL.
 *
 * The camera's password used to have to be hand-typed into the RTSP URL
 * (`rtsp://user:password@host/...`) with no field for it and no help getting
 * the escaping right. The dashboard now has Username / Password fields and the
 * orchestrator merges them here, server-side, so the password is never part of
 * a URL the browser shows, stores or logs.
 */

/** RTSP/ONVIF account names are short; the caps bound what is hashed/sent downstream. */
export const MAX_CAMERA_USERNAME = 128;
export const MAX_CAMERA_PASSWORD = 256;

export type CredentialValidation = { ok: true } | { ok: false; error: string };

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Check an optional `{ username, password }` pair.
 *
 * Control characters are refused: the values are written into an RTSP
 * `Authorization` header downstream, and a CR/LF would let a caller inject
 * headers. Errors name the FIELD only — never the value (NET-05).
 */
export function validateCameraCredentials(username: unknown, password: unknown): CredentialValidation {
  if (username !== undefined && username !== null && typeof username !== "string") {
    return { ok: false, error: "username must be a string" };
  }
  if (password !== undefined && password !== null && typeof password !== "string") {
    return { ok: false, error: "password must be a string" };
  }
  const user = typeof username === "string" ? username : "";
  const pw = typeof password === "string" ? password : "";
  if (pw && !user) {
    return { ok: false, error: "username is required when a password is given" };
  }
  if (user.length > MAX_CAMERA_USERNAME) return { ok: false, error: "username is too long" };
  if (pw.length > MAX_CAMERA_PASSWORD) return { ok: false, error: "password is too long" };
  if (hasControlChars(user)) return { ok: false, error: "username contains invalid characters" };
  if (hasControlChars(pw)) return { ok: false, error: "password contains invalid characters" };
  return { ok: true };
}

/**
 * Percent-encode one userinfo component for an RTSP URL.
 *
 * RFC 3986 userinfo already permits the sub-delims `!$&'()*+,;=`, and the
 * consumer — Frigate's bundled ffmpeg — does NOT percent-decode userinfo before
 * authenticating, so encoding a legal character (`!` → `%21`) sends the wrong
 * password and a Hanwha locks the account after ~5 attempts (WARP-1873). Only
 * what would corrupt the parse (`@ / : # % ?`, whitespace, non-ASCII) is
 * encoded. Mirrors `RTSP_USERINFO_SAFE` in services/camera-discovery/rtsp_prober.py.
 */
function encodeUserinfo(value: string): string {
  return encodeURIComponent(value)
    .replace(/%24/g, "$")
    .replace(/%26/g, "&")
    .replace(/%2B/g, "+")
    .replace(/%2C/g, ",")
    .replace(/%3B/g, ";")
    .replace(/%3D/g, "=");
}

/**
 * Merge `username`/`password` into `rtspUrl`, replacing any userinfo already
 * there. With no username the URL is returned untouched. The authority is
 * located with a regex rather than `new URL()` because `rtsp:` is not a WHATWG
 * special scheme and a parser would risk normalising the vendor-specific path.
 */
export function embedRtspCredentials(
  rtspUrl: string,
  username: string | undefined | null,
  password: string | undefined | null,
): string {
  if (!username) return rtspUrl;
  const m = /^(rtsps?:\/\/)(?:[^/]*@)?(.*)$/i.exec(rtspUrl);
  if (!m) return rtspUrl;
  return `${m[1]}${encodeUserinfo(username)}:${encodeUserinfo(password ?? "")}@${m[2]}`;
}
