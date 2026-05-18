"use client";

import { useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Topbar } from "@/components/Topbar";
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

  const status = events.length === 0
    ? { tone: "neutral" as const, label: "Agenda clear" }
    : { tone: "ok" as const, label: `${events.length} event${events.length === 1 ? "" : "s"} next 30 days` };

  const actions = (
    <>
      <button
        onClick={() => refresh()}
        disabled={isLoading}
        className="
          inline-flex items-center justify-center h-9 w-9 rounded-md
          text-label-tertiary hover:text-label-primary hover:bg-surface-secondary
          transition-colors
        "
        aria-label="Refresh calendar"
        title="Refresh"
      >
        <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
      </button>
      <button
        onClick={newEvent}
        className="dp-btn-primary flex items-center gap-1.5 px-3 h-9 rounded-md"
      >
        <Plus size={15} />
        <span className="type-subheadline">New event</span>
      </button>
    </>
  );

  return (
    <div>
      <Topbar
        crumbs={[
          { label: "Workspace", href: "/" },
          { label: "Calendar" },
        ]}
        status={status}
        actions={actions}
      />

      <div className="p-6">
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
    </div>
  );
}
