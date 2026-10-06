"use client";

// WARP-3537 — the table layout (brief §3.3, spec WS-6b): sortable columns, a column
// picker's columns, inline edit for state / priority / assignee / due date, a sticky
// header, a checkbox column with shift-range select, collapsible groups with counts,
// and keyboard row navigation (↑/↓, Enter opens the drawer) — over 1,000 rows
// without drawing 1,000 rows.
//
// What it does NOT own: the data (the page's query), the order (a sort the server
// applies — a header click asks for it), the selection (a hook the bulk bar and the
// palette also read) and what an edit does (`TableEdits`, which makes it optimistic).
// It draws the rows it is given, where the person can reach them.
//
// A `grid`, not a `<table>`: rows are absolutely positioned inside a spacer of the
// full height so only the ones near the viewport exist. `aria-rowcount` /
// `aria-rowindex` tell a screen reader how many rows there really are, and a roving
// tabindex makes the grid ONE tab stop.

import "./table.css";
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type JSX, type KeyboardEvent, type Ref } from "react";
import type { PmGroupByField, PmSortSpec, PmTableColumnId, PmTableScope } from "@droplet/shared-types";
import { EmptyBlock, Skel } from "../bits";
import { PmIcon } from "../icons";
import type { Domain } from "../board";
import type { Selection } from "../bulk/selection";
import type { PmProject, PmQueryGroup, PmState, PmWorkItem } from "../types";
import { ownsKeys } from "../palette/shortcuts";
import { COLUMN_DEFS, gridMinWidth, gridTemplate } from "./columns";
import { renderCell, type CellEnv, type EditKind, type EditRequest } from "./cells";
import { flattenGroups, groupItems, serverCount, type FlatRow, type GroupContext, type ItemGroup } from "./grouping";
import type { PersonChoice } from "./menus";
import { ariaSortOf, nextSort, sortIndexOf } from "./sorting";
import type { TableEdits } from "./useTableEdits";
import { GROUP_HEIGHT, HEADER_HEIGHT, ROW_HEIGHT, useWindowedRows } from "./virtual";

/** What the shortcuts (j, k, x, e, a, s, p) can ask of the table. */
export interface TableApi {
  /** Move the active row by one. The first press with no active row lands on the first (or last) row. */
  move: (delta: 1 | -1) => void;
  /** Select or unselect the active row. */
  toggleSelect: () => void;
  /** Open an editor on the active row. */
  edit: (kind: EditKind) => void;
}

export interface TableViewProps {
  rows: PmWorkItem[];
  domain: Domain;
  scope: PmTableScope;
  columns: PmTableColumnId[];
  sort: PmSortSpec[] | null;
  onSort: (next: PmSortSpec[] | null) => void;
  groupBy: PmGroupByField | null;
  /** The server's exact per-group counts for the whole result — read while rows are still arriving. */
  groupCounts?: PmQueryGroup[];
  loadingMore: boolean;
  readOnly: boolean;
  selection: Selection;
  /** Ids with a write in flight: drawn as saving. */
  pending: ReadonlySet<string>;
  states: PmState[];
  people: PersonChoice[];
  groupContext: GroupContext;
  projects?: PmProject[];
  edits: TableEdits;
  onOpen: (item: PmWorkItem) => void;
  onAnnounce: (message: string) => void;
  onRetry?: () => void;
  onClearFilters?: () => void;
  onNewItem?: () => void;
  apiRef?: Ref<TableApi>;
}

const rowKeyOf = (r: Extract<FlatRow, { kind: "item" }>): string => (r.groupId ? `${r.groupId}\u0001${r.item.id}` : r.item.id);

