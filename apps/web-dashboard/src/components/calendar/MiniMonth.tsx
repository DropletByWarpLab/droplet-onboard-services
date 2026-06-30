"use client";

import { useMemo } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { monthGridDays } from "./MonthView";
import { dayKey } from "@/lib/calendar";

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

interface Props {
  /** Any date within the month to display. */
  cursor: Date;
  /** Day-keys (YYYY-MM-DD) with at least one visible event — rendered with a dot. */
  eventDays?: Set<string>;
  /** Navigate the displayed month / jump the main grid to a day. */
  onCursor: (d: Date) => void;
  /** Called when the prev/next chevrons change the displayed month. When
   *  omitted, the chevrons fall back to `onCursor`. Separating the two lets
   *  the parent distinguish "user navigated the mini-month header" from
   *  "user clicked a day cell" without adding heuristics inside MiniMonth. */
  onMonthNav?: (d: Date) => void;
}

/** Compact month picker for the calendar left rail. Mirrors the design-system
 *  handoff's `CalMini`, but driven by the real cursor + event set rather than
 *  fixtures. Navigation is shared with the main month grid via `onCursor`. */
export function MiniMonth({ cursor, eventDays, onCursor, onMonthNav }: Props) {
  const navCursor = onMonthNav ?? onCursor;
  const days = useMemo(() => monthGridDays(cursor), [cursor]);
  const month = cursor.getMonth();
  const todayKey = dayKey(new Date());
  const label = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="dp-card p-3.5">
      <div className="flex items-center justify-between mb-2">
        <span className="type-subheadline font-semibold text-label-primary">{label}</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => navCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            aria-label="Previous month"
            className="inline-flex items-center justify-center h-6 w-6 rounded text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            onClick={() => navCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            aria-label="Next month"
            className="inline-flex items-center justify-center h-6 w-6 rounded text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
          >
            <ChevronRight size={13} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {DOW.map((d, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="text-center type-caption-2 text-label-tertiary font-semibold py-0.5"
          >
            {d}
          </div>
        ))}
        {days.map((d) => {
          const k = dayKey(d);
          const inMonth = d.getMonth() === month;
          const isToday = k === todayKey;
          const hasEvents = eventDays?.has(k) ?? false;
          return (
            <button
              key={k}
              type="button"
              onClick={() => onCursor(new Date(d))}
              aria-label={d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
              aria-current={isToday ? "date" : undefined}
              className={[
                "relative text-center type-caption-1 tabular-nums py-1 rounded transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                isToday
                  ? "bg-accent text-white font-semibold"
                  : inMonth
                    ? "text-label-secondary hover:bg-surface-secondary"
                    : "text-label-quaternary hover:bg-surface-secondary",
              ].join(" ")}
            >
              {d.getDate()}
              {hasEvents && !isToday && (
                <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full bg-accent" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
