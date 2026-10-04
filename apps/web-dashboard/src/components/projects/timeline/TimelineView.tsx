"use client";

// Timeline (Gantt) layout of a project — WARP-3523, brief §3 / §4.1 / §5:
//   * rows = work items grouped by state (like the List), virtualised;
//   * a bar from start to due date, a diamond when only one date is set;
//   * zoom day / week / month / quarter, earlier / later / today;
//   * drag a bar to move it, drag an edge to resize it (optimistic, rolls back);
//   * BLOCKS relations drawn as connectors, module target dates as milestones,
//     a today line;
//   * on a focused bar: ← → move it a day (Shift: a week), ↑ ↓ move to the
//     previous / next row, Enter opens it.
// Everything is a `DateOnly`; one request per window (items + edges + milestones).

import "./timeline.css";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { PmIcon } from "../icons";
import { EmptyBlock, Skel } from "../bits";
import type { Domain } from "../board";
import type { PmWorkItem } from "../types";
import { addDays, formatDay, type DateOnly } from "../calendar/dateOnly";
import {
  describeSchedule,
  isOverdueOn,
  isTerminal,
  sameSchedule,
  scheduleOf,
  shiftSchedule,
  spanOf,
  withDue,
  withStart,
  type Schedule,
} from "../calendar/schedule";
import { useReschedule } from "../calendar/useReschedule";
import { useToday } from "../calendar/useToday";
import { useNarrow } from "../calendar/useNarrow";
import {
  DIAMOND,
  ZOOMS,
  ZOOMS_IN_ORDER,
  ZOOM_LABEL,
  barGeom,
  connector,
  endX,
  headerTicks,
  makeScale,
  pointCenter,
  rangeFor,
  startX,
  weekendBands,
  type Scale,
  type Zoom,
} from "./scale";
import { ROW_H, buildRows, type GroupRow, type ItemRow } from "./rows";
import { useTimeline } from "./useTimeline";
import { useWindowedRows } from "./useWindowedRows";

const TICK_ROW_H = 24;
const MILESTONE_H = 26;
export const HEADER_H = TICK_ROW_H * 2 + MILESTONE_H;
const LABEL_W_WIDE = 280;
const LABEL_W_NARROW = 156;
/** Pointer travel (px) before a press becomes a drag; below it, it is a click. */
const DRAG_THRESHOLD = 4;
/** A bar narrower than this has no room for resize grips (keyboard and the drawer remain). */
const MIN_RESIZABLE_PX = 56;

type DragMode = "move" | "start" | "end";

interface DragState {
  item: PmWorkItem;
  mode: DragMode;
  originX: number;
  /** Only this pointer drives the gesture; a second finger must not end it. */
  pointerId: number;
  base: Schedule;
  delta: number;
  moved: boolean;
}

function applyDrag(base: Schedule, mode: DragMode, delta: number): Schedule {
  if (mode === "move") return shiftSchedule(base, delta);
  if (mode === "start" && base.startDate) return withStart(base, addDays(base.startDate, delta));
  if (mode === "end" && base.dueDate) return withDue(base, addDays(base.dueDate, delta));
  return base;
}

export interface TimelineViewProps {
  projectId: string;
  /** Ids the page's filters admit, or null when none is active (then every item returned is shown). */
  visibleIds: ReadonlySet<string> | null;
  /** Changes whenever the board's data changes (e.g. an edit in the drawer); the timeline refetches. */
  revision: string;
  domain: Domain;
  readOnly: boolean;
  onOpen: (item: PmWorkItem) => void;
  /** Revalidate the caller's data after a save; awaited before the optimistic state is dropped. */
  onChanged: () => Promise<unknown> | void;
  onNewItem?: () => void;
}