export function TableView(p: TableViewProps): JSX.Element {
  const { domain, scope, readOnly } = p;

  if (domain === "loading") return <TableSkeleton columns={p.columns} withSelect={!readOnly} />;
  if (domain === "error") {
    return (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="alert"
          tone="error"
          heading="Couldn't load this project."
          body="Check the appliance connection and try again."
          cta={p.onRetry ? <button className="pm-btn ghost" type="button" onClick={p.onRetry}>Try again</button> : undefined}
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
            !readOnly && scope === "project" && p.onNewItem ? (
              <button className="pm-btn primary" type="button" onClick={p.onNewItem}>
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
        <EmptyBlock
          icon="filter"
          heading="No work items match these filters."
          body="Try clearing a filter."
          cta={p.onClearFilters ? <button className="pm-btn ghost" type="button" onClick={p.onClearFilters}>Clear filters</button> : undefined}
        />
      </div>
    );
  }
  return <TableGrid {...p} />;
}

function TableSkeleton({ columns, withSelect }: { columns: PmTableColumnId[]; withSelect: boolean }): JSX.Element {
  const template = gridTemplate(columns, withSelect);
  return (
    <div className="pm-surface pm-table-wrap" aria-busy="true" aria-label="Loading work items">
      <div className="pm-table-scroller">
        <div style={{ minWidth: gridMinWidth(columns, withSelect) }}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="pm-trow" style={{ gridTemplateColumns: template, height: ROW_HEIGHT }}>
              {withSelect && <span className="pm-tcell"><Skel w={14} h={14} r={3} /></span>}
              {columns.map((c) => (
                <span key={c} className="pm-tcell"><Skel w={c === "name" ? "70%" : 56} h={12} /></span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TableGrid(p: TableViewProps): JSX.Element {
  const { rows, columns, readOnly, selection, scope } = p;
  const selectable = !readOnly;
  const template = useMemo(() => gridTemplate(columns, selectable), [columns, selectable]);
  const minWidth = useMemo(() => gridMinWidth(columns, selectable), [columns, selectable]);

  // ── the rows: grouped or not, minus the collapsed, then windowed ──
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const groups = useMemo<ItemGroup[] | null>(
    () => (p.groupBy ? groupItems(rows, p.groupBy, p.groupContext) : null),
    [rows, p.groupBy, p.groupContext],
  );
  const flat = useMemo(() => flattenGroups(groups, collapsed, rows), [groups, collapsed, rows]);
  const heights = useMemo(() => flat.map((r) => (r.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT)), [flat]);
  const win = useWindowedRows(heights, HEADER_HEIGHT);

  /** Item ids in on-screen order, once each (an item with two assignees is under two groups). */
  const itemOrder = useMemo(() => [...new Set(flat.flatMap((r) => (r.kind === "item" ? [r.item.id] : [])))], [flat]);
  const itemRows = useMemo(() => flat.flatMap((r, i) => (r.kind === "item" ? [{ r, i }] : [])), [flat]);

  // A selection never names an item that is no longer here (filtered away, archived, deleted).
  const { prune } = selection;
  useEffect(() => {
    prune(new Set(rows.map((r) => r.id)));
  }, [rows, prune]);

  // ── the active row (roving tabindex) ──
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const tabbable = useMemo(() => {
    if (activeKey && itemRows.some(({ r }) => rowKeyOf(r) === activeKey)) return activeKey;
    return itemRows.length > 0 ? rowKeyOf(itemRows[0].r) : null;
  }, [activeKey, itemRows]);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const focusWanted = useRef<string | null>(null);
  useEffect(() => {
    const want = focusWanted.current;
    if (want === null) return;
    const el = rowEls.current.get(want);
    if (el) {
      focusWanted.current = null;
      el.focus();
    }
  });

  const goTo = useCallback(
    (k: number) => {
      const target = itemRows[k];
      if (!target) return;
      const key = rowKeyOf(target.r);
      focusWanted.current = key;
      setActiveKey(key);
      win.scrollToIndex(target.i);
    },
    [itemRows, win],
  );
  /** The row the person has actually moved to or touched — not merely the one that is the tab stop. -1 if none. */
  const activeIndex = useMemo(
    () => (activeKey === null ? -1 : itemRows.findIndex(({ r }) => rowKeyOf(r) === activeKey)),
    [itemRows, activeKey],
  );

  const move = useCallback(
    (delta: 1 | -1) => {
      if (itemRows.length === 0) return;
      // Nothing active yet: the first press lands on the first row (or the last, going up).
      const next = activeIndex >= 0 ? Math.min(itemRows.length - 1, Math.max(0, activeIndex + delta)) : delta === 1 ? 0 : itemRows.length - 1;
      goTo(next);
    },
    [itemRows, activeIndex, goTo],
  );

  // ── editing on request (e, a, s, p) ──
  const [request, setRequest] = useState<EditRequest | null>(null);
  const nonce = useRef(0);
  const consume = useCallback(() => setRequest(null), []);
  const columnShown = (c: PmTableColumnId) => columns.includes(c);
  const canEditState = scope === "project" && p.states.length > 0;

  useImperativeHandle(p.apiRef, () => ({
    move,
    toggleSelect: () => {
      const at = itemRows[activeIndex];
      if (at && selectable) selection.select(at.r.item.id, { order: itemOrder });
    },
    edit: (kind) => {
      if (readOnly) return;
      const at = itemRows[activeIndex];
      if (!at) {
        p.onAnnounce("Move to a row first, then press the key again.");
        return;
      }
      if (!columnShown(kind)) {
        p.onAnnounce(`Show the ${COLUMN_DEFS[kind].label.toLowerCase()} column to change it from the keyboard.`);
        return;
      }
      if (kind === "state" && !canEditState) {
        p.onAnnounce("State can't be changed from here — open the project.");
        return;
      }
      nonce.current += 1;
      setRequest({ rowId: at.r.item.id, kind, nonce: nonce.current });
    },
  }));

  // ── the header checkbox ──
  const selectedHere = itemOrder.filter((id) => selection.has(id)).length;
  const allSelected = itemOrder.length > 0 && selectedHere === itemOrder.length;
  const headBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headBox.current) headBox.current.indeterminate = selectedHere > 0 && !allSelected;
  }, [selectedHere, allSelected]);

  const toggleGroup = (id: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const onRowKey = (e: KeyboardEvent<HTMLDivElement>, item: PmWorkItem) => {
    if (ownsKeys(e.target)) return; // the title editor, a date field, an open menu: those keys are theirs
    if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      p.onOpen(item);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      goTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      goTo(itemRows.length - 1);
    }
  };

  const visible = flat.slice(win.start, win.end);

  return (
    <div className="pm-surface pm-table-wrap">
      <div
        ref={win.ref}
        className="pm-table-scroller"
        onScroll={win.onScroll}
        role="grid"
        aria-label="Work items"
        aria-rowcount={flat.length + 1}
        aria-colcount={columns.length + (selectable ? 1 : 0)}
        aria-multiselectable={selectable || undefined}
      >
        <div style={{ minWidth }}>
          <div role="row" aria-rowindex={1} className="pm-trow pm-thead" style={{ gridTemplateColumns: template, height: HEADER_HEIGHT }}>
            {selectable && (
              <div role="columnheader" className="pm-tcell pm-tsel">
                <input
                  ref={headBox}
                  type="checkbox"
                  aria-label="Select all"
                  checked={allSelected}
                  onChange={() => (allSelected ? selection.clear() : selection.selectAll(itemOrder))}
                />
              </div>
            )}
            {columns.map((c) => {
              const def = COLUMN_DEFS[c];
              const field = def.sortField;
              return (
                <div key={c} role="columnheader" className="pm-tcell pm-th" aria-sort={field ? ariaSortOf(p.sort, field) : undefined}>
                  {field ? (
                    <button
                      type="button"
                      className="pm-th-btn"
                      title={`Sort by ${def.label.toLowerCase()} — Shift-click to add it to the sort`}
                      onClick={(e) => p.onSort(nextSort(p.sort, field, e.shiftKey))}
                    >
                      {def.label}
                      <SortMark sort={p.sort} field={field} />
                    </button>
                  ) : (
                    def.label
                  )}
                </div>
              );
            })}
          </div>

          <div role="rowgroup" className="pm-tbody" style={{ height: win.total }}>
            {visible.map((r, k) => {
              const i = win.start + k;
              const top = win.offsets[i];
              if (r.kind === "group") {
                const count = p.loadingMore ? (serverCount(p.groupCounts, r.group.key) ?? r.group.items.length) : r.group.items.length;
                return (
                  <div key={`g:${r.group.id}`} role="row" aria-rowindex={i + 2} className="pm-trow pm-tgroup" style={{ top, height: GROUP_HEIGHT }}>
                    <div role="gridcell" className="pm-tgroupcell" aria-colspan={columns.length + (selectable ? 1 : 0)}>
                      <button type="button" className="pm-tgroup-btn" aria-expanded={!r.collapsed} onClick={() => toggleGroup(r.group.id)}>
                        <PmIcon name="chevD" size={13} style={{ transform: r.collapsed ? "rotate(-90deg)" : undefined }} />
                        {r.group.color && <span className="pm-dot" style={{ background: r.group.color }} />}
                        <span className="pm-tgroup-name">{r.group.name}</span>
                        {r.group.chip && <span className="pm-linechip">{r.group.chip}</span>}
                        <span className="pm-tgroup-count">
                          {count}
                          <span className="sr-only"> {count === 1 ? "item" : "items"}</span>
                        </span>
                      </button>
                    </div>
                  </div>
                );
              }

              const key = rowKeyOf(r);
              const item = r.item;
              const selected = selection.has(item.id);
              const isActive = key === tabbable;
              const env: CellEnv = {
                readOnly,
                canEditState,
                states: p.states,
                people: p.people,
                edits: p.edits,
                projects: p.projects,
                active: isActive,
                request: isActive ? request : null,
                consume,
              };
              return (
                <div
                  key={key}
                  ref={(el) => {
                    if (el) rowEls.current.set(key, el);
                    else rowEls.current.delete(key);
                  }}
                  role="row"
                  aria-rowindex={i + 2}
                  aria-selected={selectable ? selected : undefined}
                  aria-label={`${item.key}, ${item.name}`}
                  aria-busy={p.pending.has(item.id) || undefined}
                  tabIndex={isActive ? 0 : -1}
                  className={"pm-trow pm-titem" + (selected ? " selected" : "") + (p.pending.has(item.id) ? " saving" : "") + (isActive ? " active" : "")}
                  style={{ top, height: ROW_HEIGHT, gridTemplateColumns: template }}
                  onClick={() => {
                    setActiveKey(key);
                    p.onOpen(item);
                  }}
                  // Focus anywhere in the row — the row itself or a control in it — makes it the active one.
                  onFocus={() => setActiveKey(key)}
                  onKeyDown={(e) => onRowKey(e, item)}
                >
                  {selectable && (
                    <div role="gridcell" className="pm-tcell pm-tsel" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${item.key}`}
                        tabIndex={isActive ? 0 : -1}
                        checked={selected}
                        // The click carries `shiftKey`; `onChange` does not.
                        onChange={() => undefined}
                        onClick={(e) => {
                          e.stopPropagation();
                          setActiveKey(key);
                          selection.select(item.id, { order: itemOrder, shift: e.shiftKey });
                        }}
                      />
                    </div>
                  )}
                  {columns.map((c) => (
                    <div key={c} role="gridcell" className={"pm-tcell pm-tc-" + c}>
                      {renderCell(c, item, env)}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The little arrow (and, in a multi-key sort, the key's number) beside a sorted header. */
function SortMark({ sort, field }: { sort: PmSortSpec[] | null; field: PmSortSpec["field"] }): JSX.Element | null {
  const at = sort?.findIndex((s) => s.field === field) ?? -1;
  if (!sort || at < 0) return null;
  const index = sortIndexOf(sort, field);
  return (
    <span className="pm-th-mark" aria-hidden>
      <PmIcon name="chevD" size={12} style={{ transform: sort[at].dir === "asc" ? "rotate(180deg)" : undefined }} />
      {index !== null && <span className="pm-mono">{index}</span>}
    </span>
  );
}
