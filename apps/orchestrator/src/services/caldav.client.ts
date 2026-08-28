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
 */

import { parseIcs, type IcsEvent } from "./ics.js";

export interface FetchOptions {
  url: string;
  authMode: "none" | "basic";
  username?: string | null;
  password?: string | null;
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

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
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
    const resp = await fetchWithTimeout(opts.url, { method: "GET", headers });
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
