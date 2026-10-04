// The Timeline's rows: items grouped by state like the List view, in the board's
// own stable order. Row order never depends on dates, so dragging a bar (or
// saving it) never makes its row jump (WARP-3523).

import type { PmWorkItem } from "../types";

/** Fixed row height: row geometry, windowing and connectors all derive from it. */
export const ROW_H = 36;

export interface GroupRow {
  type: "group";
  key: string;
  /** The group key (what `collapsed` holds), without the row-key prefix. */
  group: string;
  label: string;
  color: string | null;
  count: number;
  collapsed: boolean;
  index: number;
}

export interface ItemRow {
  type: "item";
  key: string;
  item: PmWorkItem;
  group: string;
  index: number;
}

export type TimelineRow = GroupRow | ItemRow;

const NO_STATE = "none";

export function buildRows(items: readonly PmWorkItem[], collapsed: ReadonlySet<string>): TimelineRow[] {
  const groups = new Map<string, { label: string; color: string | null; order: number; items: PmWorkItem[] }>();
  for (const item of items) {
    const key = item.state?.id ?? NO_STATE;
    let g = groups.get(key);
    if (!g) {
      g = {
        label: item.state?.name ?? "No state",
        color: item.state?.color ?? null,
        // Items without a state sort after every real state.
        order: item.state ? item.state.sortOrder : Number.POSITIVE_INFINITY,
        items: [],
      };
      groups.set(key, g);
    }
    g.items.push(item);
  }

  const rows: TimelineRow[] = [];
  const ordered = [...groups.entries()].sort(([, a], [, b]) => a.order - b.order);
  for (const [key, g] of ordered) {
    const isCollapsed = collapsed.has(key);
    rows.push({ type: "group", key: `g:${key}`, group: key, label: g.label, color: g.color, count: g.items.length, collapsed: isCollapsed, index: rows.length });
    if (isCollapsed) continue;
    const sorted = [...g.items].sort(
      (a, b) => a.sortOrder - b.sortOrder || a.sequenceId - b.sequenceId,
    );
    for (const item of sorted) rows.push({ type: "item", key: item.id, item, group: key, index: rows.length });
  }
  return rows;
}

/** The group key an item belongs to (for collapse state). */
export function groupKeyOf(item: PmWorkItem): string {
  return item.state?.id ?? NO_STATE;
}

export interface RowWindow {
  /** First row to render. */
  start: number;
  /** One past the last row to render. */
  end: number;
}

/** Which rows to draw for a scroll position — the whole of the virtualisation. */
export function computeWindow(args: {
  scrollTop: number;
  viewportHeight: number;
  rowCount: number;
  rowHeight?: number;
  overscan?: number;
}): RowWindow {
  const rowHeight = args.rowHeight ?? ROW_H;
  const overscan = args.overscan ?? 6;
  const top = Math.max(0, args.scrollTop);
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const end = Math.min(args.rowCount, Math.ceil((top + Math.max(0, args.viewportHeight)) / rowHeight) + overscan);
  return { start: Math.min(start, args.rowCount), end: Math.max(Math.min(start, args.rowCount), end) };
}
