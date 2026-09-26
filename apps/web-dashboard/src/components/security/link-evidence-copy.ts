/**
 * WARP-2979 (ADR-059 P4 §6.4, §8) — the words behind "Linked by Droplet" and
 * Droplet's suggestions: its evidence (the co-occurrence counts it decided
 * on) as sentences a person can check. Pure, and in components/security so
 * the copy lint scans every sentence it can produce.
 *
 *   · camera ↔ camera: "When Stock cam A saw someone (40 times in 14 days),
 *     Stock cam B also did within 10 seconds 34 times, and the other way round
 *     36 of 45 times. By chance you'd expect about 2 and 3."
 *   · lock → camera (P4 PR-4 writes these; the sentence is ready): "In the
 *     last 14 days the Back door lock turned 14 times. 12 of those times,
 *     someone was in the 'back_door' part of Back camera's view within 10
 *     seconds. By chance you'd expect about 0.2."
 *   · names — a tiebreak, never evidence, so BELOW the numbers: "The names
 *     match too: back door."
 *   · samples, only while they are kept (trimmed after 30 days): "Most
 *     recently: Tue 2:14 PM, Mon 9:02 AM."
 *   · provenance: "Droplet linked this on Sep 20 at 3:14 PM." / "Droplet
 *     suggested this on Sep 20."
 *
 * The box sends evidence only to a viewer who can see every source it names;
 * with none, the popover says "Droplet linked this from what its cameras
 * saw." Clock times are the site's zone (never UTC).
 */
import type { LinkEvidenceSource, LinkEvidenceView } from "@/lib/types";
import { fill } from "./TimezoneSelect";
import { formatSiteTime, formatSiteWhen } from "@/lib/security-time";

export const LINK_COPY = {
  cameraSentence:
    "When {anchor} saw someone ({n} times in {days} days), {candidate} also did within 10 seconds {k} times, and the other way round {rk} of {rn} times. By chance you'd expect about {lambda} and {rlambda}.",
  lockSentence:
    "In the last {days} days {anchor} turned {n} times. {k} of those times, someone was in {candidate} within 10 seconds. By chance you'd expect about {lambda}.",
  namesMatch: "The names match too: {shared}.",
  recently: "Most recently: {times}.",
  linkedOn: "Droplet linked this on {date} at {time}.",
  suggestedOn: "Droplet suggested this on {date}.",
  noEvidence: "Droplet linked this from what its cameras saw.",
  partOfView: "the '{part}' part of {camera}'s view",
  lockName: "the {lock} lock",
} as const;

/** How a source reads in a sentence: a camera by its name, a part of its view, or a lock. */
export function sourcePhrase(s: LinkEvidenceSource): string {
  if (s.sourceKind === "camera_zone") {
    const slash = s.sourceRef.indexOf("/");
    return fill(LINK_COPY.partOfView, { part: s.sourceRef.slice(slash + 1), camera: s.label });
  }
  if (s.sourceKind === "lock") return fill(LINK_COPY.lockName, { lock: s.label });
  return s.label;
}

/** "about 2", "about 0.2", "about 0" — what chance alone would give, from λ × 1000. */
export function aboutCount(lambdaMilli: number): string {
  const v = lambdaMilli / 1000;
  if (v >= 1) return String(Math.round(v));
  const tenth = Math.round(v * 10) / 10;
  return tenth === 0 ? "0" : String(tenth);
}

function windowDays(e: LinkEvidenceView): number {
  return Math.max(1, Math.round((Date.parse(e.window.to) - Date.parse(e.window.from)) / 86_400_000));
}

const firstUpper = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/**
 * The numbers first, then (only when the names match) the names line, then
 * (only while samples are kept) the most recent hits. Never the confidence
 * or the p-value raw.
 */
export function evidenceSentences(e: LinkEvidenceView, tz: string, now: Date): string[] {
  const days = String(windowDays(e));
  const out: string[] = [];
  if (e.kind === "camera_camera" && e.reverse) {
    out.push(
      fill(LINK_COPY.cameraSentence, {
        anchor: sourcePhrase(e.anchor),
        candidate: sourcePhrase(e.candidate),
        n: String(e.forward.n),
        k: String(e.forward.k),
        rn: String(e.reverse.n),
        rk: String(e.reverse.k),
        days,
        lambda: aboutCount(e.forward.lambdaMilli),
        rlambda: aboutCount(e.reverse.lambdaMilli),
      }),
    );
  } else {
    const lock = e.anchor.sourceKind === "lock" ? e.anchor : e.candidate;
    const camera = e.anchor.sourceKind === "lock" ? e.candidate : e.anchor;
    out.push(
      fill(LINK_COPY.lockSentence, {
        anchor: sourcePhrase(lock),
        candidate: sourcePhrase(camera),
        n: String(e.forward.n),
        k: String(e.forward.k),
        days,
        lambda: aboutCount(e.forward.lambdaMilli),
      }),
    );
  }
  if (e.names.match && e.names.shared.length > 0) out.push(fill(LINK_COPY.namesMatch, { shared: e.names.shared.join(" ") }));
  if (e.samples.length > 0) {
    out.push(fill(LINK_COPY.recently, { times: e.samples.map((s) => formatSiteWhen(s.anchorAt, tz, now)).join(", ") }));
  }
  return out.map(firstUpper);
}

/** "Sep 20" in the site zone. */
function siteDay(instant: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric" }).format(new Date(instant));
}

/** When Droplet linked it (its active link's state time) or suggested it (the evidence's time). */
export function provenanceLine(kind: "linked" | "suggested", at: string, tz: string): string {
  return kind === "linked"
    ? fill(LINK_COPY.linkedOn, { date: siteDay(at, tz), time: formatSiteTime(at, tz) })
    : fill(LINK_COPY.suggestedOn, { date: siteDay(at, tz) });
}
