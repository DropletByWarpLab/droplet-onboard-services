/**
 * Operator-typed camera credentials (WARP-3505): validation + writing them into
 * the RTSP URL Frigate is given.
 *
 * The camera's password used to have to be hand-typed into the RTSP URL
 * (`rtsp://user:password@host/...`) with no field for it and no help getting
 * the escaping right. The dashboard now has Username / Password fields and the
 * orchestrator merges them here, server-side, so the password is never part of
 * a URL the browser shows, stores or logs.
 *
 * What Frigate must be given is NOT "the password, percent-encoded"
 * ----------------------------------------------------------------
 * Frigate 0.17 runs `escape_special_characters` (frigate/util/builtin.py) over
 * every ffmpeg input path before handing it to ffmpeg:
 *
 *     REGEX_RTSP_CAMERA_USER_PASS = r":\/\/[a-zA-Z0-9_-]+:[\S]+@"
 *     found = re.search(REGEX, path).group(0)[3:-1]       # user:password
 *     pw = found[found.index(":") + 1:]
 *     return path.replace(pw, urllib.parse.quote_plus(pw))
 *
 * and ffmpeg then URL-decodes the `user:password` text ONCE (httpauth.c) and
 * splits it at the first `:`. So:
 *
 *  - a username matching [A-Za-z0-9_-]+ : store the password RAW. Frigate encodes
 *    it, ffmpeg decodes it, the camera gets what was typed. Pre-encoded
 *    (`C%40mera!2024`) is encoded AGAIN (`%2540`) and the camera receives the
 *    percent-escape: 401 on every retry, then a Hanwha lockout.
 *  - any other username : Frigate's regex does not match, nothing re-encodes the
 *    password, and ffmpeg's single decode is the only layer — percent-encode it.
 *
 * (WARP-1873 prescribed leaving RFC 3986 sub-delims literal and encoding the rest
 * on the theory that "ffmpeg does not decode userinfo". It does, once; that fix
 * only ever worked for `!`.) A RAW password cannot contain braces (Frigate runs
 * `str.format` over its config, so `{FRIGATE_*}` is a placeholder and a lone
 * brace stops it starting) or whitespace (the regex's `\S+` stops there).
 */

/** RTSP/ONVIF account names are short; the caps bound what is hashed/sent downstream. */
export const MAX_CAMERA_USERNAME = 128;
export const MAX_CAMERA_PASSWORD = 256;

/** Frigate's REGEX_RTSP_CAMERA_USER_PASS username class. */
const FRIGATE_USERNAME = /^[A-Za-z0-9_-]+$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
/** Never legal in a RAW password: braces (Frigate str.format), whitespace (its \S+), controls. */
const RAW_UNSAFE = /[{}\s\x00-\x1f\x7f]/;

export type CredentialCode = "invalid_credentials" | "unsupported_password" | "unsupported_stream_address";

export type CredentialValidation = { ok: true } | { ok: false; error: string; code: CredentialCode };

/**
 * A credential that cannot be written into a Frigate stream URL. `field` names
 * what is wrong; the message never contains the value (NET-05).
 */
export class UnsafeCredentialsError extends Error {
  constructor(
    readonly field: "username" | "password" | "address",
    readonly code: CredentialCode,
    message: string,
  ) {
    super(message);
    this.name = "UnsafeCredentialsError";
  }
}

function checkEncodable(field: "username" | "password", value: string): void {
  // A lone surrogate is legal in a JSON string and in a JS string, but is not
  // UTF-8: encodeURIComponent throws on it, and so would the request encoding
  // downstream. Refuse it here as a 400, not there as a 500.
  if (LONE_SURROGATE.test(value) || CONTROL.test(value)) {
    throw new UnsafeCredentialsError(field, "invalid_credentials", `${field} contains invalid characters`);
  }
}

/** Python `quote(value, safe="")`: everything but the RFC 3986 unreserved set is %XX. */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

/** Python `urllib.parse.quote_plus` — what Frigate does to the password. Used only to detect a rewrite. */
function quotePlus(value: string): string {
  return percentEncode(value).replace(/%20/g, "+");
}

/**
 * The `user:password` text Frigate's config must hold for this account. Throws
 * UnsafeCredentialsError when the account cannot be expressed.
 */
export function frigateUserinfo(username: string, password: string): string {
  checkEncodable("username", username);
  checkEncodable("password", password);
  if (username.includes(":")) {
    // ffmpeg decodes the userinfo and THEN splits at the first ':'.
    throw new UnsafeCredentialsError("username", "invalid_credentials", "username cannot contain a colon");
  }
  if (FRIGATE_USERNAME.test(username)) {
    if (RAW_UNSAFE.test(password)) {
      throw new UnsafeCredentialsError(
        "password",
        "unsupported_password",
        "password cannot contain spaces or curly braces for this camera account",
      );
    }
    return `${username}:${password}`;
  }
  return `${percentEncode(username)}:${percentEncode(password)}`;
}

