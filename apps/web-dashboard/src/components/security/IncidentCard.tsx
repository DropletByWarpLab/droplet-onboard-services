"use client";

/**
 * WARP-2978 (ADR-059 P3 §8) — one incident as a row: the Incidents tab on
 * /security and the /d/security widget.
 *
 *   line 1  the severity badge (Alert / Notice / none for plain activity) and
 *           the title (area / camera / Network and sign-in / Camera system);
 *   line 2  the plain-language codes, or the event count, then the span in
 *           site time;
 *   line 3  Needs attention / Acknowledged by Maria at 2:17 AM / Resolved by
 *           Stefan, and Still happening while it collects events.
 *
 * Everything on it is the box's answer for this viewer (DS-005): the badge is
 * the VISIBLE severity, the codes the visible codes, the count the visible
 * count. The row is one link to the incident page.
 */
import Link from "next/link";
import { ChevronRight, Shield, ShieldAlert, User, VideoOff, type LucideIcon } from "lucide-react";
import type { IncidentSummary } from "@/lib/types";
import { incidentTitle, severityBadge, stateLine, whatLine } from "./incident-copy";

/** The glyph for the incident's strongest visible reason, else its scope. */
export function incidentIcon(i: Pick<IncidentSummary, "scope" | "reasonCodes">): LucideIcon {
  if (i.reasonCodes.includes("after_hours_presence")) return User;
  if (i.reasonCodes.includes("camera_offline") || i.scope === "site_camera_system") return VideoOff;
  if (i.reasonCodes.includes("threat_signal") || i.scope === "site_threat") return ShieldAlert;
  return Shield;
}

export interface IncidentCardProps {
  incident: IncidentSummary;
  /** Frigate camera name → the business's name for it. Defaults to the Frigate name. */
  cameraLabel?: (name: string) => string;
  /** The zone every time is shown in: the site's, else the device's. */
  timezone: string;
  now?: Date;
}

export function IncidentCard({ incident: i, cameraLabel = (n) => n, timezone, now: nowProp }: IncidentCardProps) {
  const now = nowProp ?? new Date();
  const badge = severityBadge(i.severity);
  const Icon = incidentIcon(i);
  const tint = i.severity === "alert" ? " sev-ic err" : i.severity === "notice" ? " sev-ic warn" : "";
  const state = stateLine(i, timezone, now);
  return (
    <li data-incident={i.id} data-severity={i.severity} data-state={i.state}>
      <Link
        href={`/security/incidents/${encodeURIComponent(i.id)}`}
        className="lrow ev-row"
        style={{ padding: "12px 8px", color: "inherit", textDecoration: "none", alignItems: "flex-start" }}
      >
        <span className={`ri${tint}`} aria-hidden>
          <Icon size={16} />
        </span>
        <span className="rt">
          {/* The shell's row title is one ellipsised line; an incident's title must never be cut off. */}
          <span className="nm" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, whiteSpace: "normal", overflowWrap: "anywhere" }}>
            {badge && <span className={badge.cls}>{badge.text}</span>}
            <span>{incidentTitle(i, cameraLabel)}</span>
          </span>
          <span className="sub" style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>
            {whatLine(i, timezone, now)}
          </span>
          {state && (
            <span
              className="sub"
              data-state-line
              style={{ whiteSpace: "normal", overflowWrap: "anywhere", color: i.state === "open" ? "var(--text)" : undefined }}
            >
              {state}
            </span>
          )}
        </span>
        <ChevronRight size={16} aria-hidden style={{ flexShrink: 0, alignSelf: "center", color: "var(--text-muted)" }} />
      </Link>
    </li>
  );
}
