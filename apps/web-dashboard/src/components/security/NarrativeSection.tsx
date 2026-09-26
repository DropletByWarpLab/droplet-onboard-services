"use client";

/**
 * WARP-2979 (ADR-059 P4 §8, DS-007) — "Summary by Droplet" on the incident
 * page, placed right after "Why Droplet flagged this": the codes come first,
 * and the caption says that when the two disagree, the reasons are right.
 *
 * What it shows is the box's answer for THIS viewer (route 18's `narrative`):
 *   written            the text, then who wrote it and when; Regenerate at act
 *   pending            "Droplet is writing a summary." (the previous text, when
 *                      there is one, stays below it, marked Updating)
 *   pending, paused    "Droplet will write a summary when its on-box AI model
 *                      is available." (the `summaries` health row is Paused)
 *   none, collecting   "Droplet writes a summary when this incident ends.";
 *                      Summarise now at act
 *   failed             "Droplet couldn't write a summary for this incident.";
 *                      Regenerate at act
 *   null, expired,     nothing at all — a viewer who cannot see everything
 *   none once closed   the summary names gets `null` from the box, with no
 *                      hint that one exists (DS-005)
 *
 * Rules (the incident page's own): the buttons render only at act, never
 * rendered and then refused; in flight they are aria-disabled, never
 * `disabled`, and a ref refuses a second press; a failure is a toast through
 * `translateError(err, "security")`, never the server's words. After a
 * request the incident is re-read every 5 s while it is pending, for at most
 * 2 minutes. No motion: the state changes in place, announced politely.
 */
import { useEffect, useId, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { formatSiteWhen } from "@/lib/security-time";
import type { IncidentNarrativeView } from "@/lib/types";
import { fill } from "./TimezoneSelect";

export const NARRATIVE_COPY = {
  title: "Summary by Droplet",
  writtenBy:
    "Written by the AI on this Droplet at {at} from the events below. The reasons above are what Droplet flagged; if this summary disagrees with them, the reasons are right.",
  writing: "Droplet is writing a summary.",
  updating: "Updating",
  paused: "Droplet will write a summary when its on-box AI model is available.",
  whenItEnds: "Droplet writes a summary when this incident ends.",
  failed: "Droplet couldn't write a summary for this incident.",
  regenerate: "Regenerate",
  summariseNow: "Summarise now",
} as const;

/** After a request: re-read this often while the summary is pending… */
export const NARRATIVE_POLL_MS = 5_000;
/** …for at most this long. */
export const NARRATIVE_POLL_FOR_MS = 120_000;

export interface NarrativeSectionProps {
  /** Route 18's `narrative` for this viewer (absent on an older box: treated as null). */
  narrative: IncidentNarrativeView | null | undefined;
  grouping: "collecting" | "closed";
  /** Act level (the module level AND the box's own `viewer.level`). */
  canAct: boolean;
  /** The `summaries` health row reads Paused: the on-box model isn't available. */
  paused: boolean;
  timezone: string;
  now: Date;
  /** Route 28. Rejects with the typed error. */
  onSummarise: () => Promise<unknown>;
  /** Re-read the incident. */
  refresh: () => void;
}

const muted = { margin: 0, fontSize: 13, color: "var(--text-muted)", maxWidth: "70ch" } as const;

export function NarrativeSection({ narrative: n, grouping, canAct, paused, timezone, now, onSummarise, refresh }: NarrativeSectionProps) {
  const { toast } = useToast();
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pollUntil, setPollUntil] = useState<number | null>(null);
  const pending = n?.state === "pending";

  // Re-read while pending, only after this person asked, for at most 2 minutes.
  useEffect(() => {
    if (!pending || pollUntil === null) return;
    const left = pollUntil - Date.now();
    if (left <= 0) return;
    const every = setInterval(refresh, NARRATIVE_POLL_MS);
    const stop = setTimeout(() => {
      clearInterval(every);
      setPollUntil(null);
    }, left);
    return () => {
      clearInterval(every);
      clearTimeout(stop);
    };
  }, [pending, pollUntil, refresh]);

  if (!n) return null;
  const collectingNone = n.state === "none" && grouping === "collecting";
  if (n.state === "expired" || (n.state === "none" && !collectingNone)) return null;

  const ask = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await onSummarise();
      setPollUntil(Date.now() + NARRATIVE_POLL_FOR_MS);
    } catch (err) {
      toast(translateError(err, "security"), "error");
      refresh();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const action = !canAct
    ? null
    : n.state === "written" || n.state === "failed"
      ? NARRATIVE_COPY.regenerate
      : collectingNone
        ? NARRATIVE_COPY.summariseNow
        : null;

  const status = pending ? (paused ? NARRATIVE_COPY.paused : NARRATIVE_COPY.writing) : n.state === "failed" ? NARRATIVE_COPY.failed : collectingNone ? NARRATIVE_COPY.whenItEnds : null;

  return (
    <>
      <div className="sect">
        <h2 id={titleId}>{NARRATIVE_COPY.title}</h2>
      </div>
      <section className="card" aria-labelledby={titleId} data-testid="incident-narrative" data-state={n.state}>
        <div aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {status && <p style={muted}>{status}</p>}
          {n.text !== null && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-updating={pending || undefined}>
              {pending && <span className="badge muted" style={{ alignSelf: "flex-start" }}>{NARRATIVE_COPY.updating}</span>}
              <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.55, maxWidth: "70ch", color: pending ? "var(--text-muted)" : undefined }}>{n.text}</p>
              {n.state === "written" && n.writtenAt && (
                <p style={{ ...muted, fontSize: 12.5 }}>{fill(NARRATIVE_COPY.writtenBy, { at: formatSiteWhen(n.writtenAt, timezone, now) })}</p>
              )}
            </div>
          )}
        </div>
        {action && (
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn sm" aria-disabled={busy || undefined} onClick={() => void ask()}>
              {action}
            </button>
          </div>
        )}
      </section>
    </>
  );
}
