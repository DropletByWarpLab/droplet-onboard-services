/**
 * What Frigate and ffmpeg do to a camera's RTSP URL, as plain functions.
 *
 * Test support, not a test. WARP-3505: the password a camera finally receives is
 * the product of THREE parties, and every earlier test only looked at the first
 * (the URL we wrote):
 *
 * 1. Frigate 0.17 runs `escape_special_characters` (frigate/util/builtin.py)
 *    over each ffmpeg input path:
 *
 *        REGEX_RTSP_CAMERA_USER_PASS = r":\/\/[a-zA-Z0-9_-]+:[\S]+@"
 *        found = re.search(REGEX, path).group(0)[3:-1]
 *        pw = found[(found.index(":") + 1):]
 *        return path.replace(pw, urllib.parse.quote_plus(pw))
 *
 *    so for a username that regex matches Frigate percent-encodes the PASSWORD
 *    ITSELF; one that was already percent-encoded is encoded twice.
 * 2. ffmpeg splits the authority at its last `@`, URL-decodes `user:password`
 *    ONCE (`+` untouched), and splits that at the first `:`.
 * 3. The camera receives what ffmpeg computed.
 *
 * Mirrors services/camera-discovery/tests/frigate_emulator.py.
 */
import { expect } from "vitest";

/** Python's urllib.parse.quote_plus: all but [A-Za-z0-9_.~-] is %XX of its UTF-8 bytes; space is '+'. */
export function quotePlus(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(ch)) out += ch;
    else if (ch === " ") out += "+";
    else out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** frigate/util/builtin.py escape_special_characters, verbatim. */
export function frigateEscape(path: string): string {
  const match = /:\/\/[a-zA-Z0-9_-]+:[\S]+@/.exec(path);
  if (!match) return path; // path does not have user:pass
  const found = match[0].slice(3, -1);
  const pw = found.slice(found.indexOf(":") + 1);
  return path.split(pw).join(quotePlus(pw)); // str.replace replaces every occurrence
}

/** ffmpeg: authority ends at the first / ? #, userinfo at its LAST '@', decoded once, split at the first ':'. */
export function ffmpegCredentials(url: string): { user: string; password: string } {
  const rest = url.split("://")[1]!;
  const authority = rest.split(/[/?#]/)[0]!;
  const at = authority.lastIndexOf("@");
  expect(at, `no userinfo in ${url}`).toBeGreaterThan(-1);
  const bytes: number[] = [];
  const chars = Array.from(authority.slice(0, at)); // by code point, so an astral character stays whole
  for (let i = 0; i < chars.length; ) {
    const hex = chars.slice(i + 1, i + 3).join("");
    if (chars[i] === "%" && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 3;
    } else {
      bytes.push(...Buffer.from(chars[i]!, "utf8"));
      i += 1;
    }
  }
  const decoded = Buffer.from(bytes).toString("utf8");
  const colon = decoded.indexOf(":");
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** What the camera is sent for a path stored in Frigate's config. */
export const cameraReceives = (stored: string) => ffmpegCredentials(frigateEscape(stored));
