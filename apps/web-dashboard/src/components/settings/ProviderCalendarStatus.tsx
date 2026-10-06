"use client";

import { CalendarDays } from "lucide-react";

export interface ProviderCalendarView {
  state: "DISCONNECTED" | "WAITING" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";
  lastSyncAt: string | null;
  lastError: string | null;
  eventCount?: number;
}

/** OAuth approval and a completed calendar import are separate facts. */
export function ProviderCalendarStatus({ provider, view, onReconnect, onRetry, busy }: {
  provider: "Google" | "Outlook";
  view: ProviderCalendarView;
  onReconnect: () => void;
  onRetry: () => void;
  busy: boolean;
}) {
  if (view.state === "DISCONNECTED") return null;
  const syncDate = view.lastSyncAt ? new Date(view.lastSyncAt) : null;
  const ready = view.state === "CONNECTED" && syncDate && !Number.isNaN(syncDate.getTime());
  return <div className="space-y-2" data-testid={`${provider.toLowerCase()}-calendar-status`}>
    <p className="type-subheadline flex items-center gap-2" role="status"><CalendarDays size={16} aria-hidden="true" />
      {ready ? `${provider} calendar is ready` : view.state === "NEEDS_RECONNECT" ? `${provider} calendar needs reconnect` : view.state === "ERROR" ? `${provider} calendar could not be read` : "Waiting for first calendar sync…"}
    </p>
    {ready && <p className="type-caption-1">{typeof view.eventCount === "number" ? `${view.eventCount.toLocaleString()} ${view.eventCount === 1 ? "event" : "events"} · ` : ""}Last synced {syncDate!.toLocaleString()}. Imported events are read-only.</p>}
    {ready && <a className="btn" href="/calendar">Open Calendar</a>}
    {view.state === "NEEDS_RECONNECT" && <button className="btn" disabled={busy} onClick={onReconnect}>Reconnect {provider} calendar</button>}
    {view.state === "ERROR" && <button className="btn" disabled={busy} onClick={onRetry}>Retry calendar status</button>}
  </div>;
}
