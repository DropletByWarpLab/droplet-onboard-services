/**
 * CodeQL js/double-escaping — the `<calendar-data>` entity decode has to be
 * a single pass. A chain of replaces that turns `&amp;` into `&` before
 * `&quot;` re-exposes a server-escaped `&amp;quot;` as `&quot;`, and the
 * next step decodes it to `"` — a literal `&quot;` in a DESCRIPTION could
 * never round-trip. Exercised through the PROPFIND branch against a
 * stubbed global fetch.
 *
 * WARP-2022 — the SSRF half. Every rejection case below asserts on the FETCH
 * SPY, not just on the returned error: "it threw the right message" would
 * still pass if the request had already gone out. Zero calls is the property
 * that matters, so zero calls is what is asserted.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// The guard resolves hostnames, so every test that expects a request to be
// ALLOWED needs a resolver answer. Default: a public address, overridden
// per-test where the point is that the name resolves somewhere private.
const lookup = vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookup(...args),
  default: { lookup: (...args: unknown[]) => lookup(...args) },
}));

import { syncCalendarSource, fetchIcsFeed } from "./caldav.client.js";
import { BLOCKED_DESTINATION_MESSAGE } from "../lib/outbound-url-guard.js";

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function propfindResponse(icsLines: string[]): Response {
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/calendars/alice/personal/1.ics</d:href>
    <d:propstat>
      <d:prop>
        <d:getetag>"etag-1"</d:getetag>
        <cal:calendar-data>${icsLines.join("\r\n")}</cal:calendar-data>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;
  return new Response(xml, {
    status: 207,
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
}

async function syncWith(icsLines: string[]) {
  vi.stubGlobal("fetch", vi.fn(async () => propfindResponse(icsLines)));
  return syncCalendarSource({
    // No `.ics` / `/feeds/` / `subcal/` in the URL, so the CalDAV PROPFIND
    // branch (the one that decodes the XML) is the one exercised.
    url: "https://dav.example.test/calendars/alice/personal/",
    authMode: "none",
  });
}

describe("syncCalendarSource — <calendar-data> entity decode", () => {
  it("decodes the entities a CalDAV server emits: &lt; &gt; &amp; &quot;", async () => {
    const result = await syncWith([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:ev-1",
      "SUMMARY:&quot;Q&quot; &amp; &lt;A&gt;",
      "DTSTART:20260901T090000Z",
      "DTEND:20260901T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].summary).toBe('"Q" & <A>');
  });

  it("decodes each entity exactly once — an escaped `&amp;quot;` stays a literal `&quot;`", async () => {
    // The stored DESCRIPTION is:  Tom & Jerry &quot;quoted&quot; <b> a, b; c\d⏎line
    // On the wire the server XML-escapes it (& → &amp;, so the literal
    // `&quot;` becomes `&amp;quot;`) while the RFC 5545 TEXT escapes
    // (\, \; \\ \n) pass through XML untouched for parseIcs to unescape.
    const result = await syncWith([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:ev-2",
      "SUMMARY:R&amp;D",
      "DESCRIPTION:Tom &amp; Jerry &amp;quot;quoted&amp;quot; &lt;b&gt; a\\, b\; c\\\\d\\nline",
      "DTSTART:20260901T090000Z",
      "DTEND:20260901T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].summary).toBe("R&D");
    expect(result.events[0].description).toBe(
      'Tom & Jerry &quot;quoted&quot; <b> a, b; c\\d\nline',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WARP-2022 — SSRF guard
// ─────────────────────────────────────────────────────────────────────────────

/** A fetch that must never be reached. Any call is the defect. */
function sentinelFetch() {
  const spy = vi.fn(async () => new Response("SHOULD NEVER BE REACHED", { status: 200 }));
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** Destinations that must be refused BEFORE a socket is opened, one row per
 *  rule. Table-driven on purpose: a rule dropped from the guard turns exactly
 *  one row red and names itself while doing it. */
const BLOCKED_URLS: ReadonlyArray<{ rule: string; url: string }> = [
  { rule: "loopback v4", url: "http://127.0.0.1:8080/dav/" },
  { rule: "loopback v6", url: "http://[::1]/dav/" },
  { rule: "RFC1918", url: "http://192.168.1.1/dav/" },
  { rule: "RFC1918 (10/8)", url: "http://10.0.0.5/dav/" },
  { rule: "link-local / cloud metadata", url: "http://169.254.169.254/latest/meta-data/" },
  { rule: "CGNAT", url: "http://100.64.0.1/dav/" },
  { rule: ".local name", url: "http://box.local/dav/" },
  { rule: "non-http scheme (ftp)", url: "ftp://h/x" },
  { rule: "non-http scheme (file)", url: "file:///etc/passwd" },
  { rule: "userinfo in the authority", url: "http://u:p@dav.example.test/dav/" },
];

describe("WARP-2022 — blocked destinations never open a socket (PROPFIND verb)", () => {
  it.each(BLOCKED_URLS)("refuses $rule without fetching", async ({ url }) => {
    const spy = sentinelFetch();
    const result = await syncCalendarSource({ url, authMode: "none" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    // THE assertion. Everything else is commentary.
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("WARP-2022 — blocked destinations never open a socket (GET/ICS verb)", () => {
  // Same table through the OTHER verb. The `.ics` suffix makes
  // syncCalendarSource short-circuit to fetchIcsFeed, so this proves the
  // guard is in fetchWithTimeout (shared) rather than on one branch.
  it.each(BLOCKED_URLS)("refuses $rule without fetching", async ({ url }) => {
    const spy = sentinelFetch();
    const result = await fetchIcsFeed({ url, authMode: "none" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses a blocked .ics URL routed through syncCalendarSource's short-circuit", async () => {
    const spy = sentinelFetch();
    const result = await syncCalendarSource({
      url: "http://192.168.1.1/calendar.ics",
      authMode: "none",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("WARP-2022 — DNS re-check on the fetch path", () => {
  it("refuses a public hostname that resolves into private space", async () => {
    lookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    const spy = sentinelFetch();
    const result = await fetchIcsFeed({
      url: "https://rebind.example.test/cal.ics",
      authMode: "none",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    expect(spy).not.toHaveBeenCalled();
  });

  it("fails closed when the name does not resolve", async () => {
    lookup.mockRejectedValue(new Error("ENOTFOUND"));
    const spy = sentinelFetch();
    const result = await fetchIcsFeed({
      url: "https://nx.example.test/cal.ics",
      authMode: "none",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("WARP-2022 — redirects are re-validated, not followed blindly", () => {
  it("refuses a 302 into private space and never dials the second hop", async () => {
    const spy = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://10.0.0.5/internal" },
      }),
    );
    vi.stubGlobal("fetch", spy);

    const result = await fetchIcsFeed({
      url: "https://public.example.test/cal.ics",
      authMode: "none",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    // Exactly ONE call: the vetted first hop. The redirect target was
    // refused by the guard, so the second hop never happened.
    expect(spy).toHaveBeenCalledTimes(1);
    // MUTATION GUARD: with `redirect: "follow"` undici resolves the hop
    // itself, inside the socket, where no guard can see it.
    const init = spy.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("manual");
  });

  it("follows a redirect that stays public, re-validating each hop", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example.test/real.ics" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:r-1\r\nSUMMARY:Moved\r\n" +
            "DTSTART:20260901T090000Z\r\nDTEND:20260901T100000Z\r\n" +
            "END:VEVENT\r\nEND:VCALENDAR",
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", spy);

    const result = await fetchIcsFeed({
      url: "https://public.example.test/cal.ics",
      authMode: "none",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0]).toBe("https://cdn.example.test/real.ics");
  });

  it("stops after a bounded number of hops rather than looping forever", async () => {
    const spy = vi.fn(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://loop.example.test/next" },
      }),
    );
    vi.stubGlobal("fetch", spy);

    const result = await fetchIcsFeed({
      url: "https://loop.example.test/cal.ics",
      authMode: "none",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    // Bounded — the exact ceiling is an implementation choice, the property
    // is that it is small and finite.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("never carries basic-auth credentials to a host the user did not name", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example.test/steal" },
        }),
      )
      .mockResolvedValueOnce(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    await fetchIcsFeed({
      url: "https://dav.example.test/cal.ics",
      authMode: "basic",
      username: "alice",
      password: "hunter2",
    });

    const firstHeaders = (spy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    const secondHeaders = (spy.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    // The host the user actually named gets the credential …
    expect(firstHeaders.Authorization).toMatch(/^Basic /);
    // … and the cross-origin hop does not.
    expect(secondHeaders.Authorization).toBeUndefined();
  });

  it("keeps credentials across a SAME-origin redirect", async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 301,
          headers: { location: "/moved/cal.ics" },
        }),
      )
      .mockResolvedValueOnce(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR", { status: 200 }));
    vi.stubGlobal("fetch", spy);

    await fetchIcsFeed({
      url: "https://dav.example.test/cal.ics",
      authMode: "basic",
      username: "alice",
      password: "hunter2",
    });

    const secondHeaders = (spy.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(secondHeaders.Authorization).toMatch(/^Basic /);
    expect(spy.mock.calls[1][0]).toBe("https://dav.example.test/moved/cal.ics");
  });
});

describe("WARP-2022 — no probe oracle", () => {
  it("a refused destination reveals nothing about what is behind it", async () => {
    const spy = sentinelFetch();
    const result = await fetchIcsFeed({
      url: "http://127.0.0.1:9200/_cluster/health",
      authMode: "none",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // MUTATION GUARD: passing the guard's detail (or an upstream status)
    // through turns this red. The caller learns only "refused".
    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    expect(result.error).not.toMatch(/127\.0\.0\.1|9200|HTTP \d{3}|elastic/i);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("WARP-2022 — allowPrivateHost escape hatch", () => {
  it("lets an explicitly-flagged source reach a LAN CalDAV server", async () => {
    const spy = vi.fn(async () => propfindResponse([
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:lan-1",
      "SUMMARY:Standup",
      "DTSTART:20260901T090000Z",
      "DTEND:20260901T093000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ]));
    vi.stubGlobal("fetch", spy);

    const result = await syncCalendarSource({
      url: "http://192.168.1.50/dav/alice/",
      authMode: "none",
      allowPrivateHost: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // MUTATION GUARD: if the flag is ever allowed to skip the SCHEME check the
  // orchestrator becomes a file reader for anyone who can set it.
  it("still refuses file:// even with the flag set", async () => {
    const spy = sentinelFetch();
    const result = await fetchIcsFeed({
      url: "file:///etc/passwd",
      authMode: "none",
      allowPrivateHost: true,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(BLOCKED_DESTINATION_MESSAGE);
    expect(spy).not.toHaveBeenCalled();
  });

  it("defaults to refusing the LAN when the flag is absent", async () => {
    const spy = sentinelFetch();
    const result = await syncCalendarSource({
      url: "http://192.168.1.50/dav/alice/",
      authMode: "none",
    });
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
