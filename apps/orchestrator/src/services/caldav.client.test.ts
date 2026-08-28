/**
 * CodeQL js/double-escaping — the `<calendar-data>` entity decode has to be
 * a single pass. A chain of replaces that turns `&amp;` into `&` before
 * `&quot;` re-exposes a server-escaped `&amp;quot;` as `&quot;`, and the
 * next step decodes it to `"` — a literal `&quot;` in a DESCRIPTION could
 * never round-trip. Exercised through the PROPFIND branch against a
 * stubbed global fetch.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { syncCalendarSource } from "./caldav.client.js";

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
