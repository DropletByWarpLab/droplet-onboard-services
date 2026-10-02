"use client";

/**
 * WARP-2980 (ADR-059 P5 §8 "Learning") — how far along Droplet is with each
 * camera the viewer may see:
 *   · learning — "Learning what normal looks like — 9 of 14 days", with a
 *     14-step bar (only fully watched days count);
 *   · active   — "Knows what normal looks like · about 140 detections a day";
 *   · stale    — "Hasn't been watching since Tue 2:14 AM" (the site's zone);
 *   · then every camera Droplet has never heard from: "Not reporting to
 *     Droplet yet".
 * Weekend readiness is not here — it shows in the grid, where weekend hours
 * stay hatched longer.
 *
 * The server has already dropped every camera outside the viewer's grant
 * (DS-005), and /api/cameras is filtered the same way.
 */
import { formatSiteWhen, deviceTimeZone } from "@/lib/security-time";
import type { CameraInfo, SecurityPatternsOverview } from "@/lib/types";
import { COPY, fillCopy, formatPerDay } from "./patterns-copy";
import "./patterns.css";

type Source = SecurityPatternsOverview["sources"][number];

/** The row's line, in the site zone (the device's while none is known). */
export function learningLine(source: Source, timezone: string | null, now: Date): string {
  if (source.state === "learning") {
    return fillCopy(COPY.learning, { days: Math.min(source.daysObserved, source.daysNeeded), needed: source.daysNeeded });
  }
  if (source.state === "stale") {
    const tz = timezone ?? deviceTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return fillCopy(COPY.stale, { when: formatSiteWhen(source.lastSeenAt, tz, now) });
  }
  return source.detectionsPerDay === null ? COPY.knows : `${COPY.knows} · ${formatPerDay(source.detectionsPerDay)}`;
}

function Steps({ name, days, needed }: { name: string; days: number; needed: number }) {
  const on = Math.min(days, needed);
  return (
    <div
      className="learning-steps"
      role="progressbar"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={needed}
      aria-valuenow={on}
      aria-valuetext={`${on} of ${needed} days`}
    >
      {Array.from({ length: needed }, (_x, i) => (
        <span key={i} data-step={i < on ? "on" : "off"} />
      ))}
    </div>
  );
}

export function LearningList({
  sources,
  cameras,
  timezone,
  now,
}: {
  sources: readonly Source[];
  cameras: readonly CameraInfo[];
  timezone: string | null;
  now: Date;
}) {
  const heard = new Set(sources.map((s) => s.camera));
  const never = cameras.filter((c) => !heard.has(c.name));
  if (sources.length === 0 && never.length === 0) return null;
  return (
    <ul className="learning-list">
      {sources.map((s) => (
        <li key={s.camera} className="learning-row" data-state={s.state}>
          <span className="learning-name" data-testid="learning-name">
            {s.label}
          </span>
          <span className="learning-line">{learningLine(s, timezone, now)}</span>
          {s.state === "learning" && <Steps name={s.label} days={s.daysObserved} needed={s.daysNeeded} />}
        </li>
      ))}
      {never.map((c) => (
        <li key={c.name} className="learning-row" data-state="none">
          <span className="learning-name" data-testid="learning-name">
            {c.displayName || c.name}
          </span>
          <span className="learning-line">{COPY.notReporting}</span>
        </li>
      ))}
    </ul>
  );
}
