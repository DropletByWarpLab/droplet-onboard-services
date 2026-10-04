"use client";

// Narrow-screen calendar: the visible period as a dated list. Each item appears
// once, under the first day of its span that is on screen.

import type { JSX } from "react";
import { PmIcon } from "../icons";
import { PriorityFlag } from "../bits";
import type { PmWorkItem } from "../types";
import { formatDay, type DateOnly } from "./dateOnly";
import type { CalendarEntry } from "./layout";
import { describeSchedule, isOverdueOn, isTerminal, scheduleOf } from "./schedule";

export function Agenda({
  groups,
  today,
  onOpen,
}: {
  groups: Array<{ day: DateOnly; entries: CalendarEntry[] }>;
  today: DateOnly;
  onOpen: (item: PmWorkItem) => void;
}): JSX.Element {
  if (groups.length === 0) {
    return (
      <div className="pm-cal-agenda-empty">
        <strong>Nothing is scheduled in this period.</strong>
      </div>
    );
  }
  return (
    <div className="pm-cal-agenda">
      {groups.map(({ day, entries }) => (
        <section key={day} className="pm-cal-agenda-day" aria-label={formatDay(day, "weekday")}>
          <h3 className="pm-cal-agenda-head">
            {formatDay(day, "weekday")}
            {day === today && <span className="pm-cal-todaytag">Today</span>}
          </h3>
          <ul className="pm-cal-agenda-list">
            {entries.map(({ item }) => {
              const overdue = isOverdueOn(item, today);
              const sched = scheduleOf(item);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    className={"pm-cal-agenda-row" + (overdue ? " overdue" : "") + (isTerminal(item) ? " done" : "")}
                    aria-label={`${item.key}, ${item.name}, ${describeSchedule(sched)}${overdue ? ", overdue" : ""}`}
                    onClick={() => onOpen(item)}
                  >
                    <span className="pm-dot" style={{ background: item.state?.color ?? "var(--text-4)" }} />
                    <span className="pm-mono pm-cal-ukey">{item.key}</span>
                    <span className="pm-cal-agenda-title">{item.name}</span>
                    <PriorityFlag p={item.priority} size={13} />
                    {overdue && (
                      <span className="pm-cal-overdue">
                        <PmIcon name="alert" size={12} />
                        Overdue
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
