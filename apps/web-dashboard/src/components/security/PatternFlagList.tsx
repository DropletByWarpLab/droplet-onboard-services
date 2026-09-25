"use client";

/**
 * WARP-2980 (ADR-059 P5 PR-C, spec §6.10, §6.13, §8) — the pattern flags on
 * the incident page: route 18's `patternFlags`, which the box sends apart
 * from the counted reasons (ReasonList). Neither kind counts: a flag never
 * set the incident's severity or state and never told anyone.
 *
 *   · TRIAL — Droplet would have flagged it, and is still trying these flags
 *     out: the name, a Trial chip and one plain sentence saying so;
 *   · kept quiet by EXPECTED ACTIVITY — the name struck through, then which
 *     expected activity and a link to it on Patterns (never silent, §6.10);
 *     one that has since ended or been removed says so.
 *
 * Never shown as counted: no severity tint whatever the would-be severity,
 * and a quietened flag never carries the Trial chip. The numbers behind a
 * flag ("seen on 0 of 20 weekdays at this hour") are worded only when the
 * box sent them as numbers; otherwise the evidence line alone (DS-005: a
 * number the viewer may not see is never filled in, and never guessed).
 *
 * Who sees what is the box's (flags reach owner/admin only) and the page's
 * (IncidentView drops a trial flag for anyone else). This renders exactly
 * what it is given, in the order it came: one block per kind of flag and
 * what happened to it, one evidence line per flag.
 */
import Link from "next/link";
import { Activity, CalendarCheck } from "lucide-react";
import { formatSiteWhen } from "@/lib/security-time";
import type { IncidentPatternFlagView } from "@/lib/types";
import { PATTERN_NAME, fillCopy, formatRate, formatVisit, hourRange, labelName } from "./patterns-copy";

export const FLAG_COPY = {
  trial: "Trial",
  trialNote: "Droplet would have flagged this. It's still trying these flags out.",
  expected: "Kept quiet by expected activity:",
  keptQuiet: "Kept quiet by expected activity.",
  sinceRemoved: "(since removed)",
  sinceEnded: "(since ended)",
  seeExpected: "See expected activity",
  seenOn: "seen on {d} of {n} {days} at this hour",
  weekdays: "weekdays",
  weekendDays: "weekend days",
  volume: "seen {k} times between {range} · usually about {rate}",
  dwell: "stayed {visit} · the longest usual visit is {usual}",
} as const;

/** Where the expected activity list is (ExpectedActivityCard's heading). */
export const EXPECTED_ACTIVITY_HREF = "/security/patterns#patterns-expected";

type Detail = IncidentPatternFlagView["detail"];

