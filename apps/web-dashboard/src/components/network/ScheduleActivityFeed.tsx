"use client";
import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ScheduleEvent } from "@/lib/types";
import { useScheduleEvents } from "@/lib/hooks/useScheduleEvents";
import { useSchedules } from "@/lib/hooks/useSchedules";
import { useNetworkDevices } from "@/lib/hooks/useNetworkDevices";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";

function formatClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

export function ScheduleActivityFeed() {
  const [expanded, setExpanded] = useState(false);
  const eventsSwr = useScheduleEvents({ enabled: expanded });
  const schedulesSwr = useSchedules();
  const devicesSwr = useNetworkDevices();
  const groupsSwr = useNetworkGroups();

  const events = eventsSwr.data?.events ?? [];
  // Ensure newest-first ordering even if the API later changes.
  const sorted = events
    .slice()
    .sort(
      (a, b) =>
        new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
    );

  function labelFor(ev: ScheduleEvent): string {
    if (ev.scheduleId) {
      const s = schedulesSwr.data?.schedules.find((x) => x.id === ev.scheduleId);
      return s?.name ?? "schedule";
    }
    if (ev.overrideId) return "override";
    return "manual";
  }

  function subjectFor(ev: ScheduleEvent): string {
    if (ev.subjectType === "group" && ev.groupId) {
      const g = groupsSwr.data?.groups.find((x) => x.id === ev.groupId);
      return g?.name ?? "group";
    }
    if (ev.subjectType === "device" && ev.deviceMac) {
      const d = devicesSwr.data?.devices.find(
        (x) => x.mac.toLowerCase() === ev.deviceMac!.toLowerCase(),
      );
      return d?.displayName ?? d?.hostname ?? ev.deviceMac;
    }
    return "—";
  }

  return (
    <section aria-labelledby="activity-heading" className="space-y-2">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-2 text-[color:var(--text)]"
      >
        <ChevronRight
          className={`w-4 h-4 transition-transform ${expanded ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
        <h2 id="activity-heading" className="type-title-3">
          Recent activity
        </h2>
      </button>

      {expanded && (
        <div className="card space-y-2">
          {eventsSwr.isLoading ? (
            <p className="type-footnote text-[color:var(--text-muted)]">
              Loading…
            </p>
          ) : sorted.length === 0 ? (
            <p className="type-subheadline text-[color:var(--text-muted)]">
              No activity in the last 7 days
            </p>
          ) : (
            <ul className="space-y-1">
              {sorted.map((ev) => (
                <li
                  key={ev.id}
                  className="type-subheadline text-[color:var(--text-muted)]"
                >
                  <span className="text-[color:var(--text-muted)]">
                    {formatClock(ev.occurredAt)}
                  </span>{" "}
                  · {labelFor(ev)} ·{" "}
                  <span
                    className={
                      ev.transition === "blocked"
                        ? "text-system-red"
                        : "text-system-green"
                    }
                  >
                    {ev.transition}
                  </span>{" "}
                  {subjectFor(ev)}
                </li>
              ))}
            </ul>
          )}
          <p className="type-caption-2 text-[color:var(--text-muted)] pt-2 border-t border-[var(--card-bd)]">
            Showing activity from the last 7 days
          </p>
        </div>
      )}
    </section>
  );
}
