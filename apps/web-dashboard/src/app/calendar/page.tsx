"use client";

import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { useCalendarEvents, type CalendarEvent } from "@/lib/hooks/useCalendar";
import { AgendaView } from "@/components/calendar/AgendaView";
import { EventForm } from "@/components/calendar/EventForm";
import { RemindersPanel } from "@/components/calendar/RemindersPanel";
import { SubscriptionsPanel } from "@/components/calendar/SubscriptionsPanel";

/** Default view shows the next 30 days. The agenda is grouped by day so
 *  this read well even with a busy schedule. A month-grid view is a
 *  follow-up — the user explicitly asked for "one app" not "feature parity
 *  with Google Calendar," and the grid is the largest single component to
 *  build. */
export default function CalendarPage() {
  const range = {
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

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="type-large-title text-label-primary">Calendar</h1>
          <p className="type-subheadline text-label-tertiary mt-1">
            {events.length > 0
              ? `${events.length} event${events.length !== 1 ? "s" : ""} in the next 30 days`
              : "Your agenda is clear"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refresh()}
            disabled={isLoading}
            className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
          >
            <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
            <span className="type-subheadline">Refresh</span>
          </button>
          <button
            onClick={newEvent}
            className="dp-btn-primary flex items-center gap-2 px-3 py-2 rounded-lg"
          >
            <Plus size={16} />
            <span className="type-subheadline">New event</span>
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6">
        <div>
          {isLoading && events.length === 0 ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="dp-card h-16 animate-pulse bg-surface-secondary" />
              ))}
            </div>
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
  );
}
