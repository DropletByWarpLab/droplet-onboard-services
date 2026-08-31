/**
 * CalDAV / ICS subscription client.
 *
 * Two ingest modes, picked automatically based on the response:
 *   1. **ICS feed** — a plain HTTP(S) GET that returns text/calendar.
 *      Covers iCloud public links, Google "Secret address in iCal format",
 *      Fastmail public feeds, Office 365 published calendars.
 *   2. **CalDAV** — a true CalDAV server requires a PROPFIND/REPORT dance.
 *      For v1 we issue a PROPFIND with `<calendar-data/>` to get the events
 *      in one round trip. Works for Nextcloud, Radicale, Baikal, iCloud
 *      (with app password). Pure CalDAV servers that demand a REPORT with a
 *      time-range filter aren't supported here yet — the LLM will report
 *      `caldav_unsupported_server`.
 *
 * Auth:
 *   - `authMode: "none"` → no Authorization header. Use for public ICS.
 *   - `authMode: "basic"` → `Authorization: Basic base64(user:password)`.
 *
 * Failure mode: returns a structured `SyncResult` instead of throwing so the
 * scheduler can persist `lastSyncError` cleanly. Network errors, non-2xx
 * responses, and parse failures all produce `{ ok: false, error }`.
 *
 * Destination safety (WARP-2022): the URL is operator-supplied and this
 * process sits inside the box's trust boundary, so EVERY request goes
 * through `assertOutboundDestinationAllowed` first. The guard lives in
 * `fetchWithTimeout` rather than in each verb, so the GET path, the PROPFIND
 * path, every redirect hop and any verb added later are covered by
 * construction — there is no way to reach `fetch` from this module without
 * passing it. A refused destination surfaces the fixed
 * `blocked_destination` string and never an upstream status, so the sync
 * endpoint is not a port scanner.
 */

import { parseIcs, type IcsEvent } from "./ics.js";
import {
  assertOutboundDestinationAllowed,
  isOutboundUrlBlocked,
  OutboundUrlBlockedError,
} from "../lib/outbound-url-guard.js";

export interface FetchOptions {
  url: string;
  authMode: "none" | "basic";
  username?: string | null;
  password?: string | null;
  /**
   * WARP-2022 — owner/admin opt-in for a self-hosted CalDAV server on the
   * box's own LAN. Explicit per source (a `CalendarSource` column), never
   * inferred from the URL. Skips the private-range rules ONLY; the scheme
   * and userinfo rules still apply.
   */
  allowPrivateHost?: boolean;
}

export type SyncResult =
  | { ok: true; events: IcsEvent[] }
  | { ok: false; error: string };

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024; // 50 MB — pathological feeds rejected

/** The four entities a CalDAV server escapes inside `<calendar-data>` text.
 *  Decoded in ONE pass (CodeQL js/double-escaping): a chain of replaces
 *  that turns `&amp;` into `&` before `&quot;` re-exposes an escaped
 *  `&amp;quot;` as `&quot;` and the next step decodes it to `"` — a literal
 *  `&quot;` in a DESCRIPTION could never round-trip. */
const XML_ENTITY_RE = /&(lt|gt|amp|quot);/g;
const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"" };

function basicAuthHeader(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/** Redirects are followed by hand so each hop can be re-validated. Three is
 *  enough for the vendor patterns we see (an apex → www, plus a CDN hand-off)
 *  and small enough that a redirect loop is a prompt error, not a hang. */
const MAX_REDIRECT_HOPS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The ONLY door to `fetch` in this module — and therefore the only place the
 * SSRF guard has to be.
 *
 * `redirect: "manual"` is load-bearing, not a style choice. undici's default
 * `"follow"` resolves hops inside the socket, where no guard can see them:
 * a public URL that 302s to `http://169.254.169.254/` would be fetched with
 * the request already past every check. Following by hand means each hop is
 * re-parsed and re-vetted before it is dialled.
 *
 * The Authorization header is dropped on a cross-origin hop. The user
 * consented to send their CalDAV password to the host they typed; a redirect
 * is the remote end's choice, not theirs.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number; allowPrivateHost?: boolean },
): Promise<Response> {
  const { timeoutMs, allowPrivateHost, headers, ...rest } = init;
  const guardOptions = { allowPrivateHost: allowPrivateHost === true };

  let target = await assertOutboundDestinationAllowed(url, guardOptions);
  const vettedOrigin = target.origin;
  let outboundHeaders: Record<string, string> = {
    ...((headers as Record<string, string> | undefined) ?? {}),
  };

  for (let hop = 0; ; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? FETCH_TIMEOUT_MS);
    let resp: Response;
    try {
      // Dial the URL the guard vetted, not the raw string — validating one
      // parse and requesting a differently-parsed second one is the gap
      // that makes guards decorative.
      //
      // The headers are COPIED per hop rather than handed over by reference:
      // stripping Authorization below must not reach backwards and rewrite
      // what an earlier hop was sent. A shared object makes the strip
      // unobservable — to a test, and to anyone reading a captured request.
      resp = await fetch(target.toString(), {
        ...rest,
        headers: { ...outboundHeaders },
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const location = resp.headers.get("location");
    if (!REDIRECT_STATUSES.has(resp.status) || !location) return resp;
    if (hop >= MAX_REDIRECT_HOPS) {
      throw new OutboundUrlBlockedError("redirect", `more than ${MAX_REDIRECT_HOPS} hops`);
    }

    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new OutboundUrlBlockedError("redirect", "unparseable Location header");
    }
    target = await assertOutboundDestinationAllowed(next.toString(), guardOptions);
    // Cross-origin hop: drop the credential. Matched case-INSENSITIVELY —
    // HTTP header names are case-insensitive, so a caller that spelled it
    // `authorization` must not slip a password past this strip.
    if (target.origin !== vettedOrigin) {
      outboundHeaders = Object.fromEntries(
        Object.entries(outboundHeaders).filter(
          ([name]) => name.toLowerCase() !== "authorization",
        ),
      );
    }
  }
}

/** Read the response body with a hard byte cap so a runaway feed can't OOM
 *  the orchestrator. */
async function readBodyBounded(resp: Response): Promise<string> {
  const reader = resp.body?.getReader();
  if (!reader) return "";
  let total = 0;
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
        throw new Error("response too large (>50MB)");
      }
      out += decoder.decode(value, { stream: true });
    }
  }
  out += decoder.decode();
  return out;
}

