/**
 * Minimal iCalendar (RFC 5545) parser + serializer.
 *
 * Just enough to ingest external ICS feeds (iCloud public calendars, Google
 * public calendars, Fastmail, etc.) and to serialize the user's own events
 * for the /api/calendar/publish endpoint so phones can subscribe via
 * webcal://. We deliberately do NOT implement RRULE expansion or VALARM
 * semantics. Recurring events coming from a feed are stored as their first
 * instance only, with no marker — `IcsEvent` carries the raw `rrule`, but
 * `calendar.service.ts` has no column to persist it into.
 *
 * Nested components (VALARM, and anything else opened with BEGIN: inside a
 * VEVENT) are SKIPPED, not merely unmodelled — see `parseIcs`. That
 * distinction is the whole of WARP-2763: failing to model a component and
 * failing to skip it are different things, and the second one silently
 * overwrites the parent event's own SUMMARY/DESCRIPTION/UID.
 *
 * TZID on DTSTART/DTEND IS honoured (WARP-2764), via `Intl.DateTimeFormat`
 * rather than a new dependency — see `zonedWallClockToUtc`, which implements
 * RFC 5545 §3.3.5 for both the repeated hour and the spring-forward gap.
 * Quoted and solidus-prefixed TZID spellings are normalized first
 * (`normalizeTzid`), so Thunderbird's `/mozilla.org/…/America/New_York` and a
 * DQUOTEd name both resolve.
 *
 * We still do not read VTIMEZONE blocks, so a TZID the runtime cannot resolve
 * yields an Invalid Date and the event is dropped by the shape check at
 * END:VEVENT. Two spellings land there: Exchange's Windows zone names, e.g.
 * `W. Europe Standard Time`, and the legal-but-empty `TZID=` (§3.2's
 * `paramtext` permits zero characters). Both name a zone we cannot resolve,
 * so both drop. Dropping is deliberate: the alternative is inventing an
 * instant, which is exactly the defect WARP-2764 fixed. Unresolvable-TZID is
 * still the ONLY drop class — and which values are unresolvable is decided by
 * the PRESENCE of the parameter, never by its truthiness.
 *
 * ⚠ Known gap, separate ticket: `parseLine` splits name from value on the
 * first `:`, so a quoted parameter that CONTAINS one — Exchange's
 * `TZID="(UTC+01:00) Amsterdam, Berlin"` — splits inside the quotes and
 * corrupts the value. Such a zone is unresolvable anyway, so today it lands in
 * the documented drop class rather than producing a wrong time.
 *
 * Extending this module:
 *  - Recurring events: add an `rrule` library + expand on read in
 *    calendar.service.ts. NOTE: `utils/rrule.ts`'s `nextFireFromRrule` is a
 *    next-fire advancer, NOT an expander — it ignores COUNT/UNTIL and rejects
 *    the bare `FREQ=WEEKLY;BYDAY=TU` Google emits. Do not reuse it here.
 *  - Windows zone names: vendor the CLDR windowsZones map, or read the
 *    STANDARD/DAYLIGHT offsets out of the VTIMEZONE the feed already ships.
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
function parseLine(
  line: string,
): { name: string; params: Record<string, string | undefined>; value: string } | null {
  const colonAt = line.indexOf(":");
  if (colonAt < 0) return null;
  const head = line.slice(0, colonAt);
  const value = line.slice(colonAt + 1);
  const parts = head.split(";");
  const name = parts[0].toUpperCase();
  // `string | undefined`, not `string`: a parameter that is ABSENT and one
  // present with an EMPTY value are different facts, and callers have to be
  // able to tell them apart. Typing this map as `Record<string, string>` let a
  // lookup that is `undefined` at runtime typecheck as a `string`, which is
  // what invited the truthiness test `parseIcsDateTime` used to run on TZID.
  const params: Record<string, string | undefined> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    // RFC 5545 §3.2: `param-value = paramtext / quoted-string`. The DQUOTEs are
    // delimiters, not data — a value that keeps them matches nothing downstream.
    // Generic on purpose: this is true of every parameter, not just TZID.
    if (eq > 0) {
      params[parts[i].slice(0, eq).toUpperCase()] = parts[i]
        .slice(eq + 1)
        .replace(/^"(.*)"$/, "$1");
    }
  }
  return { name, params, value };
}

/** The offset, in ms, that `tz` was running at the given instant —
 *  `utcInstant + offset === wall clock in tz`. Positive east of UTC.
 *
 *  Derived by formatting the instant *in* the zone and reading the wall-clock
 *  fields back, which is the only offset source available without a tz
 *  database dependency. Throws `RangeError` for a zone the runtime cannot
 *  resolve — callers must handle that rather than defaulting to UTC. */
