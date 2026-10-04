"use client";

// Calendar layout of a project (WARP-3523, brief §3 / §4.1 / §5):
//   * month and week grids; an item sits on its due date, an item with a start
//     date is a bar across the days it spans;
//   * drag a chip to another day to reschedule (PATCH, optimistic, rolls back);
//   * "Unscheduled" side panel to drag from — or a native date control on each
//     card, which is the keyboard / touch / screen-reader route;
//   * on a focused chip: ← → move it a day, ↑ ↓ (or Shift+← →) a week;
//   * below 720px the grid becomes a dated agenda list.
// Every date is a `DateOnly`: dragging across a DST change keeps the calendar date.

import "./calendar.css";
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
} from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { PmIcon } from "../icons";
import { EmptyBlock, Skel } from "../bits";
import type { Domain } from "../board";
import type { PmWorkItem } from "../types";
import {
  addDays,
  addMonths,
  dayOfMonth,
  diffDays,
  formatDay,
  monthOf,
  weekdayShort,
  type DateOnly,
} from "./dateOnly";
import {
  agendaGroups,
  layoutWeek,
  monthWeeks,
  toEntries,
  unscheduledItems,
  weekOf,
  type LaneCell,
} from "./layout";
import {
  describeSchedule,
  dueOn,
  isOverdueOn,
  isTerminal,
  scheduleOf,
  shiftSchedule,
  spanOf,
  type Schedule,
} from "./schedule";
import { useReschedule } from "./useReschedule";
import { useToday } from "./useToday";
import { useNarrow } from "./useNarrow";
import { UnscheduledPanel } from "./UnscheduledPanel";
import { Agenda } from "./Agenda";

type Mode = "month" | "week";

/** Month cells show this many lanes; the rest collapse into "+N more". */
const MONTH_LANES = 3;

export interface CalendarViewProps {
  /** The project's work items, already narrowed by the page's filters. */
  items: PmWorkItem[];
  domain: Domain;
  readOnly: boolean;
  onOpen: (item: PmWorkItem) => void;
  /** Revalidate the caller's data after a save; awaited before the optimistic state is dropped. */
  onChanged: () => Promise<unknown> | void;
  onNewItem?: () => void;
}

interface DragState {
  id: string;
  /** The day the pointer picked the chip up on (null for a card from the Unscheduled panel). */
  grab: DateOnly | null;
}

