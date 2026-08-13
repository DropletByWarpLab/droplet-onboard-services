/**
 * WARP-1905 — surface a video call's passcode on Agenda rows.
 *
 * The data model stores only `meetingUrl` (WARP-1874) — there is no
 * passcode column. Some providers embed the passcode in the join URL
 * itself, and members joining from a second device (room TV, phone
 * dial-in) need it as text they can copy, not just as an href. This
 * helper reads it back out of the already-validated link. Display-only:
 * the raw URL stays the href, and nothing here decides admission —
 * `parseMeetingLink` did that.
 */
import type { MeetingLink } from "@droplet/shared-types";

/** Param names any provider may use. Order is the display priority. */
const GENERIC_PARAMS = ["pwd", "passcode", "password"];

/**
 * The URL-embedded passcode of a parsed meeting link, or `null` when it
 * carries none. `p` is only read on a recognized Teams link
 * (`teams.live.com/meet/<id>?p=...`) — outside that shape a bare `p` is
 * far too generic to badge as a passcode.
 */
export function meetingPasscode(link: MeetingLink): string | null {
  // `link.url` is `parseMeetingLink`'s own normalized href, so it always
  // re-parses.
  const params = new URL(link.url).searchParams;
  const names = link.provider === "teams" ? [...GENERIC_PARAMS, "p"] : GENERIC_PARAMS;
  for (const name of names) {
    const value = params.get(name)?.trim();
    if (value) return value;
  }
  return null;
}