/** One `Intl.DateTimeFormat` per zone, reused. Constructing a formatter is the
 *  expensive part, and resolving a feed costs several offset probes per event
 *  (two per DTSTART/DTEND, plus one per candidate) — a 500-event feed would
 *  otherwise build thousands of throwaway formatters on a box that is also
 *  running everything else. Keyed by zone; the set of zones a box ever sees is
 *  tiny and bounded by its subscriptions, so this never grows unboundedly. */
const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(tz: string): Intl.DateTimeFormat {
  const hit = zoneFormatters.get(tz);
  if (hit) return hit;
  // Throws RangeError for a zone the runtime cannot resolve — deliberately not
  // caught here, so callers keep the drop-rather-than-guess behaviour.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    // `hourCycle: h23` — `hour12: false` reports midnight as hour 24 on some
    // ICU builds, which would silently shift a midnight event by a day.
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  zoneFormatters.set(tz, fmt);
  return fmt;
}

function timeZoneOffsetMs(utcInstantMs: number, tz: string): number {
  const parts = zoneFormatter(tz).formatToParts(new Date(utcInstantMs));
  const field = (type: string): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : NaN;
  };
  const asIfUtc = Date.UTC(
    field("year"),
    field("month") - 1,
    field("day"),
    field("hour"),
    field("minute"),
    field("second"),
  );
  return asIfUtc - utcInstantMs;
}

/** Resolve a wall clock in a named IANA zone to the UTC instant it denotes.
 *  Returns an Invalid Date if `tz` is not resolvable by the runtime — never a
 *  UTC guess, because a plausible wrong instant is worse than a dropped event
 *  (WARP-2764).
 *
 *  RFC 5545 §3.3.5 specifies both awkward cases, and they need opposite
 *  treatment, which is why this is not a single subtraction:
 *
 *   - **Repeated** local time (autumn fall-back — the hour occurs twice):
 *     *"the DATE-TIME value refers to the first occurrence"*. So: the EARLIER
 *     of the two valid instants.
 *   - **Nonexistent** local time (spring-forward gap — the hour never occurs):
 *     *"interpreted using the UTC offset before the gap in local times"*. That
 *     is the pre-gap offset, which shifts the event forward past the gap — the
 *     same answer Temporal's `compatible`, luxon and java.time give.
 *
 *  Method: an instant denotes wall clock `w` in `tz` iff `instant +
 *  offset(instant) === w`. Probe the offset a day either side (a single probe
 *  at the wall clock cannot see both sides of a transition — in the ambiguous
 *  hour the second reading always agrees with the first), build a candidate per
 *  distinct offset, and keep only those that actually round-trip. Zero
 *  survivors means the wall clock is in a gap, and the pre-gap offset is the
 *  spec's answer. Two survivors is the repeated hour, and `Math.min` is "first
 *  occurrence".
 *
 *  🔴 Do not "simplify" this back to correct-once-and-return. That version
 *  resolved the gap BACKWARD (a 02:30 New York start became 01:30 EST, two
 *  hours early) and, in the three zones whose transition is at midnight
 *  (America/Santiago, America/Havana, Atlantic/Azores), moved a 00:00 event to
 *  the PREVIOUS CALENDAR DAY. It also returned the LATER occurrence of the
 *  repeated hour in every zone east of UTC — 73 of 130 DST zones — which is a
 *  §3.3.5 violation, not a defensible policy choice. */
function zonedWallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  tz: string,
): Date {
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const DAY_MS = 86_400_000;
  let offsetBefore: number;
  let offsetAfter: number;
  try {
    offsetBefore = timeZoneOffsetMs(wallAsUtc - DAY_MS, tz);
    offsetAfter = timeZoneOffsetMs(wallAsUtc + DAY_MS, tz);
  } catch {
    return new Date(NaN);
  }
  const valid = [...new Set([offsetBefore, offsetAfter])]
    .map((off) => wallAsUtc - off)
    .filter((instant) => timeZoneOffsetMs(instant, tz) === wallAsUtc - instant);
  // No candidate round-trips ⇒ the local time does not exist ⇒ §3.3.5's
  // "UTC offset before the gap".
  return new Date(valid.length > 0 ? Math.min(...valid) : wallAsUtc - offsetBefore);
}

/** Normalize a TZID parameter value to a zone `Intl` can resolve.
 *
 *  RFC 5545 §3.2.19 is `tzidparam = "TZID" "=" [tzidprefix] paramtext` with
 *  `tzidprefix = "/"` — a solidus marks a "globally unique" id. The registry
 *  that form anticipated was never created, so emitters put a vendor path in
 *  front of a plain IANA name: Thunderbird/Lightning ships
 *  `/mozilla.org/20070129_1/America/New_York`, libical
 *  `/softwarestudio.org/Tzfile/...`.
 *
 *  Longest resolvable suffix wins, so the 19 three-component zones survive
 *  (`America/Indiana/Knox`, `America/Argentina/Buenos_Aires`) — taking a fixed
 *  two trailing segments mangles those into non-zones.
 *
 *  This is not the "inventing an instant" WARP-2764 removed: a suffix is
 *  accepted only if it names a REAL zone the runtime resolves, and `undefined`
 *  (⇒ the caller drops the event) is returned when none does. Windows zone
 *  names still drop, exactly as the module header says. */
const normalizedTzids = new Map<string, string | undefined>();

function normalizeTzid(tzid: string): string | undefined {
  const cached = normalizedTzids.get(tzid);
  if (cached !== undefined || normalizedTzids.has(tzid)) return cached;
  const t = tzid.trim();
  const candidates: string[] = t ? [t] : [];
  if (t.startsWith("/")) {
    const segments = t.slice(1).split("/");
    for (let i = 0; i < segments.length; i++) candidates.push(segments.slice(i).join("/"));
  }
  let resolved: string | undefined;
  for (const candidate of candidates) {
    try {
      zoneFormatter(candidate);
      resolved = candidate;
      break;
    } catch {
      /* not a zone — try the next, shorter suffix */
    }
  }
  normalizedTzids.set(tzid, resolved);
  return resolved;
}

/** Parse an ICS DATE or DATE-TIME value to a UTC Date.
 *  - `20260423` (DATE) → midnight UTC
 *  - `20260423T140000Z` (UTC DATE-TIME) → exact
 *  - `20260423T090000` + `tzid` → resolved in that zone (WARP-2764)
 *  - `20260423T140000` with no tzid (genuinely floating) → treated as UTC
 *
 *  `tzid` comes from the property's own `TZID` parameter, and `undefined`
 *  means the parameter was ABSENT — the only genuinely floating case. It is a
 *  REQUIRED argument rather than an optional one so that every call site has
 *  to state which of the two it is passing. RFC 5545 §3.3.5 forbids TZID on a
 *  value that already carries `Z`, so an explicit `Z` wins and the parameter
 *  is ignored rather than double-applied. */
