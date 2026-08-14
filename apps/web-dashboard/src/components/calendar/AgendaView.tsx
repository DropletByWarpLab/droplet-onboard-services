"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar as CalendarIcon, Check, Copy, Globe, MapPin, Video } from "lucide-react";
import { parseMeetingLink } from "@droplet/shared-types";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import { dayKey } from "@/lib/calendar";
import { meetingPasscode } from "@/lib/meeting-passcode";
import { eventsByDay } from "./MonthView";

/** Stable DOM id for a day section so the page can scroll the agenda to a
 *  specific date when its mini-month cell is clicked. */
export function agendaDayId(key: string): string {
  return `agenda-day-${key}`;
}

/** Group events into local-day buckets so the agenda reads as
 *  "Today / Tomorrow / Wed Apr 23 / Thu Apr 24 / ...". Groups are returned in
 *  chronological order, events within a day are sorted (all-day first, then by
 *  start time — handled by the shared `eventsByDay`), and a multi-day event is
 *  placed on every local day it spans, so an event that started before the
 *  range still appears under each covered day instead of vanishing. Bucketing +
 *  per-day sorting reuse the month grid's `eventsByDay` (single source of truth);
 *  this layer only sorts the days chronologically and adds Today/Tomorrow labels. */
export function groupByDay(
  events: CalendarEvent[],
): Array<{ key: string; label: string; events: CalendarEvent[] }> {
  const buckets = eventsByDay(events);

  const today = new Date();
  const todayKey = dayKey(today);
  // Calendar-date arithmetic, not `+86.4M ms`: on a 23-hour spring-forward day
  // a fixed 24h offset skips a date, landing "Tomorrow" on day+2 (WARP-944).
  const tomorrowKey = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));

  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, evs]) => {
      const d = new Date(key + "T00:00:00");
      let label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      if (key === todayKey) label = `Today · ${label}`;
      else if (key === tomorrowKey) label = `Tomorrow · ${label}`;
      return { key, label, events: evs };
    });
}

