"use client";

// Keyboard focus that survives a row removing itself (WARP-3521, review S1).
//
// "Add to cycle" in the backlog and "Remove from module" are buttons inside a
// list row, and pressing one makes that row leave its list once the server has
// answered. A browser drops focus to <body> when the focused node leaves the
// document, which sends a keyboard or screen-reader user back to the top of the
// page after every item: the "keyboard alternative" to drag-and-drop would then
// be much worse than the drag it replaces (brief §5.5).
//
// This hands focus on instead:
//
//   the next row's button  →  the previous row's, when it was the last  →  the
//   panel heading, when the list is now empty.
//
// Only when the button HAD focus at the moment it was pressed, and only while
// focus is still where the removal left it. A click in a browser that does not
// focus buttons, a drag-and-drop, or focus the user has since moved somewhere
// else are all left alone: this never takes focus the user did not have there.
//
// A refused action leaves the row where it is; the button gets focus back, since
// a button that is disabled while it works can lose it.

import { useCallback, useEffect, useRef } from "react";

export interface FocusAfterRemoval {
  /** Ref callback for a row's action button. */
  rowRef: (id: string) => (el: HTMLElement | null) => void;
  /** Ref callback for the panel heading (give it `tabIndex={-1}`). */
  headingRef: (el: HTMLElement | null) => void;
  /** Call from the button's click handler, before starting the action. */
  arm: (id: string, trigger: HTMLElement) => void;
}

/**
 * @param rows     the rendered rows, in order
 * @param inFlight ids whose action has started and not yet settled; focus moves
 *                 only after the action it belongs to has finished
 */
export function useFocusAfterRemoval<T extends { id: string }>(
  rows: readonly T[],
  inFlight: ReadonlySet<string>,
): FocusAfterRemoval {
  const buttons = useRef(new Map<string, HTMLElement>());
  const heading = useRef<HTMLElement | null>(null);
  const pending = useRef<{ id: string; index: number } | null>(null);

  const rowRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) buttons.current.set(id, el);
      else buttons.current.delete(id);
    },
    [],
  );
  const headingRef = useCallback((el: HTMLElement | null) => {
    heading.current = el;
  }, []);

  const arm = useCallback(
    (id: string, trigger: HTMLElement) => {
      pending.current =
        typeof document !== "undefined" && document.activeElement === trigger
          ? { id, index: rows.findIndex((r) => r.id === id) }
          : null;
    },
    [rows],
  );

  useEffect(() => {
    const p = pending.current;
    if (!p || inFlight.has(p.id)) return;
    pending.current = null;

    const here = rows.findIndex((r) => r.id === p.id);
    const target = here >= 0 ? rows[here] : (rows[p.index] ?? rows[p.index - 1]);
    const next = target ? buttons.current.get(target.id) : heading.current;

    // Focus the user put somewhere else while the request ran stays there.
    const active = document.activeElement;
    const stillOurs = !active || active === document.body || active === next || buttons.current.get(p.id) === active;
    if (stillOurs) next?.focus();
  }, [rows, inFlight]);

  return { rowRef, headingRef, arm };
}
