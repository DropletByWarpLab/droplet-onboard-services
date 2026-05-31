"use client";

import { useState } from "react";
import { Plus, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { Topbar } from "@/components/Topbar";
import { useCalendarEvents, type CalendarEvent } from "@/lib/hooks/useCalendar";
import { AgendaView } from "@/components/calendar/AgendaView";
import { MonthView, monthGridRange } from "@/components/calendar/MonthView";
import { EventForm } from "@/components/calendar/EventForm";
import { RemindersPanel } from "@/components/calendar/RemindersPanel";
import { SubscriptionsPanel } from "@/components/calendar/SubscriptionsPanel";

type View = "month" | "agenda";

/** Calendar surface. Defaults to the month grid — the at-a-glance view people
 *  expect from a calendar — with an Agenda list available via the toggle for a
 *  linear "what's next" read. The fetched range follows the active view. */
export default function CalendarPage() {
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => new Date());

  const range =
    view === "month"
      ? monthGridRange(cursor)
      : {
          from: new Date(new Date().setHours(0, 0, 0, 0)),
          to: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        };

  const { events, refresh, isLoading } = useCalendarEvents(range);

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);

  function newEvent() {
    setEditing(null);
    setShowForm(true);
  }
  function editEvent(ev: CalendarEvent) {
    setEditing(ev);
    setShowForm(true);
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
      <button onClick={newEvent} className="dp-btn-primary flex items-center gap-1.5 px-3 h-9 rounded-md">
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

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
          <div>
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
                events={events}
                cursor={cursor}
                onSelectEvent={editEvent}
                onSelectDay={() => newEvent()}
              />
            ) : (
              <AgendaView events={events} onSelect={editEvent} />
            )}
          </div>

          <aside className="flex flex-col gap-4">
            <RemindersPanel />
            <SubscriptionsPanel />
          </aside>
        </div>

        <EventForm
          open={showForm}
          initial={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => refresh()}
        />
      </div>
    </div>
  );
}
