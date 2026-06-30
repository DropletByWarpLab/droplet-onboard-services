"use client";

import { useEffect, useMemo, useRef } from "react";
import { Calendar as CalendarIcon, MapPin, Globe } from "lucide-react";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import { dayKey } from "@/lib/calendar";

/** Stable DOM id for a day section so the page can scroll the agenda to a
 *  specific date when its mini-month cell is clicked. */
export function agendaDayId(key: string): string {
  return `agenda-day-${key}`;
}

/** Group events into local-day buckets so the agenda reads as
 *  "Today / Tomorrow / Wed Apr 23 / Thu Apr 24 / ...". Groups are returned in
 *  chronological order, events within a day are sorted (all-day first, then by
 *  start time), and a multi-day event is placed on every local day it spans —
 *  matching the month grid's `eventsByDay`, so an event that started before the
 *  range still appears under each covered day instead of vanishing. */
export function groupByDay(
  events: CalendarEvent[],
): Array<{ key: string; label: string; events: CalendarEvent[] }> {
  const buckets = new Map<string, CalendarEvent[]>();
  const add = (k: string, ev: CalendarEvent) => {
    const bucket = buckets.get(k);
    if (bucket) bucket.push(ev);
    else buckets.set(k, [ev]);
  };
  for (const ev of events) {
    const start = new Date(ev.startsAt);
    // Treat endsAt as exclusive (−1 ms) so an all-day event ending at next
    // midnight doesn't bleed into the following day; clamp ≥ start for
    // missing/inverted data.
    const endMs = ev.endsAt && !isNaN(new Date(ev.endsAt).getTime())
      ? Math.max(new Date(ev.endsAt).getTime() - 1, start.getTime())
      : start.getTime();
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const last = new Date(endMs);
    const lastDay = new Date(last.getFullYear(), last.getMonth(), last.getDate());
    for (let guard = 0; cursor <= lastDay && guard < 400; guard++) {
      add(dayKey(cursor), ev);
      cursor.setDate(cursor.getDate() + 1);
    }
  }

  const today = new Date();
  const todayKey = dayKey(today);
  // Calendar-date arithmetic, not `+86.4M ms`: on a 23-hour spring-forward day
  // a fixed 24h offset skips a date, landing "Tomorrow" on day+2 (WARP-944).
  const tomorrowKey = dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));

  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, evs]) => {
      evs.sort((a, b) =>
        a.allDay === b.allDay
          ? (new Date(a.startsAt).getTime() || 0) - (new Date(b.startsAt).getTime() || 0)
          : a.allDay
            ? -1
            : 1,
      );
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
      <div className="flex flex-col items-center justify-center py-16 text-label-tertiary">
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
                "type-subheadline mb-2 sticky top-0 bg-surface-primary/95 backdrop-blur py-1 transition-colors",
                isSelected ? "text-accent font-semibold" : "text-label-secondary",
              ].join(" ")}
            >
              {g.label}
            </h3>
            <ul className="flex flex-col gap-1">
              {g.events.map((ev) => (
                <li key={ev.id}>
                  <button
                    type="button"
                    onClick={() => onSelect?.(ev)}
                    style={colorOf?.(ev) ? { borderLeft: `3px solid ${colorOf(ev)}` } : undefined}
                    className="w-full text-left dp-card p-3 hover:bg-surface-secondary transition flex items-start gap-3"
                  >
                    <div className="w-20 shrink-0 type-subheadline text-label-tertiary tabular-nums">
                      {formatTime(ev.startsAt, ev.allDay)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="type-body text-label-primary truncate">{ev.title}</span>
                        {ev.source === "external" && (
                          <span title="From an external calendar">
                            <Globe size={12} className="text-label-tertiary" />
                          </span>
                        )}
                      </div>
                      {ev.location && (
                        <div className="flex items-center gap-1 mt-0.5 type-caption-1 text-label-tertiary truncate">
                          <MapPin size={10} />
                          {ev.location}
                        </div>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
