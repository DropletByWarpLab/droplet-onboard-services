"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Plus,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Check,
  Calendar as CalendarIcon,
  FileText,
  Clock,
  MapPin,
  X,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import {
  useCalendarEvents,
  useCalendarSources,
  deleteEvent,
  type CalendarEvent,
} from "@/lib/hooks/useCalendar";
import {
  dayKey,
  parseDateParam,
  paletteColor,
  eventVisibilityKey,
  compareByStart,
  EXTERNAL_KEY,
  EXTERNAL_COLOR,
} from "@/lib/calendar";
import { AgendaView } from "@/components/calendar/AgendaView";
import { MonthView, monthGridRange, eventsByDay } from "@/components/calendar/MonthView";
import { MiniMonth } from "@/components/calendar/MiniMonth";
import { EventForm } from "@/components/calendar/EventForm";
import { RemindersPanel } from "@/components/calendar/RemindersPanel";
import { SubscriptionsPanel } from "@/components/calendar/SubscriptionsPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";

type View = "month" | "agenda";
type ReportScope = "day" | "week" | "month";

function whenLabel(ev: CalendarEvent): string {
  const d = new Date(ev.startsAt);
  const sameDay = d.toDateString() === new Date().toDateString();
  const datePart = sameDay
    ? "Today"
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (ev.allDay) return `${datePart} · All day`;
  return `${datePart} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Full "when" sentence for the event-detail sheet, e.g.
 *  "Monday, June 8 · 2:00 – 3:00 PM" or "Saturday, June 13 · All day". */
function eventWhen(ev: CalendarEvent): string {
  const s = new Date(ev.startsAt);
  const datePart = s.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  if (ev.allDay) return `${datePart} · All day`;
  const start = shortTime(ev.startsAt);
  const end = ev.endsAt ? shortTime(ev.endsAt) : null;
  return end ? `${datePart} · ${start} – ${end}` : `${datePart} · ${start}`;
}

/** The [from, to] window + heading for a Day/Week/Month schedule report. Day and
 *  Week anchor on today; Month anchors on the visible cursor. */
function reportWindow(scope: ReportScope, cursor: Date): { from: Date; to: Date; title: string } {
  const now = new Date();
  if (scope === "day") {
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    const to = new Date(now); to.setHours(23, 59, 59, 999);
    return { from, to, title: now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) };
  }
  if (scope === "week") {
    const from = new Date(now); from.setDate(now.getDate() - now.getDay()); from.setHours(0, 0, 0, 0);
    const to = new Date(from); to.setDate(from.getDate() + 6); to.setHours(23, 59, 59, 999);
    return {
      from,
      to,
      title: `Week of ${from.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`,
    };
  }
  const from = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const to = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 23, 59, 59, 999);
  return { from, to, title: cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
}

/** Calendar surface. Month grid (the at-a-glance view) with an Agenda toggle,
 *  fronted by a left rail — mini-month, a per-calendar visibility list, and an
 *  "Up next" digest — all in the indigo page shell. Events open an iOS-style
 *  detail sheet (Edit / Remove); a Day/Week/Month schedule report is derived
 *  from the loaded events. All driven by real `/api/calendar` data; the fetched
 *  range follows the active view. */
export default function CalendarPage() {
  // WARP-1131 — Home calendar-widget deep link: `?date=YYYY-MM-DD` seeds the
  // month cursor and the selected day. Read once on mount (useState initial
  // values only); a malformed or absent param falls back to today, unselected.
  const searchParams = useSearchParams();
  const linkedDate = parseDateParam(searchParams?.get("date"));
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => linkedDate ?? new Date());
  // Day clicked in the mini-month while in Agenda view — drives the scroll-to +
  // highlight of that day's section. Also seeded by the `?date=` deep link:
  // unlike the WARP-944 stale-selection case, a deep-linked day WAS explicitly
  // picked by the user (on the Home widget), so highlighting it in a later
  // Agenda switch is intended.
  const [selectedKey, setSelectedKey] = useState<string | undefined>(
    linkedDate ? dayKey(linkedDate) : undefined,
  );
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const { toast } = useToast();

  // Fetch window for the active view. Memoized off the cursor's month so the
  // SWR key is stable across renders (the old agenda range rebuilt `Date.now()`
  // every render, churning the cache) and — crucially — so the agenda follows
  // the navigated month instead of being pinned to a fixed today+30d window.
  // The agenda covers the visible month plus the rest of the year ahead, so
  // "up next" style scrolling still works while events for the viewed month
  // actually populate.
  const range = useMemo(() => {
    if (view === "month") return monthGridRange(cursor);
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 0, 0, 0, 0);
    // Floor at today so the "Up next" rail always has data even when the
    // user has navigated the mini-month to a future month: events between
    // now and the cursor's month-start would otherwise fall outside [from, to].
    const todayMidnight = new Date(); todayMidnight.setHours(0, 0, 0, 0);
    const from = monthStart <= todayMidnight ? monthStart : todayMidnight;
    const to = new Date(cursor.getFullYear(), cursor.getMonth() + 12, 0, 23, 59, 59, 999);
    return { from, to };
  }, [view, cursor]);

  const { events, refresh, isLoading } = useCalendarEvents(range);
  const { sources } = useCalendarSources();

  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CalendarEvent | null>(null);
  const [newEventDate, setNewEventDate] = useState<Date | undefined>(undefined);

  // iOS-style read-only detail sheet + its remove confirmation.
  const [detail, setDetail] = useState<CalendarEvent | null>(null);
  const [removeTarget, setRemoveTarget] = useState<CalendarEvent | null>(null);
  const detailHeadingId = useId();

  // Day/Week/Month schedule report sheet.
  const [showReport, setShowReport] = useState(false);
  const [reportScope, setReportScope] = useState<ReportScope>("week");
  const reportHeadingId = useId();

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
  const nameByKey = useMemo(
    () => Object.fromEntries(calendars.map((c) => [c.key, c.name])),
    [calendars],
  );
  const colorOf = useCallback(
    (e: CalendarEvent) => colorByKey[keyOf(e)] ?? "var(--color-accent)",
    [colorByKey, keyOf],
  );

  const visibleEvents = useMemo(
    () => events.filter((e) => !hidden.has(keyOf(e))),
    [events, hidden, keyOf],
  );

  // Day-keys with at least one visible event — drives the mini-month dots.
  // Reuses the shared `eventsByDay` (single source of truth for the multi-day
  // span bucketing) instead of a hand-rolled copy.
  const eventDays = useMemo(
    () => new Set(eventsByDay(visibleEvents).keys()),
    [visibleEvents],
  );

  const upcoming = useMemo(() => {
    const now = Date.now();
    return visibleEvents
      .filter((e) => new Date(e.endsAt || e.startsAt).getTime() >= now)
      .sort(compareByStart)
      .slice(0, 5);
  }, [visibleEvents]);

  // Schedule report: filter the loaded, visible events to the report window
  // (overlap test) and group them by local day. Derived entirely client-side
  // from already-fetched data — no separate endpoint.
  const report = useMemo(() => {
    const { from, to, title } = reportWindow(reportScope, cursor);
    const inWindow = visibleEvents
      .filter((e) => {
        const s = new Date(e.startsAt).getTime();
        const end = new Date(e.endsAt || e.startsAt).getTime();
        return end >= from.getTime() && s <= to.getTime();
      })
      .sort(compareByStart);
    const buckets = new Map<string, CalendarEvent[]>();
    for (const e of inWindow) {
      const k = dayKey(new Date(e.startsAt));
      const b = buckets.get(k);
      if (b) b.push(e);
      else buckets.set(k, [e]);
    }
    const groups = Array.from(buckets.entries()).map(([k, evs]) => ({
      key: k,
      label: new Date(k + "T00:00:00").toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }),
      events: evs,
    }));
    return { title, total: inWindow.length, groups };
  }, [reportScope, cursor, visibleEvents]);

  function newEvent(date?: Date) {
    setEditing(null);
    setNewEventDate(date);
    setShowForm(true);
  }
  const openDetail = useCallback((ev: CalendarEvent) => setDetail(ev), []);
  function editFromDetail() {
    if (!detail) return;
    setEditing(detail);
    setNewEventDate(undefined);
    setDetail(null);
    setShowForm(true);
  }
  async function confirmRemove() {
    const ev = removeTarget;
    if (!ev) return;
    try {
      await deleteEvent(ev.id);
      setRemoveTarget(null);
      toast("Event removed.", "success");
      refresh();
    } catch {
      toast("Couldn't remove the event.", "error");
      throw new Error("remove failed");
    }
  }
  function toggleCal(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Escape closes whichever sheet is open (detail takes precedence).
  useEffect(() => {
    if (!detail && !showReport) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (detail) setDetail(null);
      else if (showReport) setShowReport(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [detail, showReport]);

  const monthLabel = cursor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  // Toolbar nav is an implicit deselection: clear `selectedKey` so a stale
  // scroll target doesn't yank the agenda back after navigating.
  const prevMonth = () => {
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() - 1, 1));
    setSelectedKey(undefined);
  };
  const nextMonth = () => {
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + 1, 1));
    setSelectedKey(undefined);
  };
  const goToday = () => {
    setCursor(new Date());
    setSelectedKey(undefined);
  };

  // Mini-month day click: move the cursor (drives the month grid + the agenda
  // fetch window) and, ONLY in Agenda view, mark the picked day so the agenda
  // scrolls to + highlights it. `selectedKey` is agenda-only context: setting it
  // from Month view (where the agenda isn't rendered) would make a later switch
  // to Agenda auto-scroll to a stale date the user never selected there.
  // The previous build set neither — picking a date did nothing (WARP-944).
  const pickDay = useCallback(
    (d: Date) => {
      setCursor(d);
      setSelectedKey(view === "agenda" ? dayKey(d) : undefined);
    },
    [view],
  );

  const eventCount = events.length;
  const sub =
    eventCount === 0
      ? view === "month"
        ? "No events this month — add one to get started."
        : "Your agenda is clear."
      : `${eventCount} event${eventCount === 1 ? "" : "s"} in view across ${calendars.length} calendar${calendars.length === 1 ? "" : "s"}.`;

  const actions = (
    <>
      <button
        onClick={() => setShowReport(true)}
        className="btn ghost"
        type="button"
      >
        <FileText size={15} />
        Report
      </button>
      <button
        onClick={() => refresh()}
        disabled={isLoading}
        className="icon-btn"
        aria-label="Refresh calendar"
        title="Refresh"
        type="button"
      >
        <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
      </button>
      <button onClick={() => newEvent()} className="btn primary" type="button">
        <Plus size={15} />
        New event
      </button>
    </>
  );

  return (
    <ShellPage
      icon={<CalendarIcon size={15} />}
      label="Calendar"
      title="Calendar"
      sub={sub}
      actions={actions}
    >
      {/* Toolbar: month nav (month view only) + view toggle */}
      <div className="toolbar" style={{ justifyContent: "space-between" }}>
        <div className="flex items-center gap-2" style={{ minHeight: 36 }}>
          {view === "month" && (
            <>
              <button onClick={prevMonth} aria-label="Previous month" className="icon-btn" type="button">
                <ChevronLeft size={18} />
              </button>
              <h2
                className="tabular-nums"
                style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", minWidth: "9.5rem", textAlign: "center" }}
              >
                {monthLabel}
              </h2>
              <button onClick={nextMonth} aria-label="Next month" className="icon-btn" type="button">
                <ChevronRight size={18} />
              </button>
              <button onClick={goToday} className="btn sm" type="button" style={{ marginLeft: 4 }}>
                Today
              </button>
            </>
          )}
        </div>

        <div className="pills" role="group" aria-label="Calendar view">
          {(["month", "agenda"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              aria-pressed={view === v}
              className={view === v ? "active" : ""}
              style={{ textTransform: "capitalize" }}
              type="button"
            >
              {v}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-6">
        {/* Left rail — mini-month, calendars, up next, reminders, subscriptions */}
        <aside className="flex flex-col gap-4 order-2 lg:order-1">
          <MiniMonth
            cursor={cursor}
            eventDays={eventDays}
            onCursor={pickDay}
            onMonthNav={(d) => { setCursor(d); setSelectedKey(undefined); }}
          />

          <div className="card">
            <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: "0 0 8px" }}>Calendars</h2>
            <ul className="flex flex-col -mx-1">
              {calendars.map((c) => {
                const on = !hidden.has(c.key);
                return (
                  <li key={c.key}>
                    <button
                      onClick={() => toggleCal(c.key)}
                      aria-pressed={on}
                      className="w-full flex items-center gap-2.5 px-1 py-1.5 max-lg:min-h-[44px] rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      style={{ background: "transparent" }}
                      type="button"
                    >
                      <span
                        className="h-3 w-3 rounded-[3px] flex-none transition-opacity"
                        style={{ background: c.color, opacity: on ? 1 : 0.3 }}
                      />
                      <span
                        className="flex-1 text-left truncate"
                        style={{ fontSize: 13, color: on ? "var(--text)" : "var(--text-muted)" }}
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

          <div className="card">
            <h2 style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", margin: "0 0 8px" }}>Up next</h2>
            {upcoming.length === 0 ? (
              <p style={{ fontSize: 12.5, color: "var(--text-muted)", padding: "4px 0" }}>Nothing scheduled.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {upcoming.map((ev) => (
                  <li key={ev.id}>
                    <button
                      onClick={() => openDetail(ev)}
                      className="w-full flex items-start gap-2.5 text-left p-1 -mx-1 rounded hover:bg-[var(--hover)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                      type="button"
                    >
                      <span
                        className="mt-1.5 h-2 w-2 rounded-full flex-none"
                        style={{ background: colorOf(ev) }}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate" style={{ fontSize: 13, color: "var(--text)" }}>{ev.title}</span>
                        <span className="block" style={{ fontSize: 12, color: "var(--text-muted)" }}>{whenLabel(ev)}</span>
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
              <div className="card" style={{ height: 560 }} />
            ) : (
              <div className="flex flex-col gap-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="card" style={{ height: 64 }} />
                ))}
              </div>
            )
          ) : view === "month" ? (
            <MonthView
              events={visibleEvents}
              cursor={cursor}
              onSelectEvent={openDetail}
              onSelectDay={(day) => newEvent(day)}
              colorOf={colorOf}
            />
          ) : (
            <AgendaView
              events={visibleEvents}
              onSelect={openDetail}
              colorOf={colorOf}
              selectedKey={selectedKey}
            />
          )}

          {/* Color legend — at-a-glance key beside the grid; chips toggle the
              same visibility state as the rail "Calendars" list. */}
          {calendars.length > 1 && (
            <div className="cal-legend">
              {calendars.map((c) => {
                const on = !hidden.has(c.key);
                return (
                  <button
                    key={c.key}
                    onClick={() => toggleCal(c.key)}
                    aria-pressed={on}
                    className={"cal-leg" + (on ? "" : " off")}
                    type="button"
                  >
                    <span className="sw" style={{ background: c.color }} />
                    {c.name}
                  </button>
                );
              })}
            </div>
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

      {/* iOS-style event detail sheet */}
      {detail && (
        <div className="ds-ios-scrim" onClick={() => setDetail(null)}>
          <div
            className="ds-ios-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby={detailHeadingId}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ds-ios-nav">
              <button className="x" onClick={() => setDetail(null)} aria-label="Close" type="button">
                <X size={18} />
              </button>
              <span className="sp" />
              {detail.source !== "external" && (
                <button className="edit" onClick={editFromDetail} type="button">
                  Edit
                </button>
              )}
            </div>
            <div className="ds-ios-hero">
              <span className="bar" style={{ background: colorOf(detail) }} />
              <div>
                <h3 id={detailHeadingId}>{detail.title}</h3>
                <p className="sub">{eventWhen(detail)}</p>
              </div>
            </div>
            <div className="ds-ios-group">
              <div className="ds-ios-line">
                <span className="il-ic"><Clock size={19} /></span>
                <span className="il-l">When</span>
                <span className="il-v">{detail.allDay ? "All day" : `${shortTime(detail.startsAt)}${detail.endsAt ? " – " + shortTime(detail.endsAt) : ""}`}</span>
              </div>
              {detail.location && (
                <div className="ds-ios-line">
                  <span className="il-ic"><MapPin size={19} /></span>
                  <span className="il-l">Where</span>
                  <span className="il-v">{detail.location}</span>
                </div>
              )}
              <div className="ds-ios-line">
                <span className="il-ic"><CalendarIcon size={19} /></span>
                <span className="il-l">Calendar</span>
                <span className="il-v" style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                  <span className="h-2.5 w-2.5 rounded-full flex-none" style={{ background: colorOf(detail) }} />
                  {nameByKey[keyOf(detail)] ?? "My events"}
                </span>
              </div>
            </div>
            {detail.description && <div className="ds-ios-note">{detail.description}</div>}
            {detail.source === "external" ? (
              <div className="ds-ios-note" style={{ color: "var(--text-muted)" }}>
                Synced from an external calendar — edit it in the source app.
              </div>
            ) : (
              <div className="ds-ios-foot">
                <button className="ds-ios-del" onClick={() => setRemoveTarget(detail)} type="button">
                  Remove event
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* iOS-style schedule report sheet */}
      {showReport && (
        <div className="ds-ios-scrim" onClick={() => setShowReport(false)}>
          <div
            className="ds-ios-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby={reportHeadingId}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ds-ios-nav">
              <button className="x" onClick={() => setShowReport(false)} aria-label="Close" type="button">
                <X size={18} />
              </button>
              <span className="sp" />
            </div>
            <div className="ds-ios-hero">
              <div>
                <h3 id={reportHeadingId}>Schedule report</h3>
                <p className="sub">
                  {report.title} · {report.total} event{report.total === 1 ? "" : "s"}
                </p>
              </div>
            </div>
            <div style={{ padding: "2px 22px 4px" }}>
              <div className="pills" role="group" aria-label="Report range">
                {(["day", "week", "month"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setReportScope(s)}
                    aria-pressed={reportScope === s}
                    className={reportScope === s ? "active" : ""}
                    style={{ textTransform: "capitalize" }}
                    type="button"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
            {report.groups.length === 0 ? (
              <div className="ds-ios-note" style={{ color: "var(--text-muted)" }}>
                Nothing scheduled in this range.
              </div>
            ) : (
              report.groups.map((g) => (
                <div key={g.key}>
                  <div className="ds-rep-day">{g.label}</div>
                  <div className="ds-ios-group">
                    {g.events.map((ev) => (
                      <div className="ds-ios-line" key={ev.id}>
                        <span className="il-ic" style={{ color: colorOf(ev) }}>
                          <span className="h-2.5 w-2.5 rounded-full" style={{ background: colorOf(ev) }} />
                        </span>
                        <span className="il-l">{ev.title}</span>
                        <span className="il-v">{ev.allDay ? "All day" : shortTime(ev.startsAt)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
            <div className="ds-ios-foot" />
          </div>
        </div>
      )}

      <ConfirmDialog
        open={removeTarget !== null}
        onConfirm={confirmRemove}
        onCancel={() => setRemoveTarget(null)}
        title={removeTarget ? `Remove "${removeTarget.title}"?` : "Remove event?"}
        description="This deletes the event from your calendar. This cannot be undone."
        confirmLabel="Remove"
        variant="destructive"
      />
    </ShellPage>
  );
}