/** A whole number the box sent as a number — never a string, never NaN. */
function int(d: Detail, key: string): number | null {
  const v = d?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** A rate the box sends as an exact decimal string (or a number). */
function rate(d: Detail, key: string): number | null {
  const v = d?.[key];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The numbers behind one flag, in words — or null when the box didn't send
 * them (withheld, missing or not numbers). Pure.
 */
export function flagNumbers(f: Pick<IncidentPatternFlagView, "code" | "detail">): string | null {
  const d = f.detail;
  switch (f.code) {
    case "out_of_place": {
      const seen = int(d, "daysWithEvent");
      const watched = int(d, "daysObserved");
      const dayType = d?.dayType;
      if (seen === null || watched === null || (dayType !== "weekday" && dayType !== "weekend")) return null;
      return fillCopy(FLAG_COPY.seenOn, { d: seen, n: watched, days: dayType === "weekday" ? FLAG_COPY.weekdays : FLAG_COPY.weekendDays });
    }
    case "unusual_volume": {
      const k = int(d, "k");
      const lambda = rate(d, "lambda");
      const hour = int(d, "hour");
      if (k === null || lambda === null || hour === null || hour < 0 || hour > 23) return null;
      return fillCopy(FLAG_COPY.volume, { k, range: hourRange(hour, " and "), rate: formatRate(lambda) });
    }
    case "long_dwell": {
      const visit = int(d, "durationSec");
      const usual = int(d, "p99Sec");
      if (visit === null || usual === null) return null;
      return fillCopy(FLAG_COPY.dwell, { visit: formatVisit(visit), usual: formatVisit(usual) });
    }
    default:
      return null;
  }
}

/** `Person · Back camera · 2:14 AM · seen on 0 of 20 weekdays at this hour`. */
export function flagEvidenceLine(f: IncidentPatternFlagView, cameraLabel: (name: string) => string, timezone: string, now: Date): string {
  return [labelName(f.evidence.label), cameraLabel(f.evidence.camera), formatSiteWhen(f.evidence.at, timezone, now), flagNumbers(f)]
    .filter((p): p is string => Boolean(p))
    .join(" · ");
}

interface Block {
  key: string;
  flag: IncidentPatternFlagView;
  lines: string[];
}

export function PatternFlagList({
  flags,
  cameraLabel,
  timezone,
  now,
  labelledBy,
  separated = false,
}: {
  flags: readonly IncidentPatternFlagView[];
  cameraLabel: (name: string) => string;
  timezone: string;
  now: Date;
  labelledBy?: string;
  /** Under the counted reasons in the same card: a rule between the two lists. */
  separated?: boolean;
}) {
  if (flags.length === 0) return null;
  const blocks: Block[] = [];
  for (const f of flags) {
    const key = `${f.code}|${f.effect}|${f.suppression?.id ?? ""}`;
    let block = blocks.find((b) => b.key === key);
    if (!block) {
      block = { key, flag: f, lines: [] };
      blocks.push(block);
    }
    block.lines.push(flagEvidenceLine(f, cameraLabel, timezone, now));
  }
  return (
    <ul
      className="rows"
      aria-labelledby={labelledBy}
      style={{ listStyle: "none", margin: 0, padding: 0, ...(separated ? { borderTop: "1px solid var(--card-bd)" } : {}) }}
    >
      {blocks.map(({ key, flag: f, lines }) => {
        const quiet = f.effect === "suppressed";
        const Icon = quiet ? CalendarCheck : Activity;
        const name = PATTERN_NAME[f.code] ?? f.code;
        return (
          <li
            key={key}
            className="lrow"
            data-testid={`pattern-flag-${f.code}-${f.effect}`}
            data-code={f.code}
            data-effect={f.effect}
            style={{ alignItems: "flex-start" }}
          >
            {/* Never tinted by the would-be severity: nothing here counted. */}
            <span className="ri" aria-hidden>
              <Icon size={16} />
            </span>
            <span className="rt">
              <span className="nm" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                {quiet ? <s style={{ color: "var(--text-muted)" }}>{name}</s> : <span>{name}</span>}
                {!quiet && (
                  <span className="badge info" style={{ marginLeft: 8, verticalAlign: "middle" }}>
                    {FLAG_COPY.trial}
                  </span>
                )}
              </span>
              {quiet ? (
                <span className="sub" style={{ whiteSpace: "normal", overflowWrap: "anywhere", color: "var(--text)" }}>
                  <QuietNote suppression={f.suppression} />{" "}
                  <Link href={EXPECTED_ACTIVITY_HREF} style={{ color: "var(--brand)" }}>
                    {FLAG_COPY.seeExpected}
                  </Link>
                </span>
              ) : (
                <span className="sub" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                  {FLAG_COPY.trialNote}
                </span>
              )}
              {lines.map((line, n) => (
                <span key={n} className="sub" data-evidence style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
                  {line}
                </span>
              ))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Which expected activity kept it quiet — the person's own reason, quoted — and whether it still does. */
function QuietNote({ suppression: s }: { suppression: IncidentPatternFlagView["suppression"] }) {
  if (!s) return <>{FLAG_COPY.keptQuiet}</>;
  const since = s.state === "removed" ? FLAG_COPY.sinceRemoved : s.state === "expired" ? FLAG_COPY.sinceEnded : null;
  return (
    <>
      {FLAG_COPY.expected} “{s.reason}”{since ? ` ${since}` : ""}
    </>
  );
}
