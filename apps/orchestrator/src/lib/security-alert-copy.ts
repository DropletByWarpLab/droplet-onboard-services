/**
 * WARP-2978 (ADR-059 P3 spec §6.7, D27) — the words of a Security alert, pure.
 *
 * The notifier calls this once PER RECIPIENT with that recipient's VISIBLE
 * alert evidence only: an alert (or its "N more times") about a camera they
 * cannot see would reveal presence there (DS-005). The copy:
 *   · title `Person in <area> after hours`;
 *   · body `<camera> saw someone at <site clock>. The site was closed | set to
 *     away.` plus `It happened N more times.` when there is more visible
 *     evidence; the earliest sighting leads;
 *   · the clock is the site's zone (else a valid Workspace.tz — the caller
 *     picks); with neither, the time is left out. Never UTC (P2b's rule);
 *   · never names a person, and never says monitor / alarm / armed / secure /
 *     protected / guard / zone (the dashboard copy lint's BANNED list, run over
 *     every template by the test).
 * Area and camera names are person-controlled: made display-safe here.
 *
 * WARP-2979 (p4-spec §6.7.2) — camera_offline_during_activity has its own
 * words: title `A camera in <area> stopped reporting after hours`; body
 * `<camera> stopped reporting at <site clock>, soon after someone was seen in
 * <area>. The site was closed | set to away.` A person sighting leads when the
 * recipient can see one (the P3 words, counting sightings only); otherwise the
 * earliest dropped camera does. The caller has already applied
 * `reasonVisibleTo`, so the recipient may see where the person was seen.
 */
import { siteClockCopy } from "./security-hours.js";
import { stripUnsafeDisplayChars } from "../services/security-audit.js";

/** One visible alert reason, as the recipient may know it. */
export interface AlertEvidence {
  /** WARP-2979 — which rule; absent = after_hours_presence (P3's only alert). */
  code?: "after_hours_presence" | "camera_offline_during_activity";
  /** The camera's display name (Camera.displayName, else its Frigate name). */
  cameraLabel: string;
  at: Date;
  /** The reason's `detail.mode`: why it counted. */
  mode: "closed" | "away" | string;
  /** camera_offline_during_activity: when the person was seen (`detail.activity.at`). */
  seenAt?: Date | null;
  /** camera_offline_during_activity: the camera that saw them (the related camera's display name). */
  seenCameraLabel?: string | null;
}

const MODE_WORDS: Readonly<Record<string, string>> = { closed: "closed", away: "set to away" };

function safe(s: string, fallback: string): string {
  const cleaned = stripUnsafeDisplayChars(s).replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : fallback;
}

export function alertCopy(input: { zoneName: string; evidence: readonly AlertEvidence[]; tz: string | null }): {
  title: string;
  body: string;
} {
  if (input.evidence.length === 0) throw new Error("alertCopy: no visible evidence — the recipient must be skipped, not told");
  const area = safe(input.zoneName, "an area");
  const sightings = input.evidence.filter((e) => (e.code ?? "after_hours_presence") === "after_hours_presence");
  const pick = sightings.length > 0 ? sightings : input.evidence;
  const sorted = [...pick].sort((a, b) => a.at.getTime() - b.at.getTime());
  const lead = sorted[0]!;
  const camera = safe(lead.cameraLabel, "A camera");
  const when = input.tz ? ` at ${siteClockCopy(lead.at, input.tz)}` : "";
  const more = sorted.length - 1;
  const tail = more > 0 ? ` It happened ${more} more ${more === 1 ? "time" : "times"}.` : "";
  const site = `The site was ${MODE_WORDS[lead.mode] ?? "closed"}.`;
  if (sightings.length === 0) {
    return {
      title: `A camera in ${area} stopped reporting after hours`,
      body: `${camera} stopped reporting${when}, soon after someone was seen in ${area}. ${site}${tail}`,
    };
  }
  return {
    title: `Person in ${area} after hours`,
    body: `${camera} saw someone${when}. ${site}${tail}`,
  };
}
