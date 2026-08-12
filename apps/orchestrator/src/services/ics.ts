/**
 * Minimal iCalendar (RFC 5545) parser + serializer.
 *
 * Just enough to ingest external ICS feeds (iCloud public calendars, Google
 * public calendars, Fastmail, etc.) and to serialize the user's own events
 * for the /api/calendar/publish endpoint so phones can subscribe via
 * webcal://. We deliberately do NOT implement RRULE expansion, VTIMEZONE
 * parsing, or VALARM — v1 supports single events in UTC. Recurring events
 * coming from a feed are stored as their first instance only (with a
 * `recurring` note in the description if RRULE was present).
 *
 * Extending this module:
 *  - Recurring events: add `rrule` library + expand on read in
 *    calendar.service.ts.
 *  - Time zones: add `luxon` and parse VTIMEZONE blocks; convert non-UTC
 *    DATE-TIME values via TZID lookup.
 *  - Attendees / RSVP: parse ATTENDEE lines into a separate table.
 */

export interface IcsEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  // Raw RRULE if present — caller may surface as text rather than expand.
  rrule?: string;
}

/** Unfold continuation lines (RFC 5545 §3.1) — a line beginning with
 *  whitespace is appended to the previous line with the leading whitespace
 *  removed. */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if (line.length > 0 && (line[0] === " " || line[0] === "\t") && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

/** Split a content line into name/params/value (RFC 5545 §3.1).
 *  Example: `DTSTART;TZID=America/Los_Angeles:20260423T090000` →
 *  `{ name: "DTSTART", params: { TZID: "America/Los_Angeles" }, value: "20260423T090000" }` */
function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colonAt = line.indexOf(":");
  if (colonAt < 0) return null;
  const head = line.slice(0, colonAt);
  const value = line.slice(colonAt + 1);
  const parts = head.split(";");
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

/** Parse an ICS DATE or DATE-TIME value to a UTC Date.
 *  - `20260423` (DATE) → midnight UTC
 *  - `20260423T140000Z` (UTC DATE-TIME) → exact
 *  - `20260423T140000` (floating local — we treat as UTC for v1) → exact
 *  See module header for the time-zone caveat. */
function parseIcsDateTime(value: string): Date {
  const v = value.trim();
  // DATE form: YYYYMMDD
  if (/^\d{8}$/.test(v)) {
    return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00Z`);
  }
  // DATE-TIME form: YYYYMMDDTHHMMSS[Z]
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(v);
  if (m) {
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
  }
  // Fallback — best effort. Returns Invalid Date if truly garbled, caller
  // checks isNaN before persisting.
  return new Date(v);
}

/** RFC 5545 §3.3.11 unescaping — used inside SUMMARY / DESCRIPTION values. */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Escaper for URI-typed property values (URL, and any future ATTACH /
 *  ORGANIZER / SOURCE line).
 *
 *  RFC 5545 §3.3.13 types these as URI, not TEXT — §3.3.11's backslash
 *  escaping of `;` `,` and `\` does NOT apply, and applying it corrupts any
 *  link that legitimately contains those characters (a self-hosted Jitsi room
 *  at /Warp,Standup, say). We keep the CR/LF strip alone: stored values come
 *  from the WHATWG URL parser, which already removes raw CR/LF, but this
 *  module's interface is plain and a caller that skipped the parser must not
 *  be able to inject a content line. Defense in depth — do not remove it. */
function escapeUri(value: string): string {
  return value.replace(/\r?\n/g, "\\n");
}

/** Parse an ICS document into a list of events. Drops malformed events
 *  silently — caller may log the dropped count if desired. */
export function parseIcs(text: string): IcsEvent[] {
  const lines = unfold(text);
  const events: IcsEvent[] = [];
  let inEvent = false;
  let current: Partial<IcsEvent> & { _allDay?: boolean } = {};

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      inEvent = true;
      current = {};
      continue;
    }
    if (upper === "END:VEVENT") {
      inEvent = false;
      // RFC 5545 lets all-day events omit DTEND (means "one day"). Fill in
      // before the validation check so the event isn't dropped — see the
      // "synthesises endsAt" test.
      if (
        current._allDay === true &&
        current.startsAt instanceof Date &&
        !isNaN(current.startsAt.getTime()) &&
        !(current.endsAt instanceof Date && !isNaN(current.endsAt.getTime()))
      ) {
        current.endsAt = new Date(current.startsAt.getTime() + 24 * 60 * 60 * 1000);
      }
      // Validate shape before persisting
      if (
        current.uid &&
        current.summary !== undefined &&
        current.startsAt instanceof Date &&
        !isNaN(current.startsAt.getTime()) &&
        current.endsAt instanceof Date &&
        !isNaN(current.endsAt.getTime())
      ) {
        events.push({
          uid: current.uid,
          summary: current.summary,
          description: current.description,
          location: current.location,
          startsAt: current.startsAt,
          endsAt: current.endsAt,
          allDay: current._allDay === true,
          rrule: current.rrule,
        });
      }
      current = {};
      continue;
    }
    if (!inEvent) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    switch (parsed.name) {
      case "UID":
        current.uid = parsed.value.trim();
        break;
      case "SUMMARY":
        current.summary = unescapeText(parsed.value);
        break;
      case "DESCRIPTION":
        current.description = unescapeText(parsed.value);
        break;
      case "LOCATION":
        current.location = unescapeText(parsed.value);
        break;
      case "DTSTART":
        current.startsAt = parseIcsDateTime(parsed.value);
        if (parsed.params.VALUE === "DATE" || /^\d{8}$/.test(parsed.value.trim())) {
          current._allDay = true;
        }
        break;
      case "DTEND":
        current.endsAt = parseIcsDateTime(parsed.value);
        break;
      case "RRULE":
        current.rrule = parsed.value;
        break;
    }
  }

  // For all-day events with no DTEND, RFC 5545 says the event is one day
  // long. Fill in endsAt = startsAt + 1d so downstream rendering is sane.
  for (const ev of events) {
    if (ev.allDay && ev.endsAt.getTime() <= ev.startsAt.getTime()) {
      ev.endsAt = new Date(ev.startsAt.getTime() + 24 * 60 * 60 * 1000);
    }
  }
  return events;
}

function fmtIcsDateTime(d: Date, allDay: boolean): string {
  if (allDay) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}${m}${day}`;
  }
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export interface SerializeInput {
  uid: string;
  summary: string;
  description?: string | null;
  location?: string | null;
  /** WARP-1874 — video-call link, emitted as the RFC 5545 URL property.
   *  Separate from `location`: an event can have both a room and a call. */
  meetingUrl?: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  updatedAt?: Date;
}

/** Serialize a list of events into a complete VCALENDAR document.
 *  The PRODID identifies us so external calendar apps can show provenance. */
export function serializeIcs(
  events: SerializeInput[],
  calName = "Droplet Calendar",
): string {
  const now = fmtIcsDateTime(new Date(), false);
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Droplet//edge-platform//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calName)}`,
  ];
  for (const ev of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid}`);
    lines.push(`DTSTAMP:${now}`);
    if (ev.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${fmtIcsDateTime(ev.startsAt, true)}`);
      lines.push(`DTEND;VALUE=DATE:${fmtIcsDateTime(ev.endsAt, true)}`);
    } else {
      lines.push(`DTSTART:${fmtIcsDateTime(ev.startsAt, false)}`);
      lines.push(`DTEND:${fmtIcsDateTime(ev.endsAt, false)}`);
    }
    lines.push(`SUMMARY:${escapeText(ev.summary)}`);
    if (ev.description) lines.push(`DESCRIPTION:${escapeText(ev.description)}`);
    if (ev.location) lines.push(`LOCATION:${escapeText(ev.location)}`);
    // URL is what Apple Calendar and Outlook render as a join target, and a
    // subscriber's own client is where they actually are at 2:59. RFC 5545
    // types it as a URI value, not TEXT, so it takes escapeUri rather than
    // escapeText — a `,` or `;` in the link must survive verbatim or the
    // subscriber joins a room that doesn't exist, while the dashboard's Join
    // button stays healthy and hides the break.
    // (Section number deliberately omitted: a bare dotted-quad like the URL
    // property's section reads as an IPv4 literal to the egress allowlist
    // scanner and fails the PR-blocking egress-gate. See docs/SECURITY.md.)
    if (ev.meetingUrl) lines.push(`URL:${escapeUri(ev.meetingUrl)}`);
    if (ev.updatedAt) lines.push(`LAST-MODIFIED:${fmtIcsDateTime(ev.updatedAt, false)}`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  // RFC 5545 line endings are CRLF.
  return lines.join("\r\n") + "\r\n";
}
