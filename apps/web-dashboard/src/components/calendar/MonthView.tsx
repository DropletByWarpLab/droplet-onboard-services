"use client";

import { useMemo } from "react";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";
import { dayKey } from "@/lib/calendar";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** 42 cells (6 weeks) starting on the Sunday on/before the 1st of `cursor`'s
 *  month, so the grid is always a full rectangle regardless of how the month
 *  falls. */
export function monthGridDays(cursor: Date): Date[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
}

/** [from, to] covering the full visible grid — the range to fetch events for. */
export function monthGridRange(cursor: Date): { from: Date; to: Date } {
  const days = monthGridDays(cursor);
  const from = new Date(days[0]);
  from.setHours(0, 0, 0, 0);
  const to = new Date(days[days.length - 1]);
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

/** Buckets events by the local day they fall on. A multi-day event — or one
 *  that started before the visible grid (the backend returns events by range
 *  *overlap*, not just start-day) — is placed on EVERY calendar day it covers.
 *  Bucketing by `startsAt` alone made multi-day events vanish from all but
 *  their first day. `endsAt` is treated as exclusive (−1 ms) so an all-day
 *  event ending at next-midnight doesn't bleed into the following day, and is
 *  clamped ≥ start for missing/inverted data. An unparseable `endsAt` (NaN)
 *  falls back to the start day so the event still appears once instead of
 *  being dropped (Math.max(NaN, …) is NaN, which would empty its day span). */
export function eventsByDay(events: CalendarEvent[]): Map<string, CalendarEvent[]> {
  const m = new Map<string, CalendarEvent[]>();
  const add = (k: string, ev: CalendarEvent) => {
    const bucket = m.get(k);
    if (bucket) bucket.push(ev);
    else m.set(k, [ev]);
  };
  for (const ev of events) {
    const start = new Date(ev.startsAt);
    const endMs = ev.endsAt && !isNaN(new Date(ev.endsAt).getTime())
      ? Math.max(new Date(ev.endsAt).getTime() - 1, start.getTime())
      : start.getTime();
    const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const lastDate = new Date(endMs);
    const lastDay = new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate());
    // Guard against a pathological multi-year span spinning the loop.
    for (let guard = 0; cursor <= lastDay && guard < 400; guard++) {
      add(dayKey(cursor), ev);
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  for (const evs of m.values()) {
    evs.sort((a, b) => (a.allDay === b.allDay ? a.startsAt.localeCompare(b.startsAt) : a.allDay ? -1 : 1));
  }
  return m;
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

interface Props {
  events: CalendarEvent[];
  /** Any date within the month to display. */
  cursor: Date;
  onSelectEvent?: (ev: CalendarEvent) => void;
  onSelectDay?: (day: Date) => void;
  /** Resolves the source calendar's color for an event chip's left accent. */
  colorOf?: (ev: CalendarEvent) => string | undefined;
}

export function MonthView({ events, cursor, onSelectEvent, onSelectDay, colorOf }: Props) {
  const days = useMemo(() => monthGridDays(cursor), [cursor]);
  const byDay = useMemo(() => eventsByDay(events), [events]);
  const month = cursor.getMonth();
  const todayKey = dayKey(new Date());

  return (
    <div className="card overflow-hidden" style={{ padding: 0 }}>
      {/* `gap: 0` is pinned inline rather than left to a utility, because this
          grid renders inside `.droplet-shell` — whose `.grid { gap: 16px }`
          primitive is specificity (0,2,0) and applies to any bare `grid` in
          here (04-coding-standards/mobile-web-layout.md §4). MiniMonth pins
          its own gap the same way (WARP-1848); this is the big grid's turn.

          Measured in Chrome at 375px against the production CSS bundle: the
          seven day columns came out **35px each with 16px of dead space
          between them** (7×35 + 6×16 = 341). What that cost is the CELLS, not
          the card's edges. This card is `padding: 0` (see above), so the outer
          two columns sit flush against the card walls either way — `gap` only
          redistributes the same 341px track BETWEEN the columns, and
          7×48.7 + 6×0 is that same 341. Dropping it buys two things:

            · each cell is ~39% wider (35px → 48.7px), which is the difference
              between a 2-digit date plus an event chip fitting and not; and
            · every cell's `border-r`/`border-b` meets its neighbour's instead
              of floating 16px away from the cell it is meant to divide, so
              the lattice reads as one grid rather than as clipped decoration.

          That lattice is what the markup below has drawn since the view was
          written (`isLastCol`/`isLastRow`, #341) — the shell's gap had been
          quietly pulling it apart at every width. WARP-1786. */}
      <div
        className="grid grid-cols-7"
        style={{ gap: "0px", borderBottom: "1px solid var(--card-bd)" }}
      >
        {WEEKDAYS.map((w) => (
          <div
            key={w}
            className="px-2 py-2 type-caption-2 text-center uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            <span className="hidden sm:inline">{w}</span>
            <span className="sm:hidden">{w[0]}</span>
          </div>
        ))}
      </div>

      {/* Same pin as the weekday row above — see the note there. */}
      <div className="grid grid-cols-7" style={{ gap: "0px" }}>
        {days.map((d, i) => {
          const k = dayKey(d);
          const inMonth = d.getMonth() === month;
          const isToday = k === todayKey;
          const dayEvents = byDay.get(k) ?? [];
          const isLastCol = i % 7 === 6;
          const isLastRow = i >= 35;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onSelectDay?.(d)}
              aria-label={`${d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}, ${dayEvents.length} event${dayEvents.length === 1 ? "" : "s"}`}
              className={[
                "min-h-[88px] sm:min-h-[104px] text-left p-1.5 align-top transition-colors",
                "hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-inset",
                isLastCol ? "" : "border-r border-[color:var(--card-bd)]",
                isLastRow ? "" : "border-b border-[color:var(--card-bd)]",
                inMonth ? "" : "bg-[var(--inset)]",
              ].join(" ")}
            >
              <div className="mb-1">
                <span
                  className={[
                    "type-caption-1 tabular-nums inline-flex items-center justify-center h-5 min-w-[20px] px-1 rounded-full",
                    isToday
                      ? "font-semibold"
                      : "",
                  ].join(" ")}
                  style={
                    isToday
                      ? { background: "var(--brand)", color: "#fff" }
                      : { color: inMonth ? "var(--text-muted)" : "var(--text-faint)" }
                  }
                >
                  {d.getDate()}
                </span>
              </div>

              <div className="flex flex-col gap-0.5">
                {dayEvents.slice(0, 3).map((ev) => (
                  <span
                    key={ev.id}
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectEvent?.(ev);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        onSelectEvent?.(ev);
                      }
                    }}
                    title={`${ev.title}${ev.allDay ? " · All day" : " · " + shortTime(ev.startsAt)}${ev.location ? " · " + ev.location : ""}`}
                    style={colorOf?.(ev) ? { borderLeft: `3px solid ${colorOf(ev)}` } : undefined}
                    className={[
                      "block truncate rounded px-1 py-0.5 type-caption-2 cursor-pointer",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-inset",
                      // External events get a bordered neutral chip: surface-tertiary
                      // equals the card background in light mode, so without a distinct
                      // fill + border the chip was invisible on the white card.
                      ev.source === "external"
                        ? "bg-[var(--card-inner)] text-[color:var(--text-muted)] border border-[color:var(--card-bd)]"
                        : "bg-[var(--brand-subtle)] text-[color:var(--brand)]",
                    ].join(" ")}
                  >
                    {!ev.allDay && (
                      <span className="tabular-nums opacity-70 mr-1">{shortTime(ev.startsAt)}</span>
                    )}
                    {ev.title}
                  </span>
                ))}
                {dayEvents.length > 3 && (
                  <span className="type-caption-2 px-1" style={{ color: "var(--text-muted)" }}>
                    +{dayEvents.length - 3} more
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
