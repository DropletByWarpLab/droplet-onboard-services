/**
 * WARP-2804 — what an acking client SAID it was.
 *
 * An acknowledgement records two device facts (spec §A.2):
 *
 *   ackSessionId  the sign-in's id from the signed token; its live-session
 *                 check can be skipped when the session store is unreachable
 *                 (`ackSessionChecked` records whether it ran). Not this
 *                 module's business;
 *   ackClient     this module's output — REPORTED, never proof, and every
 *                 surface that shows it must say "the device said".
 *
 * Nothing on an API request binds it to a paired device (pairing mints a
 * Nextcloud app password; `PushSubscription.deviceClientId` is client-asserted),
 * so this is a label, not an identity. It is kept HONEST and SAFE TO DISPLAY:
 *
 *   1. A well-formed `X-Droplet-Client` header wins, e.g.
 *      `droplet-ios/1.4.0 (iOS 18.2)` — the native apps' contract (iOS sends
 *      it; no client code lands with WARP-2804).
 *   2. Otherwise a COARSE label from the User-Agent ("Safari on iPhone", "Edge
 *      on Windows") built from a fixed vocabulary — the raw User-Agent is never
 *      echoed, so a hostile one cannot put its own text on the ack.
 *   3. Otherwise NULL.
 *
 * The result has `stripUnsafeDisplayChars` applied (bidi overrides and control
 * characters reorder or corrupt whatever renders the ack) and is at most 120
 * code points (the column is VARCHAR(120)). Pure: shared with WARP-2978's
 * incident acknowledgement.
 */
import { stripUnsafeDisplayChars } from "../services/security-audit.js";

/** `ackClient` is VARCHAR(120); Postgres counts characters, i.e. code points. */
export const CLIENT_DESCRIPTOR_MAX = 120;

/**
 * `<product>/<version>` with an optional ` (<comment>)`. `u` so the comment's
 * 48 is 48 characters, not 48 UTF-16 units. CR/LF and nested parentheses are
 * refused outright; any other unsafe character is stripped afterwards.
 */
const X_DROPLET_CLIENT = /^[a-z0-9-]{1,32}\/[0-9A-Za-z.+-]{1,24}( \([^()\r\n]{1,48}\))?$/u;

/** Order matters: Edge and Opera also say `Chrome/`, Chrome also says `Safari/`. */
const BROWSERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\/|\bChromium\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

/** Order matters: iOS says `like Mac OS X`, Android says `Linux`. */
const PLATFORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMacintosh\b|\bMac OS X\b/, "Mac"],
  [/\bLinux\b/, "Linux"],
];

/** Stripped, then cut to {@link CLIENT_DESCRIPTOR_MAX} code points (never inside a surrogate pair). */
export function clampClientDescriptor(s: string): string {
  return Array.from(stripUnsafeDisplayChars(s)).slice(0, CLIENT_DESCRIPTOR_MAX).join("");
}

function fromHeader(header: string): string | null {
  if (!X_DROPLET_CLIENT.test(header)) return null;
  const cleaned = clampClientDescriptor(header);
  // A comment made only of stripped characters is no longer well-formed.
  return X_DROPLET_CLIENT.test(cleaned) ? cleaned : null;
}

function fromUserAgent(ua: string): string | null {
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  if (!browser) return null;
  const platform = PLATFORMS.find(([re]) => re.test(ua))?.[1];
  return clampClientDescriptor(platform ? `${browser} on ${platform}` : browser);
}

/**
 * The `ackClient` value for a request: `describeClient(req.get("user-agent"),
 * req.get("x-droplet-client"))`. Never throws; a non-string input (a header
 * repeated into an array) counts as absent.
 */
export function describeClient(userAgent?: string, xDropletClient?: string): string | null {
  if (typeof xDropletClient === "string") {
    const said = fromHeader(xDropletClient);
    if (said) return said;
  }
  if (typeof userAgent === "string") return fromUserAgent(userAgent);
  return null;
}