/**
 * Check an optional `{ username, password }` pair.
 *
 * Control characters are refused: the values are written into an RTSP
 * `Authorization` header downstream, and a CR/LF would let a caller inject
 * headers. Errors name the FIELD only — never the value (NET-05). The account
 * must also be expressible in a Frigate stream URL — checked here, before a
 * single sign-in is spent on the camera.
 */
export function validateCameraCredentials(username: unknown, password: unknown): CredentialValidation {
  const fail = (error: string, code: CredentialCode = "invalid_credentials"): CredentialValidation => ({
    ok: false,
    error,
    code,
  });
  if (username !== undefined && username !== null && typeof username !== "string") {
    return fail("username must be a string");
  }
  if (password !== undefined && password !== null && typeof password !== "string") {
    return fail("password must be a string");
  }
  const user = typeof username === "string" ? username : "";
  const pw = typeof password === "string" ? password : "";
  // "" is a blank form field (nothing given); "   " is a username that is not one.
  if (user !== "" && user.trim() === "") return fail("username must not be blank");
  if (pw && !user) return fail("username is required when a password is given");
  if (user.length > MAX_CAMERA_USERNAME) return fail("username is too long");
  if (pw.length > MAX_CAMERA_PASSWORD) return fail("password is too long");
  if (!user) return { ok: true };
  try {
    frigateUserinfo(user, pw);
  } catch (err) {
    if (err instanceof UnsafeCredentialsError) return fail(err.message, err.code);
    throw err;
  }
  return { ok: true };
}

/**
 * Merge `username`/`password` into `rtspUrl`, replacing any userinfo already
 * there, in the form Frigate needs (see the header). With no username the URL is
 * returned untouched. The authority is located with a linear scan rather than
 * `new URL()` because `rtsp:` is not a WHATWG special scheme and a parser would
 * risk normalising the vendor-specific path.
 *
 * Parse the HOST from `rtspUrl` BEFORE calling this: a raw password may hold
 * `/`, `?`, `#` or `@`, so the merged string is not a URL any parser will read
 * the same way. Throws UnsafeCredentialsError for an account it cannot store;
 * validate first (validateCameraCredentials) to answer with a 400 instead.
 */
export function embedRtspCredentials(
  rtspUrl: string,
  username: string | undefined | null,
  password: string | undefined | null,
): string {
  if (!username) return rtspUrl;
  const scheme = /^rtsps?:\/\//i.exec(rtspUrl)?.[0];
  if (!scheme || /[\r\n\u2028\u2029]/.test(rtspUrl)) return rtspUrl;
  let authorityEnd = rtspUrl.length;
  for (const separator of ["/", "?", "#"]) {
    const position = rtspUrl.indexOf(separator, scheme.length);
    if (position !== -1) authorityEnd = Math.min(authorityEnd, position);
  }
  const at = rtspUrl.lastIndexOf("@", authorityEnd - 1);
  const pw = password ?? "";
  const userinfo = frigateUserinfo(username, pw);
  const rest = rtspUrl.slice(at >= scheme.length ? at + 1 : scheme.length);
  if (FRIGATE_USERNAME.test(username) && rest.includes("@")) {
    throw new UnsafeCredentialsError(
      "address",
      "unsupported_stream_address",
      "stream address cannot contain an at sign for this camera account",
    );
  }
  const stored = `${scheme}${userinfo}@${rest}`;
  const escapedPw = quotePlus(pw);
  if (FRIGATE_USERNAME.test(username) && pw && escapedPw !== pw &&
      stored.split(pw).join(escapedPw) !== `${scheme}${username}:${escapedPw}@${rest}`) {
    // Frigate does path.replace(pw, quote_plus(pw)) over the WHOLE string, so a
    // password occurrence outside its field (even across the field boundary)
    // would change the username, scheme or camera address too.
    throw new UnsafeCredentialsError(
      "password",
      "unsupported_password",
      "password cannot also appear elsewhere in the camera's stream URL",
    );
  }
  return stored;
}

/**
 * Remove `user:password@` from any RTSP URL in `text` (for logs and errors).
 * Frigate echoes the config path in some of its error replies, and that path
 * carries the camera's password. Greedy to the last `@` of the whitespace-
 * delimited token — the reading Frigate and ffmpeg take — so a password holding
 * `@` or `/` is removed whole.
 */
export function scrubUrlCredentials(text: string): string {
  return text.replace(/\S+/g, (token) => {
    const scheme = /rtsps?:\/\//i.exec(token);
    if (!scheme) return token;
    const start = scheme.index + scheme[0].length;
    const at = token.lastIndexOf("@");
    return at >= start ? `${token.slice(0, start)}***@${token.slice(at + 1)}` : token;
  });
}