export function CalendarView({ items, domain, readOnly, onOpen, onChanged, onNewItem }: CalendarViewProps): JSX.Element {
  const today = useToday();
  const narrow = useNarrow();
  const hintId = useId();
  const rootRef = useRef<HTMLDivElement>(null);

  const [mode, setMode] = useState<Mode>("month");
  const [anchor, setAnchor] = useState<DateOnly>(() => today);
  const [announcement, setAnnouncement] = useState("");
  const [overDay, setOverDay] = useState<DateOnly | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [, bump] = useState(0);
  const drag = useRef<DragState | null>(null);
  const focusAfter = useRef<string | null>(null);

  const { withPending, reschedule } = useReschedule({ onSaved: onChanged, announce: setAnnouncement });
  const shown = useMemo(() => withPending(items), [withPending, items]);
  const entries = useMemo(() => toEntries(shown), [shown]);
  const unscheduled = useMemo(() => unscheduledItems(shown), [shown]);

  const weeks = useMemo(() => (mode === "month" ? monthWeeks(anchor) : [weekOf(anchor)]), [mode, anchor]);
  const rangeStart = weeks[0][0];
  const rangeEnd = weeks[weeks.length - 1][6];
  const layouts = useMemo(
    () => weeks.map((days) => layoutWeek(days, entries, mode === "month" ? MONTH_LANES : Number.POSITIVE_INFINITY)),
    [weeks, entries, mode],
  );

  // Keep keyboard focus on a chip that a nudge just moved to another cell: the
  // element is re-created in its new cell, which would otherwise drop focus on <body>.
  useLayoutEffect(() => {
    const id = focusAfter.current;
    if (!id || !rootRef.current) return;
    // One render is all a focus request gets, whether or not the chip is drawn
    // (it may sit under "+N more"): left pending, it would steal focus on some
    // later render, such as switching to the week view.
    focusAfter.current = null;
    const el = [...rootRef.current.querySelectorAll<HTMLElement>('[data-cal-first="true"]')].find(
      (n) => n.dataset.calItem === id,
    );
    el?.focus();
  });

  const title =
    mode === "month"
      ? formatDay(anchor, "monthYear")
      : `${formatDay(weeks[0][0], "short")} – ${formatDay(weeks[0][6], "long")}`;

  const step = (dir: 1 | -1) => setAnchor((a) => (mode === "month" ? addMonths(a, dir) : addDays(a, dir * 7)));

  const apply = (item: PmWorkItem, next: Schedule) => {
    void reschedule(item, next);
  };

  const nudge = (item: PmWorkItem, delta: number) => {
    const next = shiftSchedule(scheduleOf(item), delta);
    const span = spanOf(next);
    if (span && (span.start > rangeEnd || span.end < rangeStart)) setAnchor(span.start);
    focusAfter.current = item.id;
    void reschedule(item, next).then(() => {
      // The chip was re-created twice (optimistic move, then settle/rollback).
      focusAfter.current = item.id;
      bump((n) => n + 1);
    });
  };

  const clearDrag = () => {
    drag.current = null;
    setOverDay(null);
    setDragId(null);
  };

  const startDrag = (e: DragEvent<HTMLElement>, item: PmWorkItem, grab: DateOnly | null) => {
    drag.current = { id: item.id, grab };
    setDragId(item.id);
    if (e.dataTransfer) {
      // Firefox will not start a drag without data.
      e.dataTransfer.setData("text/plain", item.key);
      e.dataTransfer.effectAllowed = "move";
    }
  };

  const drop = (day: DateOnly) => {
    const d = drag.current;
    clearDrag();
    if (!d) return;
    const item = shown.find((i) => i.id === d.id);
    if (!item) return;
    const sched = scheduleOf(item);
    // A scheduled item moves by however far the pointer travelled from where it
    // picked the chip up (so grabbing day 3 of a 5-day bar keeps day 3 under the
    // pointer); an unscheduled one lands on the day as its due date.
    const next = spanOf(sched) && d.grab ? shiftSchedule(sched, diffDays(d.grab, day)) : dueOn(day);
    apply(item, next);
  };

  const onChipKeyDown = (e: KeyboardEvent<HTMLElement>, item: PmWorkItem) => {
    if (readOnly || e.altKey || e.ctrlKey || e.metaKey) return;
    let delta = 0;
    if (e.key === "ArrowLeft") delta = e.shiftKey ? -7 : -1;
    else if (e.key === "ArrowRight") delta = e.shiftKey ? 7 : 1;
    else if (e.key === "ArrowUp") delta = -7;
    else if (e.key === "ArrowDown") delta = 7;
    else return;
    e.preventDefault();
    nudge(item, delta);
  };

  const toolbar = (
    <div className="pm-cal-toolbar">
      <button type="button" className="pm-iconbtn" aria-label={mode === "month" ? "Previous month" : "Previous week"} onClick={() => step(-1)}>
        <ChevronLeft size={16} aria-hidden />
      </button>
      <button type="button" className="pm-iconbtn" aria-label={mode === "month" ? "Next month" : "Next week"} onClick={() => step(1)}>
        <ChevronRight size={16} aria-hidden />
      </button>
      <button type="button" className="pm-btn sm" onClick={() => setAnchor(today)}>
        Today
      </button>
      <h2 className="pm-cal-title" aria-live="polite">
        {title}
      </h2>
      <span className="pm-cal-spacer" />
      <div className="pm-pills" role="group" aria-label="Calendar range">
        {(["month", "week"] as const).map((m) => (
          <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m === "month" ? "Month" : "Week"}
          </button>
        ))}
      </div>
    </div>
  );

  if (domain === "loading") return <CalendarSkeleton />;
  if (domain === "error") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock icon="alert" tone="error" heading="Couldn't load this project." body="Check the appliance connection and try again." />
      </div>
    );
  }
  if (domain === "empty") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="inbox"
          heading="No work items in this project yet — add one to get started."
          cta={
            !readOnly && onNewItem ? (
              <button className="pm-btn primary" type="button" onClick={onNewItem}>
                <PmIcon name="plus" size={14} />
                New item
              </button>
            ) : undefined
          }
        />
      </div>
    );
  }
  if (domain === "filtered") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock icon="filter" heading="No work items match these filters." body="Try clearing a filter." />
      </div>
    );
  }

  const panel = (
    <UnscheduledPanel
      items={unscheduled}
      readOnly={readOnly}
      today={today}
      onOpen={onOpen}
      onSchedule={(item, day) => apply(item, dueOn(day))}
      onDragStart={(e, item) => startDrag(e, item, null)}
      onDragEnd={clearDrag}
    />
  );

  const hint =
    entries.length === 0 ? (
      <p className="pm-cal-hint">
        Nothing is scheduled yet{!readOnly && unscheduled.length > 0 ? " — drag an item from Unscheduled onto a day." : "."}
      </p>
    ) : null;

  return (
    <div className="pm-cal" ref={rootRef}>
      <div className="pm-cal-main">
        {toolbar}
        {hint}
        {narrow ? (
          <Agenda groups={agendaGroups(entries, rangeStart, rangeEnd)} today={today} onOpen={onOpen} />
        ) : (
          <div className="pm-cal-grid" role="group" aria-label={`Calendar, ${title}`}>
            <div className="pm-cal-dow" aria-hidden="true">
              {weeks[0].map((d) => (
                <span key={d}>{weekdayShort(d)}</span>
              ))}
            </div>
            {weeks.map((days, wi) => (
              <div key={days[0]} className="pm-cal-week">
                {days.map((day, col) => (
                  <DayCell
                    key={day}
                    day={day}
                    today={today}
                    outside={mode === "month" && monthOf(day) !== monthOf(anchor)}
                    tall={mode === "week"}
                    dropping={overDay === day}
                    lanes={layouts[wi].lanes.map((lane) => lane[col])}
                    overflow={layouts[wi].overflow[col]}
                    draggingId={dragId}
                    readOnly={readOnly}
                    hintId={hintId}
                    onOpen={onOpen}
                    onKeyDown={onChipKeyDown}
                    onDragStart={startDrag}
                    onDragEnd={clearDrag}
                    onDragOver={(e) => {
                      if (readOnly || !drag.current) return;
                      e.preventDefault();
                      if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
                      if (overDay !== day) setOverDay(day);
                    }}
                    onDrop={(e) => {
                      if (readOnly) return;
                      e.preventDefault();
                      drop(day);
                    }}
                    onMore={() => {
                      setAnchor(day);
                      setMode("week");
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
        {!readOnly && (
          <p id={hintId} className="sr-only">
            Press Enter to open. Use the arrow keys to move this item to another day: left and right move a day, up and down move a week.
          </p>
        )}
      </div>
      {panel}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

function DayCell({
  day,
  today,
  outside,
  tall,
  dropping,
  lanes,
  overflow,
  draggingId,
  readOnly,
  hintId,
  onOpen,
  onKeyDown,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onMore,
}: {
  day: DateOnly;
  today: DateOnly;
  outside: boolean;
  tall: boolean;
  dropping: boolean;
  lanes: Array<LaneCell | null>;
  overflow: number;
  draggingId: string | null;
  readOnly: boolean;
  hintId: string;
  onOpen: (item: PmWorkItem) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>, item: PmWorkItem) => void;
  onDragStart: (e: DragEvent<HTMLElement>, item: PmWorkItem, grab: DateOnly) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
  onMore: () => void;
}): JSX.Element {
  const isToday = day === today;
  return (
    <div
      className={"pm-cal-day" + (outside ? " is-outside" : "") + (isToday ? " is-today" : "") + (tall ? " is-tall" : "") + (dropping ? " is-drop" : "")}
      role="group"
      aria-label={formatDay(day, "weekday")}
      aria-current={isToday ? "date" : undefined}
      data-date={day}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="pm-cal-dayhead">
        <span className="pm-cal-daynum">{dayOfMonth(day)}</span>
        {isToday && <span className="pm-cal-todaytag">Today</span>}
      </div>
      {lanes.map((cell, lane) =>
        cell ? (
          <Chip
            key={lane}
            cell={cell}
            day={day}
            today={today}
            dragging={draggingId === cell.entry.item.id}
            readOnly={readOnly}
            hintId={hintId}
            onOpen={onOpen}
            onKeyDown={onKeyDown}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ) : (
          <span key={lane} className="pm-cal-slot" aria-hidden="true" />
        ),
      )}
      {overflow > 0 && (
        <button type="button" className="pm-cal-more" aria-label={`${overflow} more on ${formatDay(day, "weekday")}. Show this week.`} onClick={onMore}>
          +{overflow} more
        </button>
      )}
    </div>
  );
}

function Chip({
  cell,
  day,
  today,
  dragging,
  readOnly,
  hintId,
  onOpen,
  onKeyDown,
  onDragStart,
  onDragEnd,
}: {
  cell: LaneCell;
  day: DateOnly;
  today: DateOnly;
  dragging: boolean;
  readOnly: boolean;
  hintId: string;
  onOpen: (item: PmWorkItem) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>, item: PmWorkItem) => void;
  onDragStart: (e: DragEvent<HTMLElement>, item: PmWorkItem, grab: DateOnly) => void;
  onDragEnd: () => void;
}): JSX.Element {
  const item = cell.entry.item;
  const overdue = isOverdueOn(item, today);
  const className =
    "pm-cal-chip" +
    ` seg-${cell.segment}` +
    (overdue ? " overdue" : "") +
    (isTerminal(item) ? " done" : "") +
    (dragging ? " is-dragging" : "");
  const style = overdue ? undefined : ({ "--chip-accent": item.state?.color ?? "var(--text-4)" } as CSSProperties);
  const common = {
    className,
    style,
    draggable: !readOnly,
    "data-cal-item": item.id,
    onDragStart: (e: DragEvent<HTMLElement>) => onDragStart(e, item, day),
    onDragEnd,
    onClick: () => onOpen(item),
  };

  // Only the first cell of an item in a week is a control; the other days of the
  // bar are the same item drawn wider (mouse-draggable, hidden from assistive tech).
  if (!cell.first) return <span {...common} aria-hidden="true" />;

  const name = `${item.key}, ${item.name}, ${describeSchedule(scheduleOf(item))}${overdue ? ", overdue" : ""}${
    item.state ? `, ${item.state.name}` : ""
  }`;
  return (
    <button
      {...common}
      type="button"
      data-cal-first="true"
      aria-label={name}
      aria-describedby={readOnly ? undefined : hintId}
      onKeyDown={(e) => onKeyDown(e, item)}
    >
      <span className="pm-dot" style={{ background: item.state?.color ?? "var(--text-4)" }} />
      <span className="pm-mono key">{item.key}</span>
      <span className="ttl">{item.name}</span>
      {overdue && <PmIcon name="alert" size={12} />}
    </button>
  );
}

function CalendarSkeleton(): JSX.Element {
  return (
    <div className="pm-cal" aria-busy="true">
      <div className="pm-cal-main">
        <div className="pm-cal-toolbar">
          <Skel w={96} h={30} r={8} />
          <Skel w={160} h={18} />
        </div>
        <div className="pm-cal-grid">
          {Array.from({ length: 5 }).map((_, w) => (
            <div key={w} className="pm-cal-week">
              {Array.from({ length: 7 }).map((__, d) => (
                <div key={d} className="pm-cal-day">
                  <Skel w={20} h={12} style={{ margin: "4px 8px" }} />
                  {(w + d) % 3 === 0 && <Skel w="80%" h={22} r={6} style={{ margin: "0 4px" }} />}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

