"use client";

import { useCallback, useRef, useState } from "react";

/**
 * WARP-1396 — the keyboard contract shared by the room options menu and the
 * room-assignment picker (§7): Escape closes and returns focus to the opener;
 * ArrowDown/ArrowUp/Home/End move focus among the popover's focusable items
 * (the roving model a `menu`/`listbox` role promises). Outside-click close is
 * handled by the caller's scrim.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const items = () =>
    Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"],[role="option"],button',
      ) ?? [],
    ).filter((el) => !el.hasAttribute("disabled"));

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      const list = items();
      if (list.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = list.indexOf(active as HTMLElement);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        list[idx < 0 ? 0 : (idx + 1) % list.length]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        list[idx <= 0 ? list.length - 1 : idx - 1]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        list[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        list[list.length - 1]?.focus();
      }
    },
    [close],
  );

  return { open, setOpen, close, triggerRef, panelRef, onKeyDown };
}

/** Bottom-sheet-at-375 treatment shared by the popovers (§5.3, §6.8, DoD §10).
 *  On <640px the panel becomes a full-width bottom sheet; desktop keeps the
 *  anchored popover the caller positions. */
export const POPOVER_SHEET =
  "max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:top-auto max-sm:left-0 " +
  "max-sm:right-0 max-sm:w-full max-sm:min-w-0 max-sm:rounded-b-none " +
  "max-sm:rounded-t-2xl max-sm:max-h-[70vh] max-sm:shadow-2xl";
