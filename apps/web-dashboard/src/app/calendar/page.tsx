"use client";

import { useCallback, useMemo, useState } from "react";
import { Plus, RefreshCw, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { Topbar } from "@/components/Topbar";
import { useCalendarEvents, useCalendarSources, type CalendarEvent } from "@/lib/hooks/useCalendar";
import {
  dayKey,
  paletteColor,
  eventVisibilityKey,
  compareByStart,
  EXTERNAL_KEY,
  EXTERNAL_COLOR,
} from "@/lib/calendar";
import { AgendaView } from "@/components/calendar/AgendaView";
import { MonthView, monthGridRange } from "@/components/calendar/MonthView";
import { MiniMonth } from "@/components/calendar/MiniMonth";
import { EventForm } from "@/components/calendar/EventForm";
import { RemindersPanel } from "@/components/calendar/RemindersPanel";
import { SubscriptionsPanel } from "@/components/calendar/SubscriptionsPanel";

type View = "month" | "agenda";

function whenLabel(ev: CalendarEvent): string {
  const d = new Date(ev.startsAt);
  const sameDay = d.toDateString() === new Date().toDateString();
  const datePart = sameDay
    ? "Today"
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (ev.allDay) return `${datePart} · All day`;
  return `${datePart} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

/** Calendar surface. Month grid (the at-a-glance view) with an Agenda toggle,
 *  fronted by a left rail — mini-month, a per-calendar visibility list, and an
 *  "Up next" digest — mirroring the Droplet Design System handoff. All driven
 *  by real `/api/calendar` data; the fetched range follows the active view. */
export default function CalendarPage() {
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const range =
    view === "month"
      ? monthGridRange(cursor)
      : {
          from: new Date(new Date().setHours(0, 0, 0, 0)),
          to: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        };

  const { events, refresh, isLoading } = useCalendarEvents(range);
  const { sources } = useCalendarSources();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [newEventDate, setNewEventDate] = useState<Date | undefined>(undefined);

  const knownSourceIds = useMemo(() => new Set(sources.map((s) => s.id)), [sources]);
  const keyOf = useCallback(
    (e: CalendarEvent) => eventVisibilityKey(e, knownSourceIds),
    [knownSourceIds],
  );

  const calendars = useMemo(() => {
    const list = [{ key: "local", name: "My events", color: "var(--color-accent)" }];
    sources.forEach((s) => list.push({ key: s.id, name: s.name, color: paletteColor(s.id) }));
    // Catch-all row so events with a null/unrecognized sourceId stay toggleable
    // instead of being permanently visible with no control in the rail.
    if (events.some((e) => keyOf(e) === EXTERNAL_KEY)) {
      list.push({ key: EXTERNAL_KEY, name: "Other calendars", color: EXTERNAL_COLOR });
    }
    return list;
  }, [sources, events, keyOf]);

  const colorByKey = useMemo(
    () => Object.fromEntries(calendars.map((c) => [c.key, c.color])),
    [calendars],
  );

  const visibleEvents = useMemo(
    () => events.filter((e) => !hidden.has(keyOf(e))),
    [events, hidden, keyOf],
  );

  const eventDays = useMemo(() => {
    const s = new Set<string>();
    for (const e of visibleEvents) s.add(dayKey(new Date(e.startsAt)));
    return s;
  }, [visibleEvents]);

  const upcoming = useMemo(() => {
    const now = Date.now();
    return visibleEvents
      .filter((e) => new Date(e.endsAt || e.startsAt).getTime() >= now)
      .sort(compareByStart)
      .slice(0, 5);
  }, [visibleEvents]);

  function newEvent(date?: Date) {
    setEditing(null);
    setNewEventDate(date);
    setShowForm(true);
  }
  function editEvent(ev: CalendarEvent) {
    setEditing(ev);
    setShowForm(true);
  }
  function toggleCal(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  const prevMonth = () => setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1));
  const nextMonth = () => setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1));
  const goToday = () => setCursor(new Date());

  const status =
    events.length === 0
      ? { tone: "neutral" as const, label: view === "month" ? "No events this month" : "Agenda clear" }
      : { tone: "ok" as const, label: `${events.length} event${events.length === 1 ? "" : "s"}` };

  const actions = (
    <>
      <button
        onClick={() => refresh()}
        disabled={isLoading}
        className="inline-flex items-center justify-center h-9 w-9 rounded-md text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
        aria-label="Refresh calendar"
        title="Refresh"
      >
        <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
      </button>
      <button onClick={() => newEvent()} className="dp-btn-primary flex items-center gap-1.5 px-3 h-9 rounded-md">
        <Plus size={15} />
        <span className="type-subheadline">New event</span>
      </button>
    </>
  );

  return (
    <div>
      <Topbar
        crumbs={[{ label: "Workspace", href: "/" }, { label: "Calendar" }]}
        status={status}
        actions={actions}
      />

      <div className="p-6">
        {/* Calendar toolbar: month nav (month view only) + view toggle */}
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <div className="flex items-center gap-2 min-h-9">
            {view === "month" && (
              <>
                <button
                  onClick={prevMonth}
                  aria-label="Previous month"
                  className="inline-flex items-center justify-center h-9 w-9 rounded-md text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
                >
                  <ChevronLeft size={18} />
                </button>
                <h2 className="type-body font-semibold text-label-primary tabular-nums min-w-[9.5rem] text-center">
                  {monthLabel}
                </h2>
                <button
                  onClick={nextMonth}
                  aria-label="Next month"
                  className="inline-flex items-center justify-center h-9 w-9 rounded-md text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
                >
                  <ChevronRight size={18} />
                </button>
                <button
                  onClick={goToday}
                  className="dp-btn-secondary h-9 px-3 rounded-md type-subheadline ml-1"
                >
                  Today
                </button>
              </>
            )}
          </div>

          <div className="inline-flex rounded-md bg-surface-secondary p-0.5" role="group" aria-label="Calendar view">
            {(["month", "agenda"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                aria-pressed={view === v}
                className={[
                  "px-3 h-8 rounded type-subheadline capitalize transition-colors",
                  view === v
                    ? "bg-surface-primary text-label-primary shadow-sm"
                    : "text-label-tertiary hover:text-label-secondary",
                ].join(" ")}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
          {/* Left rail — mini-month, calendars, up next, reminders, subscriptions */}
          <aside className="flex flex-col gap-4 order-2 lg:order-1">
            <MiniMonth cursor={cursor} eventDays={eventDays} onCursor={(d) => setCursor(d)} />

            <div className="dp-card p-4">
              <h2 className="type-headline text-label-primary mb-2">Calendars</h2>
              <ul className="flex flex-col -mx-1">
                {calendars.map((c) => {
                  const on = !hidden.has(c.key);
                  return (
                    <li key={c.key}>
                      <button
                        onClick={() => toggleCal(c.key)}
                        aria-pressed={on}
                        className="w-full flex items-center gap-2.5 px-1 py-1.5 rounded hover:bg-surface-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        <span
                          className="h-3 w-3 rounded-[3px] flex-none transition-opacity"
                          style={{ background: c.color, opacity: on ? 1 : 0.3 }}
                        />
                        <span
                          className={[
                            "flex-1 text-left type-subheadline truncate",
                            on ? "text-label-primary" : "text-label-tertiary",
                          ].join(" ")}
                        >
                          {c.name}
                        </span>
                        {on && <Check size={14} style={{ color: c.color }} className="flex-none" />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="dp-card p-4">
              <h2 className="type-headline text-label-primary mb-2">Up next</h2>
              {upcoming.length === 0 ? (
                <p className="type-caption-1 text-label-tertiary py-1">Nothing scheduled.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {upcoming.map((ev) => (
                    <li key={ev.id}>
                      <button
                        onClick={() => editEvent(ev)}
                        className="w-full flex items-start gap-2.5 text-left p-1 -mx-1 rounded hover:bg-surface-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        <span
                          className="mt-1.5 h-2 w-2 rounded-full flex-none"
                          style={{ background: colorByKey[keyOf(ev)] ?? "var(--color-accent)" }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block type-subheadline text-label-primary truncate">{ev.title}</span>
                          <span className="block type-caption-1 text-label-tertiary">{whenLabel(ev)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <RemindersPanel />
            <SubscriptionsPanel />
          </aside>

          {/* Month grid / agenda */}
          <div className="order-1 lg:order-2">
            {isLoading && events.length === 0 ? (
              view === "month" ? (
                <div className="dp-card h-[560px] animate-pulse bg-surface-secondary" />
              ) : (
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="dp-card h-16 animate-pulse bg-surface-secondary" />
                  ))}
                </div>
              )
            ) : view === "month" ? (
              <MonthView
                events={visibleEvents}
                cursor={cursor}
                onSelectEvent={editEvent}
                onSelectDay={(day) => newEvent(day)}
              />
            ) : (
              <AgendaView events={visibleEvents} onSelect={editEvent} />
            )}
          </div>
        </div>

        <EventForm
          open={showForm}
          initial={editing}
          initialDate={newEventDate}
          onClose={() => setShowForm(false)}
          onSaved={() => refresh()}
        />
      </div>
    </div>
  );
}
