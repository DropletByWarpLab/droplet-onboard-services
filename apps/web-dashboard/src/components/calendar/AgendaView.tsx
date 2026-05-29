"use client";

import { useMemo } from "react";
import { Calendar as CalendarIcon, MapPin, Globe } from "lucide-react";
import type { CalendarEvent } from "@/lib/hooks/useCalendar";

/** Group events by local-day buckets so the agenda view reads as
 *  "Today / Tomorrow / Wed Apr 23 / Thu Apr 24 / ...". */
function groupByDay(events: CalendarEvent[]): Array<{ key: string; label: string; events: CalendarEvent[] }> {
  const buckets = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const d = new Date(ev.startsAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(ev);
    else buckets.set(key, [ev]);
  }
  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const tomorrow = new Date(today.getTime() + 86400000);
  const tomorrowKey = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;

  return Array.from(buckets.entries()).map(([key, evs]) => {
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
}

export function AgendaView({ events, onSelect }: Props) {
  const groups = useMemo(() => groupByDay(events), [events]);

  if (groups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-label-tertiary">
        <CalendarIcon size={32} className="mb-2 opacity-50" />
        <p className="type-body">No events in this range.</p>
        <p className="type-subheadline mt-1">Click "New event" to create one.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      {groups.map((g) => (
        <section key={g.key}>
          <h3 className="type-subheadline text-label-secondary mb-2 sticky top-0 bg-surface-primary/95 backdrop-blur py-1">
            {g.label}
          </h3>
          <ul className="flex flex-col gap-1">
            {g.events.map((ev) => (
              <li key={ev.id}>
                <button
                  type="button"
                  onClick={() => onSelect?.(ev)}
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
      ))}
    </div>
  );
}
