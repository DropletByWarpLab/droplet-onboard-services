"use client";

/**
 * Bento board — drag-to-reorder (with split-to-share), corner resize, edit
 * mode, and calm settle motion. Pure geometry lives in `bento-engine.ts`;
 * this component owns the pointer choreography and React state.
 *
 * Ported from the Claude Design handoff (board.jsx). All previews during a
 * drag derive from a snapshot taken at drag-start, so they're fully
 * reversible — no compounding shrink, no oscillation.
 */

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  packLayout,
  fillGaps,
  layoutRows,
  clamp,
  type LayoutItem,
  type CellRect,
} from "./bento-engine";
import type { WidgetMeta } from "./widgets";

interface DragState {
  id: string;
  dx?: number;
  dy?: number;
  resizing?: boolean;
  splitId?: string | null;
}

interface DragRef {
  id: string;
  startX: number;
  startY: number;
  rect: DOMRect;
  lastCell: string | null;
  originX: number;
  originY: number;
  base: LayoutItem[];
  splitId: string | null;
}

interface ResizeRef {
  id: string;
  startX: number;
  startY: number;
  startW: number;
  startH: number;
  minW: number;
  minH: number;
  maxH: number;
}

interface BentoBoardProps {
  items: LayoutItem[];
  onChange: (next: LayoutItem[]) => void;
  onRemove: (id: string) => void;
  editMode: boolean;
  cols: number;
  gap: number;
  rowH: number;
  registry: Record<string, WidgetMeta>;
}

