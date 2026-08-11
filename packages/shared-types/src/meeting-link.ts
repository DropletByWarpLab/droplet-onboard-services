/**
 * WARP-1874 — video-call links on meetings and calendar events.
 *
 * A meeting link is authored by one household member and rendered as an
 * anchor to every other member of the thread, so this module is the single
 * gate that decides whether a string may become an `href`. It runs on the
 * write path (orchestrator zod schemas) AND again at render (the dashboard
 * cards), because rows can also arrive from an ICS sync or predate the
 * `meetingUrl` column.
 *
 * Two rules, in priority order:
 *
 *  1. `https:` ONLY. Never `javascript:`, `data:`, `vbscript:`, `blob:`,
 *     `file:`, `about:`, plain `http:`, or a provider app scheme like
 *     `zoommtg:`. The check reads the PARSED protocol, never the raw
 *     string — the WHATWG parser strips tabs and newlines inside a scheme,
 *     so `java\nscript:alert(1)` re-forms as `javascript:` and a regex over
 *     the input would miss it.
 *
 *  2. An unrecognized https URL is ACCEPTED with a generic label. Provider
 *     detection is cosmetic (a friendlier "Join Zoom" over "Join video
 *     call"); it is not an allowlist. Silently dropping a household's
 *     self-hosted Jitsi link would be a worse bug than the one this fixes.
 *
 * The parser returns its own normalized `href`. Callers store and render
 * THAT value, so nothing can be re-parsed differently between the moment
 * it was validated and the moment it becomes an attribute.
 */

/** Recognized for the friendly label only — never for admission. */
export type MeetingProvider = "zoom" | "teams" | "meet" | "webex" | "other";

export interface MeetingLink {
  /** Normalized absolute https URL — the exact string to store and render. */
  url: string;
  provider: MeetingProvider;
  /** Sentence-case action copy for the anchor, e.g. "Join Microsoft Teams". */
  label: string;
  /** Bare host, for a quiet secondary line next to the action. */
  host: string;
}

/** Longer than any real meeting URL; keeps a pathological string out of
 *  the database and out of the layout. */
export const MEETING_URL_MAX_LENGTH = 2048;

const PROVIDER_HOSTS: Array<{ provider: MeetingProvider; hosts: string[]; label: string }> = [
  { provider: "zoom", hosts: ["zoom.us", "zoomgov.com"], label: "Join Zoom" },
  {
    provider: "teams",
    hosts: ["teams.microsoft.com", "teams.live.com", "teams.microsoft.us"],
    label: "Join Microsoft Teams",
  },
  { provider: "meet", hosts: ["meet.google.com"], label: "Join Google Meet" },
  { provider: "webex", hosts: ["webex.com"], label: "Join Webex" },
];

const GENERIC_LABEL = "Join video call";

/**
 * Host equality or a subdomain of it — `warplab.zoom.us` matches `zoom.us`,
 * `zoom.us.evil.example` does not. Matching on `includes` would badge a
 * look-alike host with a trusted provider name, which is a phishing assist
 * rather than a cosmetic slip.
 */
function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * Parse a user-supplied string into a renderable meeting link, or `null`
 * if it must not become an href. Never throws.
 */
export function parseMeetingLink(raw: unknown): MeetingLink | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MEETING_URL_MAX_LENGTH) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  // The one admission rule. `URL` lower-cases the protocol, so this also
  // covers `JavaScript:`.
  if (parsed.protocol !== "https:") return null;
  // `https://` alone parses in some runtimes with an empty host — an
  // anchor to nowhere.
  if (!parsed.hostname) return null;
  if (parsed.href.length > MEETING_URL_MAX_LENGTH) return null;

  const host = parsed.hostname.toLowerCase();
  const match = PROVIDER_HOSTS.find((p) => p.hosts.some((h) => hostMatches(host, h)));

  return {
    url: parsed.href,
    provider: match?.provider ?? "other",
    label: match?.label ?? GENERIC_LABEL,
    host,
  };
}

/** Boolean shorthand for the same rule — for zod refinements and guards. */
export function isMeetingLink(raw: unknown): boolean {
  return parseMeetingLink(raw) !== null;
}
