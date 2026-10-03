import type { IncomingHttpHeaders } from "node:http";

/**
 * WARP-582 — browser-context detection for the `?return=body` token escape
 * hatch (POST /auth/login and the passkey issueSession twin in webauthn.ts).
 *
 * `?return=body` exists for NATIVE clients only: droplet-android (OkHttp) and
 * droplet-ios (URLSession) can't reliably read httpOnly Set-Cookie headers, so
 * ADR-008 §3 lets them opt into receiving the JWT pair in the JSON body. The
 * native Windows client (C#/WinUI 3, HttpClient) uses it too, for password
 * sign-in, and the native SSO handoff's `/sso/oidc/native/token`
 * applies the same gate. (The earlier Tauri shell ran the dashboard's cookie
 * login inside WebView2 and never used it.)
 *
 * On a BROWSER, tokens in the response body defeat the httpOnly-cookie
 * posture: any XSS payload that can drive a fetch could read them, where the
 * cookies themselves are unreadable by script. So a browser context must
 * never receive tokens in the body.
 *
 * Detection: browsers unconditionally attach at least one of the markers
 * below to every request they originate —
 *   • `Sec-Fetch-Site` / `Sec-Fetch-Mode` / `Sec-Fetch-Dest` are FORBIDDEN
 *     header names (Fetch spec §forbidden-header-name): page script can
 *     neither set nor strip them, and every evergreen engine (Chromium 76+,
 *     Firefox 90+, Safari 16.4+ — including WebView2/WKWebView shells) sends
 *     them on all requests.
 *   • `Origin` is likewise forbidden and attached by browsers to every POST
 *     (same- and cross-origin), which covers pre-Sec-Fetch engines.
 *   • `Referer` is a belt-and-braces third signal (sent by default unless a
 *     restrictive Referrer-Policy suppresses it).
 *
 * The native HTTP stacks the clients use (OkHttp, URLSession, .NET
 * HttpClient) send NONE of these unless the app author explicitly adds them,
 * so the gate is invisible to every legitimate `?return=body` caller. This is the
 * least-breaking gate that genuinely blocks browsers: an in-browser call
 * cannot remove the forbidden headers, and a native client would have to go
 * out of its way to trip it.
 */
const BROWSER_MARKER_HEADERS = [
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "origin",
  "referer",
] as const;

/**
 * The first browser-marker header present on the request, or null when none
 * are (a native/non-browser client). Exported separately from the boolean so
 * callers can log WHICH marker tripped the gate.
 */
export function browserMarkerHeader(headers: IncomingHttpHeaders): string | null {
  for (const name of BROWSER_MARKER_HEADERS) {
    if (headers[name] !== undefined) return name;
  }
  return null;
}

/** True when the request carries any browser-only marker header. */
export function isBrowserRequest(headers: IncomingHttpHeaders): boolean {
  return browserMarkerHeader(headers) !== null;
}