export function TimelineView({
  projectId,
  visibleIds,
  revision,
  domain,
  readOnly,
  onOpen,
  onChanged,
  onNewItem,
}: TimelineViewProps): JSX.Element {
  const today = useToday();
  const narrow = useNarrow();
  const labelW = narrow ? LABEL_W_NARROW : LABEL_W_WIDE;
  const markerId = useId().replace(/[^a-zA-Z0-9]/g, "");

  const [zoom, setZoom] = useState<Zoom>("week");
  const [anchor, setAnchor] = useState<DateOnly>(() => today);
  /** The day to bring into view after the window changes. */
  const [focusDay, setFocusDay] = useState<DateOnly>(() => today);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  const [preview, setPreview] = useState<{ id: string; schedule: Schedule } | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const drag = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const pendingFocus = useRef<string | null>(null);

  const range = useMemo(() => rangeFor(anchor, zoom), [anchor, zoom]);
  const scale = useMemo(() => makeScale(range, zoom), [range, zoom]);
  const { timeline, error, isLoading, mutate } = useTimeline(projectId, range);

  const { withPending, reschedule } = useReschedule({
    onSaved: async () => {
      await Promise.all([mutate(), onChanged()]);
    },
    announce: setAnnouncement,
  });

  // Refetch when the board's data changed under us (an edit made in the drawer).
  const firstRevision = useRef(true);
  useEffect(() => {
    if (firstRevision.current) {
      firstRevision.current = false;
      return;
    }
    void mutate();
  }, [revision, mutate]);

  const items = useMemo(() => {
    const all = timeline?.items ?? [];
    const admitted = visibleIds ? all.filter((i) => visibleIds.has(i.id)) : all;
    return withPending(admitted);
  }, [timeline, visibleIds, withPending]);

  const rows = useMemo(() => buildRows(items, collapsed), [items, collapsed]);
  const itemRows = useMemo(() => rows.filter((r): r is ItemRow => r.type === "item"), [rows]);
  const { ref: scrollRef, win, onScroll } = useWindowedRows(rows.length);

  /** Each drawn item's schedule, with the in-progress drag applied live. */
  const scheduleFor = useCallback(
    (item: PmWorkItem): Schedule => (preview?.id === item.id ? preview.schedule : scheduleOf(item)),
    [preview],
  );

  const rowIndexById = useMemo(() => new Map(itemRows.map((r) => [r.item.id, r.index])), [itemRows]);
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const relations = useMemo(
    () => (timeline?.relations ?? []).filter((r) => itemById.has(r.fromId) && itemById.has(r.toId)),
    [timeline, itemById],
  );
  const { blocksKeys, blockedByKeys } = useMemo(() => {
    const blocks = new Map<string, string[]>();
    const blockedBy = new Map<string, string[]>();
    // `relations` was filtered to edges whose BOTH ends are drawn, so both lookups
    // succeed; a miss here is a bug to surface, not a blank to paper over.
    for (const r of relations) {
      const from = itemById.get(r.fromId)!;
      const to = itemById.get(r.toId)!;
      blocks.set(r.fromId, [...(blocks.get(r.fromId) ?? []), to.key]);
      blockedBy.set(r.toId, [...(blockedBy.get(r.toId) ?? []), from.key]);
    }
    return { blocksKeys: blocks, blockedByKeys: blockedBy };
  }, [relations, itemById]);

  // ── scrolling ────────────────────────────────────────────────────────────────

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const track = Math.max(240, el.clientWidth - labelW);
    el.scrollLeft = Math.max(0, scale.x(focusDay) + scale.pxPerDay / 2 - track / 3);
    // Re-centre only when the window, the zoom or the requested day changes — not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.from, zoom, focusDay, labelW]);

  /** The day currently a third of the way across the visible track. */
  const dayInView = (): DateOnly => {
    const el = scrollRef.current;
    if (!el) return anchor;
    const track = Math.max(240, el.clientWidth - labelW);
    return scale.dayAt(el.scrollLeft + track / 3);
  };

  const changeZoom = (next: Zoom) => {
    if (next === zoom) return;
    const day = dayInView();
    setAnchor(day);
    setFocusDay(day);
    setZoom(next);
  };

  const shiftWindow = (dir: 1 | -1) => {
    const next = addDays(anchor, dir * ZOOMS[zoom].step);
    setAnchor(next);
    setFocusDay(next);
  };

  const goToday = () => {
    setAnchor(today);
    setFocusDay(today);
  };

  const scrollRowIntoView = (index: number) => {
    const el = scrollRef.current;
    if (!el || !el.clientHeight) return;
    const visibleH = el.clientHeight - HEADER_H;
    const top = index * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + visibleH) el.scrollTop = top + ROW_H - visibleH;
  };

  // Focus a bar that was not rendered a moment ago (scrolled into the window by ↑/↓).
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (!id || !scrollRef.current) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-tl-item="${id}"]`);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  });

  const focusNeighbour = (item: PmWorkItem, dir: 1 | -1) => {
    const at = itemRows.findIndex((r) => r.item.id === item.id);
    const target = itemRows[at + dir];
    if (!target) return;
    scrollRowIntoView(target.index);
    pendingFocus.current = target.item.id;
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-tl-item="${target.item.id}"]`);
    if (el) {
      el.focus();
      pendingFocus.current = null;
    }
  };

  // ── pointer drag / resize ────────────────────────────────────────────────────
  //
  // The gesture lives on `window`, not on the bar or grip that started it. Pointer
  // capture ties a gesture to one element's lifetime, and that element can go away
  // mid-drag (a re-render, a bar carried across the edge of the fetched window);
  // window listeners outlive any element, so a release anywhere — over the label
  // column, the toolbar, off the chart — settles the gesture. Capture is still set
  // (it keeps events coming from outside the browser window); losing it is harmless.

  const stopTracking = useRef<(() => void) | null>(null);

  const swallowNextClick = () => {
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  };

  /** Ends tracking and returns the gesture that was in progress, if any. */
  const takeGesture = (): DragState | null => {
    const d = drag.current;
    drag.current = null;
    stopTracking.current?.();
    stopTracking.current = null;
    return d;
  };

  const moveDrag = (d: DragState, clientX: number, dayWidth: number) => {
    if (drag.current !== d) return;
    const dx = clientX - d.originX;
    if (!d.moved && Math.abs(dx) < DRAG_THRESHOLD) return;
    const delta = Math.round(dx / dayWidth);
    if (d.moved && delta === d.delta) return;
    d.moved = true;
    d.delta = delta;
    setPreview({ id: d.item.id, schedule: applyDrag(d.base, d.mode, delta) });
  };

  const endDrag = () => {
    const d = takeGesture();
    if (!d) return;
    if (!d.moved) {
      // A click: nothing to save — and no preview may outlive it.
      setPreview(null);
      return;
    }
    swallowNextClick();
    const next = applyDrag(d.base, d.mode, d.delta);
    setPreview(null);
    if (!sameSchedule(d.base, next)) void reschedule(d.item, next);
  };

  const cancelDrag = () => {
    const d = takeGesture();
    if (d?.moved) swallowNextClick();
    setPreview(null);
  };

  const beginDrag = (e: ReactPointerEvent<HTMLElement>, item: PmWorkItem, mode: DragMode) => {
    if (readOnly || e.button !== 0) return;
    e.stopPropagation();
    // A gesture that never saw its release must not leak into this one.
    if (drag.current) cancelDrag();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const d: DragState = {
      item,
      mode,
      originX: e.clientX,
      pointerId: e.pointerId,
      base: scheduleOf(item),
      delta: 0,
      moved: false,
    };
    drag.current = d;
    const dayWidth = scale.pxPerDay;
    const mine = (ev: PointerEvent) => ev.pointerId === d.pointerId;
    const onMove = (ev: PointerEvent) => {
      if (mine(ev)) moveDrag(d, ev.clientX, dayWidth);
    };
    const onUp = (ev: PointerEvent) => {
      if (mine(ev)) endDrag();
    };
    const onCancel = (ev: PointerEvent) => {
      if (mine(ev)) cancelDrag();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    stopTracking.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  };

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && drag.current) cancelDrag();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      stopTracking.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onBarKeyDown = (e: KeyboardEvent<HTMLElement>, item: PmWorkItem) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(item);
      return;
    }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      focusNeighbour(item, e.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (readOnly) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const step = e.shiftKey ? 7 : 1;
      void reschedule(item, shiftSchedule(scheduleOf(item), e.key === "ArrowRight" ? step : -step));
    }
  };

  const toggleGroup = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // ── states that replace the chart ────────────────────────────────────────────

  if (domain === "loading" || (isLoading && !timeline)) return <TimelineSkeleton />;
  if (domain === "error" || (error && !timeline)) {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="alert"
          tone="error"
          heading="Couldn't load this project."
          body="Check the appliance connection and try again."
          cta={
            <button className="pm-btn ghost" type="button" onClick={() => void mutate()}>
              Try again
            </button>
          }
        />
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
  if (domain === "filtered" || (visibleIds && items.length === 0 && (timeline?.items.length ?? 0) > 0)) {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock icon="filter" heading="No work items match these filters." body="Try clearing a filter." />
      </div>
    );
  }

  // ── chart ────────────────────────────────────────────────────────────────────

  const ticks = headerTicks(scale, today);
  const weekends = weekendBands(scale);
  const bodyH = rows.length * ROW_H;
  const renderedRows = rows.slice(win.start, win.end);
  const firstRenderedItem = renderedRows.find((r): r is ItemRow => r.type === "item");
  const tabbableId = renderedRows.some((r) => r.type === "item" && r.item.id === activeId) ? activeId : firstRenderedItem?.item.id ?? null;
  const todayX = today >= range.from && today <= range.to ? scale.x(today) + scale.pxPerDay / 2 : null;
  const milestones = (timeline?.milestones ?? []).filter((m) => m.targetDate >= range.from && m.targetDate <= range.to);
  const empty = items.length === 0;
  const unscheduled = timeline?.unscheduledCount ?? 0;

  const links = relations.flatMap((r) => {
    const a = rowIndexById.get(r.fromId);
    const b = rowIndexById.get(r.toId);
    if (a === undefined || b === undefined) return [];
    if (Math.max(a, b) < win.start || Math.min(a, b) >= win.end) return [];
    const from = itemById.get(r.fromId);
    const to = itemById.get(r.toId);
    if (!from || !to) return [];
    const fromSpan = spanOf(scheduleFor(from));
    const toSpan = spanOf(scheduleFor(to));
    if (!fromSpan || !toSpan) return [];
    const c = connector(endX(scale, fromSpan), a * ROW_H + ROW_H / 2, startX(scale, toSpan), b * ROW_H + ROW_H / 2, ROW_H);
    return [{ id: r.id, ...c }];
  });

  const cssVars = { "--tl-label-w": `${labelW}px`, "--tl-row-h": `${ROW_H}px`, "--tl-header-h": `${HEADER_H}px` } as CSSProperties;

  return (
    <div className="pm-tl" style={cssVars}>
      <div className="pm-tl-toolbar">
        <button type="button" className="pm-iconbtn" aria-label="Earlier" onClick={() => shiftWindow(-1)}>
          <ChevronLeft size={16} aria-hidden />
        </button>
        <button type="button" className="pm-iconbtn" aria-label="Later" onClick={() => shiftWindow(1)}>
          <ChevronRight size={16} aria-hidden />
        </button>
        <button type="button" className="pm-btn sm" onClick={goToday}>
          Today
        </button>
        <span className="pm-tl-range pm-mono">
          {formatDay(range.from, "short")} – {formatDay(range.to, "long")}
        </span>
        <span className="pm-tl-spacer" />
        <div className="pm-pills" role="group" aria-label="Timeline zoom">
          {ZOOMS_IN_ORDER.map((z) => (
            <button key={z} type="button" className={zoom === z ? "on" : ""} aria-pressed={zoom === z} onClick={() => changeZoom(z)}>
              {ZOOM_LABEL[z]}
            </button>
          ))}
        </div>
      </div>

      {(unscheduled > 0 || timeline?.truncated) && (
        <p className="pm-tl-note">
          {unscheduled > 0 && (
            <span>
              {unscheduled} {unscheduled === 1 ? "item has" : "items have"} no dates, so {unscheduled === 1 ? "it isn't" : "they aren't"} shown here. Open ones are listed under Unscheduled in the calendar.
            </span>
          )}
          {timeline?.truncated && <span> This range has more items than can be drawn. Zoom in or move the window to see the rest.</span>}
        </p>
      )}

      <div className="pm-tl-scroll" ref={scrollRef} onScroll={onScroll} role="region" aria-label="Timeline" data-pm-tl-scroll>
        <div className="pm-tl-inner" style={{ width: labelW + scale.width, height: HEADER_H + Math.max(bodyH, ROW_H) }}>
          <div className="pm-tl-header" style={{ height: HEADER_H, width: labelW + scale.width }}>
            <div className="pm-tl-corner" style={{ width: labelW, height: HEADER_H }}>
              <span>Work item</span>
              <span className="pm-tl-count">{itemRows.length}</span>
            </div>
            <div className="pm-tl-ticks" style={{ left: labelW, width: scale.width }}>
              <div className="pm-tl-tickrow" style={{ height: TICK_ROW_H }} aria-hidden="true">
                {ticks.top.map((t) => (
                  <div key={t.key} className="pm-tl-tick top" style={{ left: t.x, width: t.w }}>
                    <span>{t.label}</span>
                  </div>
                ))}
              </div>
              <div className="pm-tl-tickrow" style={{ height: TICK_ROW_H, top: TICK_ROW_H }} aria-hidden="true">
                {ticks.bottom.map((t) => (
                  <div key={t.key} className={"pm-tl-tick" + (t.weekend ? " weekend" : "") + (t.today ? " today" : "")} style={{ left: t.x, width: t.w }}>
                    <span>{t.label}</span>
                    {t.sub && zoom === "day" && <span className="sub">{t.sub}</span>}
                  </div>
                ))}
              </div>
              <div className="pm-tl-milestones" style={{ top: TICK_ROW_H * 2, height: MILESTONE_H }}>
                {milestones.map((m, i) => {
                  const x = scale.x(m.targetDate) + scale.pxPerDay / 2;
                  const nextX = milestones[i + 1] ? scale.x(milestones[i + 1].targetDate) + scale.pxPerDay / 2 : Number.POSITIVE_INFINITY;
                  const room = Math.min(160, nextX - x - 18);
                  return (
                    <div
                      key={m.id}
                      className={"pm-tl-ms" + (m.status === "completed" || m.status === "cancelled" ? " done" : "")}
                      style={{ left: x - 6 }}
                      role="img"
                      aria-label={`Milestone: ${m.name}, ${formatDay(m.targetDate, "short")}`}
                      title={`${m.name} · ${formatDay(m.targetDate, "short")}`}
                    >
                      <span className="pm-tl-ms-diamond" />
                      {room >= 28 && <span className="pm-tl-ms-label" style={{ maxWidth: room }}>{m.name}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          <div className="pm-tl-body" style={{ top: HEADER_H, height: Math.max(bodyH, ROW_H) }}>
            <div className="pm-tl-bg" style={{ left: labelW, width: scale.width }} aria-hidden="true">
              {weekends.map((w) => (
                <div key={w.key} className="pm-tl-weekend" style={{ left: w.x, width: w.w }} />
              ))}
              {ticks.bottom.map((t) => (
                <div key={t.key} className="pm-tl-gridline" style={{ left: t.x }} />
              ))}
              {milestones.map((m) => (
                <div key={m.id} className="pm-tl-msline" style={{ left: scale.x(m.targetDate) + scale.pxPerDay / 2 }} />
              ))}
              {todayX !== null && <div className="pm-tl-today" style={{ left: todayX }} />}
            </div>

            {empty && (
              <div className="pm-tl-empty" style={{ left: labelW }}>
                <strong>Nothing is scheduled between {formatDay(range.from, "short")} and {formatDay(range.to, "long")}.</strong>
                <span>Items with a start or due date show up here.</span>
              </div>
            )}

            <svg className="pm-tl-links" style={{ left: labelW, width: scale.width, height: Math.max(bodyH, ROW_H) }} aria-hidden="true">
              <defs>
                {/* Two markers, because a marker does not inherit its path's colour. */}
                <marker id={`arrow-${markerId}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M 0 0 L 8 4 L 0 8 z" className="pm-tl-arrow" />
                </marker>
                <marker id={`arrow-conflict-${markerId}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M 0 0 L 8 4 L 0 8 z" className="pm-tl-arrow conflict" />
                </marker>
              </defs>
              {links.map((l) => (
                <path
                  key={l.id}
                  d={l.d}
                  className={"pm-tl-link" + (l.conflict ? " conflict" : "")}
                  markerEnd={`url(#arrow-${l.conflict ? "conflict-" : ""}${markerId})`}
                  data-conflict={l.conflict ? "true" : undefined}
                />
              ))}
            </svg>

            <div role="group" aria-label="Work items">
              {renderedRows.map((row) =>
                row.type === "group" ? (
                  <GroupHeader key={row.key} row={row} onToggle={() => toggleGroup(row.group)} />
                ) : (
                  <Row
                    key={row.key}
                    row={row}
                    scale={scale}
                    today={today}
                    labelW={labelW}
                    schedule={scheduleFor(row.item)}
                    dragging={preview?.id === row.item.id}
                    readOnly={readOnly}
                    tabbable={tabbableId === row.item.id}
                    blocks={blocksKeys.get(row.item.id)}
                    blockedBy={blockedByKeys.get(row.item.id)}
                    onOpen={() => {
                      if (!suppressClick.current) onOpen(row.item);
                    }}
                    onFocusBar={() => setActiveId(row.item.id)}
                    onKeyDown={onBarKeyDown}
                    onBeginDrag={beginDrag}
                  />
                ),
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
    </div>
  );
}

function GroupHeader({ row, onToggle }: { row: GroupRow; onToggle: () => void }): JSX.Element {
  return (
    <div className="pm-tl-row group" style={{ top: row.index * ROW_H, height: ROW_H }} data-tl-row-index={row.index}>
      <button type="button" className="pm-tl-grouphead" aria-expanded={!row.collapsed} onClick={onToggle}>
        <ChevronDown size={14} aria-hidden className={"chev" + (row.collapsed ? " collapsed" : "")} />
        <span className="pm-dot" style={{ background: row.color ?? "var(--text-4)" }} />
        <span className="name">{row.label}</span>
        <span className="sx">{row.count}</span>
      </button>
    </div>
  );
}

function Row({
  row,
  scale,
  today,
  labelW,
  schedule,
  dragging,
  readOnly,
  tabbable,
  blocks,
  blockedBy,
  onOpen,
  onFocusBar,
  onKeyDown,
  onBeginDrag,
}: {
  row: ItemRow;
  scale: Scale;
  today: DateOnly;
  labelW: number;
  schedule: Schedule;
  dragging: boolean;
  readOnly: boolean;
  tabbable: boolean;
  blocks: string[] | undefined;
  blockedBy: string[] | undefined;
  onOpen: () => void;
  onFocusBar: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>, item: PmWorkItem) => void;
  onBeginDrag: (e: ReactPointerEvent<HTMLElement>, item: PmWorkItem, mode: DragMode) => void;
}): JSX.Element {
  const item = row.item;
  const span = spanOf(schedule);
  const overdue = isOverdueOn({ dueDate: schedule.dueDate, state: item.state }, today);
  const done = isTerminal(item);
  const accent = overdue ? undefined : ({ "--bar-accent": item.state?.color ?? "var(--text-4)" } as CSSProperties);

  const name =
    `${item.key}, ${item.name}, ${describeSchedule(schedule)}${overdue ? ", overdue" : ""}` +
    (item.state ? `, ${item.state.name}` : "") +
    (blocks?.length ? `, blocks ${blocks.join(", ")}` : "") +
    (blockedBy?.length ? `, blocked by ${blockedBy.join(", ")}` : "");

  return (
    <div className="pm-tl-row" style={{ top: row.index * ROW_H, height: ROW_H }} data-tl-row-index={row.index}>
      <div className="pm-tl-label" style={{ width: labelW }} onClick={onOpen} aria-hidden="true">
        <span className="pm-dot" style={{ background: overdue ? "var(--warn)" : item.state?.color ?? "var(--text-4)" }} />
        <span className="pm-mono key">{item.key}</span>
        <span className={"ttl" + (done ? " done" : "")}>{item.name}</span>
        {overdue && <PmIcon name="alert" size={12} />}
      </div>
      {renderBar()}
    </div>
  );

  // A plain function that RETURNS elements — not a component. Declaring a
  // component here would give React a new type on every render, remounting the
  // bar mid-drag and dropping its pointer capture and focus.
  function renderBar(): JSX.Element | null {
    if (!span) return null;
    const common = {
      role: "button" as const,
      tabIndex: tabbable ? 0 : -1,
      "data-tl-item": item.id,
      "data-tl-bar": span.kind,
      "aria-label": name,
      onClick: onOpen,
      onFocus: onFocusBar,
      onKeyDown: (e: KeyboardEvent<HTMLElement>) => onKeyDown(e, item),
      // Only the start of a gesture is element-level; its move / end live on window.
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => onBeginDrag(e, item, "move"),
    };
    const cls = (base: string) =>
      base +
      (overdue ? " overdue" : "") +
      (done ? " done" : "") +
      (dragging ? " is-dragging" : "") +
      (readOnly ? "" : " writable");

    // While a drag is in progress the element that owns the pointer capture must
    // stay mounted — even when the preview carries it outside the window or
    // shrinks it below the grip threshold — or the gesture is lost mid-flight.
    if (span.kind === "point") {
      const cx = pointCenter(scale, span.start) ?? (dragging ? scale.x(span.start) + scale.pxPerDay / 2 : null);
      if (cx === null) return null;
      return (
        <div className={cls("pm-tl-point")} style={{ left: labelW + cx - DIAMOND / 2, ...accent }} {...common}>
          <span className="pm-tl-diamond" />
          <span className="pm-tl-outlabel">{item.name}</span>
        </div>
      );
    }

    const geom =
      barGeom(scale, span) ??
      (dragging ? { left: scale.x(span.start), width: span.days * scale.pxPerDay, clippedStart: false, clippedEnd: false } : null);
    if (!geom) return null;
    const resizable = !readOnly && !span.inverted && (dragging || geom.width >= MIN_RESIZABLE_PX);
    return (
      <div
        className={cls("pm-tl-bar") + (geom.clippedStart ? " clip-start" : "") + (geom.clippedEnd ? " clip-end" : "")}
        style={{ left: labelW + geom.left, width: geom.width, ...accent }}
        {...common}
      >
        {resizable && (dragging || !geom.clippedStart) && (
          <span
            className="pm-tl-grip start"
            data-tl-grip="start"
            aria-hidden="true"
            onPointerDown={(e) => onBeginDrag(e, item, "start")}
          />
        )}
        <span className="pm-tl-bar-label">{geom.width >= 96 ? item.name : ""}</span>
        {resizable && (dragging || !geom.clippedEnd) && (
          <span className="pm-tl-grip end" data-tl-grip="end" aria-hidden="true" onPointerDown={(e) => onBeginDrag(e, item, "end")} />
        )}
        {geom.width < 96 && <span className="pm-tl-outlabel" style={{ left: geom.width + 6 }}>{item.name}</span>}
      </div>
    );
  }
}

function TimelineSkeleton(): JSX.Element {
  return (
    <div className="pm-tl" aria-busy="true">
      <div className="pm-tl-toolbar">
        <Skel w={96} h={30} r={8} />
        <Skel w={180} h={16} />
      </div>
      <div className="pm-surface" style={{ padding: "8px 0" }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="pm-row" style={{ gap: 12, padding: "9px 14px", borderBottom: "1px solid var(--border)" }}>
            <Skel w={60} h={11} />
            <Skel w="22%" h={12} />
            <Skel w={`${20 + ((i * 13) % 35)}%`} h={16} r={6} style={{ marginLeft: `${(i * 9) % 30}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