function formatTime(iso: string, allDay: boolean): string {
  if (allDay) return "All day";
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/**
 * WARP-1905 — the URL-embedded passcode, as a one-click copy chip under the
 * Join pill. Quiet by design: caption type, muted color, and the confirm is
 * an in-place icon/word swap (no toast, no relayout) that reverts on its
 * own — the row stays calm. Renders nothing when the link carries no
 * passcode, which is most links.
 */
function PasscodeChip({ link }: { link: NonNullable<ReturnType<typeof parseMeetingLink>> }) {
  const passcode = useMemo(() => meetingPasscode(link), [link]);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timerRef.current), []);

  if (!passcode) return null;

  const copy = async () => {
    // clipboard is absent outside secure contexts (http-by-LAN-IP) and in
    // jsdom. No optional chain here: `clipboard?.writeText` would resolve
    // to undefined and fall through to a FALSE "Copied" — announced to
    // screen readers too. Missing clipboard must throw into the catch so
    // the chip fails quiet; the passcode stays visible to read and retype.
    try {
      await navigator.clipboard.writeText(passcode);
    } catch {
      return;
    }
    setCopied(true);
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 2000);
  };

  return (
    <>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy passcode ${passcode}`}
        title="Copy passcode"
        // min-h-[24px] — WCAG 2.5.8 target floor at every width;
        // max-lg:min-h-[44px] — the handbook's phone-width touch minimum
        // (04-coding-standards/mobile-web-layout.md §3b), same token as
        // MiniMonth's day cells.
        className="inline-flex items-center gap-1 type-caption-1 transition-colors hover:text-[var(--text)] max-w-full min-h-[24px] max-lg:min-h-[44px]"
        style={{ color: "var(--text-muted)" }}
      >
        {copied ? (
          <Check size={10} aria-hidden="true" />
        ) : (
          <Copy size={10} aria-hidden="true" />
        )}
        {copied ? "Copied" : "Passcode"}
        <span className="font-mono truncate">{passcode}</span>
      </button>
      {/* WCAG 4.1.3 — the visible word-flip above never reaches the
          accessible name (aria-label is static), so the confirmation is
          announced here. Permanently mounted (WARP-1528: SRs only announce
          mutations of a region they were already observing) and a SIBLING of
          the button, since button descendants are presentational per ARIA.
          sr-only is position:absolute, so the empty span adds no flex gap. */}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </>
  );
}

interface Props {
  events: CalendarEvent[];
  onSelect?: (ev: CalendarEvent) => void;
  /** Resolves the source calendar's color for an event row's left accent. */
  colorOf?: (ev: CalendarEvent) => string | undefined;
  /** Day-key (YYYY-MM-DD) to scroll into view + highlight — set when a date is
   *  picked in the mini-month. */
  selectedKey?: string;
}

export function AgendaView({ events, onSelect, colorOf, selectedKey }: Props) {
  const groups = useMemo(() => groupByDay(events), [events]);
  const containerRef = useRef<HTMLDivElement>(null);
  // Last day-key we actually scrolled to. `groups` has to stay in the effect's
  // dep array (a selection made before the events load still needs to scroll
  // once they arrive), but every SWR poll hands us a fresh `events` → new
  // `groups` ref → the effect re-fires. Without this guard the user gets yanked
  // back to `selectedKey` on every poll cycle even after scrolling away. So we
  // only scroll when the SELECTION genuinely changed.
  const lastScrolledKeyRef = useRef<string | undefined>(undefined);

  // Scroll the picked day's section into view when the selection changes.
  useEffect(() => {
    // Deselection (toolbar nav, view switch) clears the marker so re-picking the
    // SAME day later scrolls again instead of being suppressed as "unchanged".
    if (!selectedKey) {
      lastScrolledKeyRef.current = undefined;
      return;
    }
    if (selectedKey === lastScrolledKeyRef.current) return;
    const el = containerRef.current?.querySelector<HTMLElement>(`#${CSS.escape(agendaDayId(selectedKey))}`);
    if (!el) {
      // No section for this key — either events aren't loaded yet or the day is
      // empty. Mark as scrolled to stop an infinite retry loop on empty days.
      lastScrolledKeyRef.current = selectedKey;
      return;
    }
    // Honour prefers-reduced-motion: the CSS global block doesn't override a
    // programmatic scrollIntoView({behavior:"smooth"}), so gate it here —
    // reduced-motion users get an instant jump instead of an animated scroll.
    // Mirrors network/schedule-anchor-scroll.ts (WARP-100). SSR/jsdom-safe.
    const reduceMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    lastScrolledKeyRef.current = selectedKey;
  }, [selectedKey, groups]);

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16" style={{ color: "var(--text-muted)" }}>
        <CalendarIcon size={32} className="mb-2 opacity-50" />
        <p className="type-body">No events in this range.</p>
        <p className="type-subheadline mt-1">Click &quot;New event&quot; to create one.</p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col gap-6">
      {groups.map((g) => {
        const isSelected = g.key === selectedKey;
        return (
          <section key={g.key} id={agendaDayId(g.key)} className="scroll-mt-4">
            <h3
              className={[
                "type-subheadline mb-2 sticky top-0 backdrop-blur py-1 transition-colors",
                isSelected ? "font-semibold" : "",
              ].join(" ")}
              style={{
                background: "color-mix(in srgb, var(--bg) 95%, transparent)",
                color: isSelected ? "var(--brand)" : "var(--text-muted)",
              }}
              aria-current={isSelected ? "true" : undefined}
            >
              {g.label}
            </h3>
            <ul className="flex flex-col gap-1">
              {g.events.map((ev) => {
                // WARP-1905 — re-parsed at render, like MeetingCard: an
                // agenda row can arrive from an external ICS feed that no
                // zod schema ever inspected, and this is the last thing
                // between a stored string and an href. Unparseable → the
                // row renders exactly as before, nothing extra.
                const link = parseMeetingLink(ev.meetingUrl);
                return (
                  <li
                    key={ev.id}
                    style={{
                      padding: "12px",
                      ...(colorOf?.(ev) ? { borderLeft: `3px solid ${colorOf(ev)}` } : {}),
                    }}
                    className="card hover:bg-[var(--hover)] transition flex items-start gap-3"
                  >
                    {/* The join anchor must stay a SIBLING of this button —
                        an <a> nested inside a <button> is invalid HTML and
                        makes the whole row "the link" to assistive tech. */}
                    <button
                      type="button"
                      onClick={() => onSelect?.(ev)}
                      className="flex-1 min-w-0 text-left flex items-start gap-3"
                    >
                      <div className="w-20 shrink-0 type-subheadline tabular-nums" style={{ color: "var(--text-muted)" }}>
                        {formatTime(ev.startsAt, ev.allDay)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="type-body truncate" style={{ color: "var(--text)" }}>{ev.title}</span>
                          {ev.source === "external" && (
                            <span title="From an external calendar">
                              <Globe size={12} style={{ color: "var(--text-muted)" }} />
                            </span>
                          )}
                        </div>
                        {ev.location && (
                          <div className="flex items-center gap-1 mt-0.5 type-caption-1 truncate" style={{ color: "var(--text-muted)" }}>
                            <MapPin size={10} />
                            {ev.location}
                          </div>
                        )}
                      </div>
                    </button>
                    {link && (
                      <div className="shrink-0 flex flex-col items-end gap-1 max-w-[45%]">
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={link.url}
                          // max-lg:min-h-[44px] — ~26px tall on a phone
                          // otherwise, under the 44px touch minimum
                          // (04-coding-standards/mobile-web-layout.md §3b).
                          className="inline-flex items-center gap-1.5 type-caption-1 rounded-full border px-2.5 py-1 transition-colors hover:bg-[var(--hover)] max-lg:min-h-[44px]"
                          style={{ borderColor: "var(--border)", color: "var(--text)" }}
                        >
                          <Video size={12} strokeWidth={1.5} aria-hidden="true" />
                          {link.label}
                        </a>
                        <PasscodeChip link={link} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
