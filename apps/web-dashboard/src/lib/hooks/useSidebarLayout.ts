"use client";

import { useCallback, useLayoutEffect, useState } from "react";

/**
 * WARP-2956 — desktop sidebar collapse + resize state.
 *
 * The width reaches the layout through ONE CSS variable, `--sidebar-w` on
 * <html>: the aside is `lg:w-[var(--sidebar-w)]`, the content column is
 * `lg:ml-[var(--sidebar-w)]`, and anything else that used to hard-code 260px
 * reads the same variable. `globals.css` declares the 260px default so SSR
 * paints correctly, and the inline script in `app/layout.tsx` re-applies the
 * persisted value before hydration so there is no layout flash. Per browser
 * (localStorage), deliberately not a server setting.
 */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_MAX = 360;
export const SIDEBAR_DEFAULT = 260;
/** Collapsed icon-rail width. */
export const SIDEBAR_RAIL = 64;
export const SIDEBAR_WIDTH_KEY = "droplet.sidebar.width";
export const SIDEBAR_COLLAPSED_KEY = "droplet.sidebar.collapsed";

/** Clamp to [MIN, MAX]; anything non-numeric (stale/hand-edited storage) → default. */
export function clampSidebarWidth(px: number): number {
  if (!Number.isFinite(px)) return SIDEBAR_DEFAULT;
  return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(px)));
}

function readStored(): { collapsed: boolean; width: number } {
  try {
    return {
      collapsed: localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1",
      width: clampSidebarWidth(
        Number(localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? SIDEBAR_DEFAULT),
      ),
    };
  } catch {
    return { collapsed: false, width: SIDEBAR_DEFAULT };
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / blocked storage: the session still works, it just won't remember.
  }
}

function applyWidthVar(px: number) {
  document.documentElement.style.setProperty("--sidebar-w", `${px}px`);
}

export function useSidebarLayout() {
  // Server-matching defaults; storage is read in a layout effect so the tree
  // hydrates cleanly and the corrected state lands before the first paint.
  const [collapsed, setCollapsedState] = useState(false);
  const [width, setWidthState] = useState(SIDEBAR_DEFAULT);

  useLayoutEffect(() => {
    const stored = readStored();
    setCollapsedState(stored.collapsed);
    setWidthState(stored.width);
  }, []);

  useLayoutEffect(() => {
    applyWidthVar(collapsed ? SIDEBAR_RAIL : width);
  }, [collapsed, width]);

  /** Commit a width: state + storage (+ the CSS var via the effect). */
  const setWidth = useCallback((px: number) => {
    const next = clampSidebarWidth(px);
    setWidthState(next);
    write(SIDEBAR_WIDTH_KEY, String(next));
  }, []);

  /**
   * Mid-drag: the CSS var only. A pointermove stream runs at 60–120 Hz —
   * no React state and no localStorage write per move; the caller commits
   * the returned value with `setWidth` on release.
   */
  const previewWidth = useCallback((px: number) => {
    const next = clampSidebarWidth(px);
    applyWidthVar(next);
    return next;
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    setCollapsedState(next);
    write(SIDEBAR_COLLAPSED_KEY, next ? "1" : "0");
  }, []);

  return { collapsed, width, setCollapsed, setWidth, previewWidth };
}
