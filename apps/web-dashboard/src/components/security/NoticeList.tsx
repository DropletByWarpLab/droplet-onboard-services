"use client";

/**
 * WARP-2978 (ADR-059 P3 §8, D34) — "Who was told". Owners and admins receive
 * every notice from the box; anyone else only their own. That split is the
 * box's (DS-005): this renders exactly the notices it was given, one line
 * each, and the page leaves the section out when there are none.
 */
import type { IncidentNoticeView } from "@/lib/types";
import { noticeLine } from "./incident-copy";

export function NoticeList({
  notices,
  cameras,
  timezone,
  now,
  labelledBy,
}: {
  notices: readonly IncidentNoticeView[];
  /** The business's names for the alert evidence cameras — what a `skipped_not_visible` person couldn't see. */
  cameras: readonly string[];
  timezone: string;
  now: Date;
  labelledBy: string;
}) {
  return (
    <ul className="rows" aria-labelledby={labelledBy} style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {notices.map((n) => (
        <li key={n.userId} className="lrow" data-outcome={n.outcome}>
          <span className="rt">
            <span className="nm" style={{ whiteSpace: "normal", overflowWrap: "anywhere", fontWeight: 400 }}>
              {noticeLine(n, cameras, timezone, now)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