export function BentoBoard({
  items,
  onChange,
  onRemove,
  editMode,
  cols,
  gap,
  rowH,
  registry,
}: BentoBoardProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const [boardW, setBoardW] = useState(0);

  const itemsRef = useRef(items);
  itemsRef.current = items;

  useLayoutEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      if (w > 0) setBoardW(w);
    };
    measure();
    requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("load", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("load", measure);
    };
  }, []);

  const colW = boardW > 0 ? (boardW - (cols - 1) * gap) / cols : 0;
  const cellX = colW + gap;
  const cellY = rowH + gap;

  const packed = useMemo(() => packLayout(items, cols), [items, cols]);
  const rows = useMemo(() => layoutRows(packed), [packed]);
  const boardH = Math.max(rows * cellY - gap, 200);

  const pxOf = (p: CellRect) => ({
    x: p.x * cellX,
    y: p.y * cellY,
    w: p.w * colW + (p.w - 1) * gap,
    h: p.h * rowH + (p.h - 1) * gap,
  });

  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragRef | null>(null);
  const resizeRef = useRef<ResizeRef | null>(null);
  const [settlingId, setSettlingId] = useState<string | null>(null);

  /* ---------- DRAG (reorder + split-to-share) ---------- */
  const onDragMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;

    const px = e.clientX - d.rect.left;
    const py = e.clientY - d.rect.top;
    const gx = clamp(Math.floor(px / cellX), 0, cols - 1);
    const gy = Math.max(0, Math.floor(py / cellY));
    const key = gy + ":" + gx;
    if (key === d.lastCell) {
      setDrag({ id: d.id, dx, dy, splitId: d.splitId });
      return;
    }
    d.lastCell = key;

    const baseNoA = d.base.filter((it) => it.id !== d.id);
    const ref = packLayout(baseNoA, cols);
    let hov: string | null = null;
    for (const it of baseNoA) {
      const p = ref[it.id];
      if (gx >= p.x && gx < p.x + p.w && gy >= p.y && gy < p.y + p.h) {
        hov = it.id;
        break;
      }
    }

    const order = d.base.map((it) => ({ ...it }));
    const aIdx = order.findIndex((x) => x.id === d.id);
    const [movedA] = order.splice(aIdx, 1);
    let splitId: string | null = null;

    if (hov) {
      const bIdx = order.findIndex((x) => x.id === hov);
      const B = order[bIdx];
      const minB = Math.max(3, registry[hov]?.minW ?? 2);
      const remaining = B.w - movedA.w;
      if (movedA.w < B.w && remaining >= minB) {
        order[bIdx] = { ...B, w: remaining };
        order.splice(bIdx + 1, 0, movedA);
        splitId = hov;
      } else {
        order.splice(bIdx, 0, movedA);
      }
    } else {
      let maxB = 0;
      for (const k in ref) maxB = Math.max(maxB, ref[k].y + ref[k].h);
      if (gy >= maxB) order.push(movedA);
      else order.splice(aIdx, 0, movedA);
    }

    d.splitId = splitId;
    setDrag({ id: d.id, dx, dy, splitId });
    onChange(order);
  };

  const onDragUp = () => {
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragUp);
    const id = dragRef.current ? dragRef.current.id : null;
    dragRef.current = null;
    setDrag(null);
    if (id) {
      onChange(fillGaps(itemsRef.current, cols, registry));
      setSettlingId(id);
      setTimeout(() => setSettlingId((s) => (s === id ? null : s)), 320);
    }
  };

  const onTileDown = (e: React.PointerEvent, id: string) => {
    if (!editMode || e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".dh-resize") || target.closest(".dh-tile-x")) return;
    e.preventDefault();
    if (!boardRef.current) return;
    const rect = boardRef.current.getBoundingClientRect();
    const pos = pxOf(packed[id]);
    const base = itemsRef.current.map((it) => ({ ...it }));
    dragRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      rect,
      lastCell: null,
      originX: pos.x,
      originY: pos.y,
      base,
      splitId: null,
    };
    setDrag({ id, dx: 0, dy: 0, splitId: null });
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  };

  /* ---------- RESIZE ---------- */
  const onResizeMove = (e: PointerEvent) => {
    const r = resizeRef.current;
    if (!r) return;
    const dw = Math.round((e.clientX - r.startX) / cellX);
    const dh = Math.round((e.clientY - r.startY) / cellY);
    const w = clamp(r.startW + dw, r.minW, cols);
    const h = clamp(r.startH + dh, r.minH, r.maxH);
    const cur = itemsRef.current.find((x) => x.id === r.id);
    if (!cur || (cur.w === w && cur.h === h)) return;
    onChange(itemsRef.current.map((it) => (it.id === r.id ? { ...it, w, h } : it)));
  };

  const onResizeUp = () => {
    window.removeEventListener("pointermove", onResizeMove);
    window.removeEventListener("pointerup", onResizeUp);
    const id = resizeRef.current ? resizeRef.current.id : null;
    resizeRef.current = null;
    setDrag(null);
    if (id) onChange(fillGaps(itemsRef.current, cols, registry));
  };

  const onResizeDown = (e: React.PointerEvent, id: string) => {
    if (!editMode || e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const it = itemsRef.current.find((x) => x.id === id);
    if (!it) return;
    const reg = registry[id] || ({} as WidgetMeta);
    resizeRef.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      startW: it.w,
      startH: it.h,
      minW: reg.minW || 2,
      minH: reg.minH || 2,
      maxH: reg.maxH || 8,
    };
    setDrag({ id, resizing: true });
    window.addEventListener("pointermove", onResizeMove);
    window.addEventListener("pointerup", onResizeUp);
  };

  const boardStyle: React.CSSProperties = {
    height: boardH,
    ["--cell-x" as string]: cellX + "px",
    ["--cell-y" as string]: cellY + "px",
    opacity: boardW > 320 ? 1 : 0,
    transition: "opacity 200ms var(--ease)",
  };

  return (
    <div className="dh-board" ref={boardRef} style={boardStyle}>
      {drag && !drag.resizing && packed[drag.id] && (() => {
        const p = pxOf(packed[drag.id]);
        return (
          <div
            className="dh-slot-ph"
            style={{ transform: `translate(${p.x}px, ${p.y}px)`, width: p.w, height: p.h }}
          />
        );
      })()}

      {items.map((it) => {
        const reg = registry[it.id];
        if (!reg) return null;
        const p = pxOf(packed[it.id]);
        const isDrag = drag && drag.id === it.id && !drag.resizing;
        const isResize = drag && drag.id === it.id && drag.resizing;
        let tx = p.x;
        let ty = p.y;
        if (isDrag) {
          tx = (dragRef.current ? dragRef.current.originX : p.x) + (drag?.dx ?? 0);
          ty = (dragRef.current ? dragRef.current.originY : p.y) + (drag?.dy ?? 0);
        }
        const cls =
          "dh-tile" +
          (isDrag ? " dragging" : "") +
          (isResize ? " resizing" : "") +
          (settlingId === it.id ? " settling" : "") +
          (drag && drag.splitId === it.id ? " split-target" : "");
        const Comp = reg.Comp;
        const szCls =
          (it.w <= 2 ? " sz-narrow" : "") +
          (it.h <= 2 ? " sz-short" : "") +
          (it.w <= 2 && it.h <= 2 ? " sz-tiny" : "");
        const Icon = reg.icon;
        return (
          <div
            key={it.id}
            className={cls}
            style={{ transform: `translate(${tx}px, ${ty}px)`, width: p.w, height: p.h }}
            onPointerDown={(e) => onTileDown(e, it.id)}
          >
            <div className={"bento" + (reg.feature ? " bento--hero" : "") + szCls}>
              {editMode && (
                <button
                  className="dh-tile-x"
                  title={`Remove ${reg.title}`}
                  aria-label={`Remove ${reg.title}`}
                  type="button"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onRemove(it.id)}
                >
                  <X size={13} />
                </button>
              )}
              <div className="bento-head">
                <span className="wi"><Icon size={14} /></span>
                <span className="wt">{reg.title}</span>
                {reg.meta && <span className="wmeta">{reg.meta}</span>}
                <span className="dh-dots"><i /><i /><i /><i /><i /><i /></span>
              </div>
              <div className={"bento-body" + (reg.scroll ? " scroll" : "")}>
                <Comp w={it.w} h={it.h} editing={editMode} />
              </div>
              {editMode && (
                <div className="dh-resize" onPointerDown={(e) => onResizeDown(e, it.id)} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