function parseIcsDateTime(value: string, tzid: string | undefined): Date {
  const v = value.trim();
  // DATE form: YYYYMMDD. TZID does not apply — a DATE has no time of day.
  if (/^\d{8}$/.test(v)) {
    return new Date(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T00:00:00Z`);
  }
  // DATE-TIME form: YYYYMMDDTHHMMSS[Z]
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (m) {
    const isUtc = m[7] === "Z";
    // PRESENCE, not truthiness. §3.2's `paramtext = *SAFE-CHAR` permits zero
    // characters, so `DTSTART;TZID=:20260423T090000` is legal and yields a
    // TZID whose value is "". That is a zone the emitter failed to NAME, not
    // the absence of a zone: the value is still a local wall clock. Testing
    // `tzid` for truthiness sends it to the floating branch below, which
    // stamps a Z on that wall clock — the WARP-2764 defect itself, alive again
    // for one input shape. Handing it to `normalizeTzid` instead resolves
    // nothing and drops the event, which is what an unresolvable zone gets.
    if (!isUtc && tzid !== undefined) {
      const zone = normalizeTzid(tzid);
      // Unresolvable zone ⇒ Invalid Date ⇒ the shape check at END:VEVENT drops
      // the event. Deliberate: see the module header.
      if (!zone) return new Date(NaN);
      return zonedWallClockToUtc(
        Number(m[1]),
        Number(m[2]),
        Number(m[3]),
        Number(m[4]),
        Number(m[5]),
        Number(m[6]),
        zone,
      );
    }
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
  /** Depth of components opened with BEGIN: *inside* the current VEVENT.
   *  While > 0 every line belongs to a nested component and must not reach
   *  the property switch (WARP-2763). Counted rather than name-matched so a
   *  component we have never heard of is inert by construction. */
  let nestedDepth = 0;
  let current: Partial<IcsEvent> & { _allDay?: boolean } = {};

  for (const line of lines) {
    const upper = line.trim().toUpperCase();
    if (upper === "BEGIN:VEVENT") {
      inEvent = true;
      nestedDepth = 0;
      current = {};
      continue;
    }
    if (upper === "END:VEVENT") {
      inEvent = false;
      nestedDepth = 0;
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
        !isNaN(current.endsAt.getTime()) &&
        // RFC 5545 §3.6.1: DTEND MUST be later than DTSTART. Belt and braces
        // behind the gap handling above — one end of an event can sit in a
        // spring-forward gap while the other does not, and shifting only that
        // end past the gap can cross the other. Nothing downstream would catch
        // it: syncSource upserts straight into Prisma and CalendarEvent has no
        // CHECK constraint, so an inverted row would be persisted and then
        // vanish from every hour-scale view and free/busy query.
        // `>=` not `>` — some exporters emit zero-length markers, and those are
        // harmless to an overlap query. All-day rows keep their own repair
        // path, which runs just above this check.
        (current._allDay === true ||
          current.endsAt.getTime() >= current.startsAt.getTime())
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
    // Inside a nested component (VALARM being the one every real exporter
    // emits): swallow every line, tracking depth so a nested-nested BEGIN:
    // cannot end the skip early. Without this the alarm's own DESCRIPTION /
    // SUMMARY / UID fall through to the switch below and overwrite the
    // parent event's — last write wins, and exporters put VALARM last.
    if (nestedDepth > 0) {
      if (upper.startsWith("BEGIN:")) nestedDepth++;
      else if (upper.startsWith("END:")) nestedDepth--;
      continue;
    }
    if (upper.startsWith("BEGIN:")) {
      nestedDepth = 1;
      continue;
    }
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
        current.startsAt = parseIcsDateTime(parsed.value, parsed.params.TZID);
        if (parsed.params.VALUE === "DATE" || /^\d{8}$/.test(parsed.value.trim())) {
          current._allDay = true;
        }
        break;
      case "DTEND":
        current.endsAt = parseIcsDateTime(parsed.value, parsed.params.TZID);
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
