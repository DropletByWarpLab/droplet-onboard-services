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
  /** Jump the main grid to a day (the Agenda view's pick — WARP-944). When
   *  omitted, the day grid renders DISPLAY-ONLY: cells are inert plain
   *  elements with no click/hover/focus affordance (WARP-1904 — the Month
   *  view's day click had no visible effect, so it must not look clickable). */
  onCursor?: (d: Date) => void;
  /** Called when the prev/next chevrons change the displayed month. When
   *  omitted, the chevrons fall back to `onCursor`. Separating the two lets
   *  the parent distinguish "user navigated the mini-month header" from
   *  "user clicked a day cell" without adding heuristics inside MiniMonth. */
  onMonthNav?: (d: Date) => void;
}

/** Compact month card for the calendar left rail. Mirrors the design-system
 *  handoff's `CalMini`, but driven by the real cursor + event set rather than
 *  fixtures. Day cells are interactive only when `onCursor` is wired
 *  (Agenda view); otherwise the grid is informational (WARP-1904). */
export function MiniMonth({ cursor, eventDays, onCursor, onMonthNav }: Props) {
  const navCursor = onMonthNav ?? onCursor;
  const days = useMemo(() => monthGridDays(cursor), [cursor]);
  const month = cursor.getMonth();
  const todayKey = dayKey(new Date());
  const label = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="card" style={{ padding: "14px" }}>
      <div className="flex items-center justify-between mb-2">
        <span className="type-subheadline font-semibold" style={{ color: "var(--text)" }}>{label}</span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => navCursor?.(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
            aria-label="Previous month"
            className="inline-flex items-center justify-center h-6 w-6 max-lg:h-11 max-lg:w-11 rounded text-[color:var(--text-muted)] hover:text-[color:var(--text)] hover:bg-[var(--hover)] transition-colors"
          >
            <ChevronLeft size={13} />
          </button>
          <button
            onClick={() => navCursor?.(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
            aria-label="Next month"
            className="inline-flex items-center justify-center h-6 w-6 max-lg:h-11 max-lg:w-11 rounded text-[color:var(--text-muted)] hover:text-[color:var(--text)] hover:bg-[var(--hover)] transition-colors"
          >
            <ChevronRight size={13} />
          </button>
        </div>
      </div>

      {/* The gap is set here rather than left to `gap-0.5` because this grid
          renders inside `.droplet-shell`, whose `.grid { gap: 16px }` primitive
          is specificity (0,2,0) and silently beats the (0,1,0) utility — the
          same collision class as WARP-1792. Measured at 375px the 16px gap
          squeezed each day cell to 29.5px instead of 41.6px. Inline is the
          idiom already used for this card's padding, and it is the only thing
          that outranks the primitive without restyling the 58 other files that
          ask for a grid gap this way (tracked separately). */}
      <div className="grid grid-cols-7" style={{ gap: "2px" }}>
        {DOW.map((d, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="text-center type-caption-2 font-semibold py-0.5"
            style={{ color: "var(--text-muted)" }}
          >
            {d}
          </div>
        ))}
        {days.map((d) => {
          const k = dayKey(d);
          const inMonth = d.getMonth() === month;
          const isToday = k === todayKey;
          const hasEvents = eventDays?.has(k) ?? false;
          const cellStyle = isToday
            ? { background: "var(--brand)", color: "#fff" }
            : { color: inMonth ? "var(--text-muted)" : "var(--text-faint)" };
          const dot = hasEvents && !isToday && (
            <span
              className="absolute bottom-0.5 left-1/2 -translate-x-1/2 h-1 w-1 rounded-full"
              style={{ background: "var(--brand)" }}
            />
          );
          // WARP-1904 — no pick handler ⇒ the cell is informational. Render a
          // plain <div> (not a disabled button) so keyboard/AT users never land
          // on a dead control: no button role, no tab stop, no hover state, no
          // pointer cursor. Today's highlight + the event dot are kept. The
          // flex centering replicates the button's UA vertical centering so the
          // grid stays pixel-identical, incl. the 44px-tall phone cells.
          if (!onCursor) {
            return (
              <div
                key={k}
                aria-current={isToday ? "date" : undefined}
                className={[
                  "relative flex items-center justify-center type-caption-1 tabular-nums py-1 rounded max-lg:min-h-[44px]",
                  isToday ? "font-semibold" : "",
                ].join(" ")}
                style={cellStyle}
              >
                {d.getDate()}
                {dot}
              </div>
            );
          }
          return (
            <button
              key={k}
              type="button"
              onClick={() => onCursor(new Date(d))}
              aria-label={d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
              aria-current={isToday ? "date" : undefined}
              className={[
                // max-lg:min-h-[44px] — 24px tall on a phone, under the 44px
                // touch minimum (04-coding-standards/mobile-web-layout.md).
                "relative text-center type-caption-1 tabular-nums py-1 rounded transition-colors max-lg:min-h-[44px]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]",
                isToday
                  ? "font-semibold"
                  : "hover:bg-[var(--hover)]",
              ].join(" ")}
              style={cellStyle}
            >
              {d.getDate()}
              {dot}
            </button>
          );
        })}
      </div>
    </div>
  );
}