/** GET an ICS feed and parse it. */
export async function fetchIcsFeed(opts: FetchOptions): Promise<SyncResult> {
  try {
    const headers: Record<string, string> = { Accept: "text/calendar, */*;q=0.1" };
    if (opts.authMode === "basic" && opts.username && opts.password) {
      headers.Authorization = basicAuthHeader(opts.username, opts.password);
    }
    const resp = await fetchWithTimeout(opts.url, {
      method: "GET",
      headers,
      allowPrivateHost: opts.allowPrivateHost,
    });
    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status} ${resp.statusText}` };
    }
    const text = await readBodyBounded(resp);
    const events = parseIcs(text);
    return { ok: true, events };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/** Try CalDAV PROPFIND first; if the server doesn't speak CalDAV, fall back
 *  to a plain GET. This covers both subscription URL types in one call. */
export async function syncCalendarSource(opts: FetchOptions): Promise<SyncResult> {
  // Quick heuristic: if the URL ends with .ics or contains "/feeds/", skip
  // PROPFIND and go straight to GET. iCloud/Google/Outlook subscription URLs
  // all match this pattern and PROPFIND on them returns 404/405.
  const url = opts.url.trim();
  if (/\.ics($|\?)/i.test(url) || url.includes("/feeds/") || url.includes("subcal/")) {
    return fetchIcsFeed(opts);
  }

  // Real CalDAV: PROPFIND with Depth: 1 returns one <response> per resource
  // inside the calendar collection, each with calendar-data embedded. We
  // strip the XML and concatenate the inner ICS for the parser.
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/xml",
      Depth: "1",
      Accept: "application/xml, text/calendar",
    };
    if (opts.authMode === "basic" && opts.username && opts.password) {
      headers.Authorization = basicAuthHeader(opts.username, opts.password);
    }
    const propfindBody = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
</d:propfind>`;
    const resp = await fetchWithTimeout(url, {
      method: "PROPFIND",
      headers,
      body: propfindBody,
      allowPrivateHost: opts.allowPrivateHost,
    });
    // 405 = method not allowed → server isn't CalDAV. 404 likely too.
    if (resp.status === 404 || resp.status === 405) {
      return fetchIcsFeed(opts);
    }
    if (!resp.ok && resp.status !== 207) {
      return { ok: false, error: `CalDAV PROPFIND ${resp.status} ${resp.statusText}` };
    }
    const xml = await readBodyBounded(resp);

    // Crude but adequate extraction of every <calendar-data>...</calendar-data>
    // block. A real XML parser would be more robust but pulls in a dep we
    // don't otherwise need; the format is well-controlled and CDATA-free in
    // practice (Sabre/DAV, Radicale, iCloud, Nextcloud all emit raw text).
    const blocks = xml.match(/<(?:[a-zA-Z0-9]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[a-zA-Z0-9]+:)?calendar-data>/g) ?? [];
    const allEvents: IcsEvent[] = [];
    for (const block of blocks) {
      const inner = block
        .replace(/^<(?:[a-zA-Z0-9]+:)?calendar-data[^>]*>/, "")
        .replace(/<\/(?:[a-zA-Z0-9]+:)?calendar-data>$/, "")
        .replace(XML_ENTITY_RE, (_m, name: string) => XML_ENTITIES[name] ?? _m);
      allEvents.push(...parseIcs(inner));
    }
    return { ok: true, events: allEvents };
  } catch (err) {
    // WARP-2022 — a refused destination is a POLICY decision, checked before
    // this branch's transport heuristics. Retrying it as a GET would just
    // re-run the same guard, and letting it reach the substring test below
    // would make the fallback depend on the refusal message not happening to
    // contain "abort" or "network".
    if (isOutboundUrlBlocked(err)) return { ok: false, error: err.message };
    const msg = err instanceof Error ? err.message : String(err);
    // Network / abort failures during PROPFIND — try the plain GET path
    // before giving up so a non-CalDAV server that doesn't accept the verb
    // still works.
    if (msg.toLowerCase().includes("abort") || msg.toLowerCase().includes("network")) {
      return fetchIcsFeed(opts);
    }
    return { ok: false, error: msg };
  }
}
