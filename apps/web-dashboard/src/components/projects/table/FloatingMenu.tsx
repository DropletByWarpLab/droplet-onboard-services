"use client";

// WARP-3537 — a small panel anchored to a control, drawn OUTSIDE its scroller.
//
// The existing `Popover` (FilterBar.tsx) is absolutely positioned inside its anchor's
// wrapper, which is right for a toolbar and wrong for a table: a row lives inside a
// scrolling, virtualised container that clips anything that overflows it, so a state
// picker opened on the last visible row would be cut off. This renders into
// `document.body` at fixed coordinates from the anchor's box — below it, or above
// when there is no room — and carries `pm-scope` itself, because the page's tokens
// are scoped to the page and a portal is outside it (the Dialog does the same).
//
// Behaves like the popovers around it: takes focus when it opens, closes on Escape
// (and hands focus back to the anchor) or a press outside, and closes if the page
// moves under it — a menu pinned to a row that has scrolled away is a menu about
// nothing. Inside a `menu`, the arrow keys, Home and End walk the items.

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled])';
const ITEMS = '[role="menuitem"], [role="menuitemradio"]';
const GAP = 6;
const MARGIN = 8;

export interface FloatingMenuProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  label: string;
  /** `menu` for a list of choices; `dialog` for a small form. */
  role?: "menu" | "dialog";
  /** Prefer opening above the anchor (a bar at the bottom of the screen). */
  preferUp?: boolean;
  children: ReactNode;
}

export function FloatingMenu({ anchor, open, onClose, label, role = "menu", preferUp = false, children }: FloatingMenuProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  // Place it: below the anchor (or above), inside the viewport.
  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect();
    const m = ref.current.getBoundingClientRect();
    const below = window.innerHeight - a.bottom - GAP - MARGIN;
    const above = a.top - GAP - MARGIN;
    const up = preferUp ? above >= m.height || above > below : below < m.height && above > below;
    const top = up ? Math.max(MARGIN, a.top - GAP - m.height) : a.bottom + GAP;
    const left = Math.max(MARGIN, Math.min(a.left, window.innerWidth - m.width - MARGIN));
    setPos({ top, left });
  }, [open, anchor, preferUp]);

  const positioned = pos !== null;
  // Focus waits for the menu to be placed: a browser will not focus what is still `visibility: hidden`.
  useEffect(() => {
    if (open && positioned) ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
  }, [open, positioned]);

  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchorRef.current?.contains(t)) return;
      closeRef.current();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
      anchorRef.current?.focus();
    };
    // The page moved under it: scrolling anywhere but inside the menu, or a resize.
    const onMove = (e: Event) => {
      if (e.target instanceof Node && ref.current?.contains(e.target)) return;
      closeRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [open]);

  if (!open || !anchor) return null;

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (role !== "menu") return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length].focus();
    };
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at <= 0 ? -1 : at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(items.length - 1);
  };

  return createPortal(
    <div
      ref={ref}
      className="pm-scope pm-fmenu"
      role={role}
      aria-label={label}
      onKeyDown={onMenuKey}
      // Measured at the origin first, then moved: no frame is drawn at the wrong place.
      style={{ position: "fixed", top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? "visible" : "hidden" }}
    >
      {children}
    </div>,
    document.body,
  );
}
