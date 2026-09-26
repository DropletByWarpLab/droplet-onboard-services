"use client";
/**
 * WARP-3043 — the themed menu button, shared by every picker that used to be
 * a native `<select>` (the Workshop's Work in chip, /chat's model picker).
 * The browser paints a select's open list itself, outside every token, so a
 * themed surface draws its own list (components/ui/pick-menu.css).
 *
 * The WAI-ARIA menu-button pattern: the trigger carries `aria-haspopup="menu"`
 * and `aria-expanded`; the menu's items are any `[role^="menuitem"]`. Opening
 * focuses the checked item (or the first); Arrow keys wrap, Home and End jump;
 * Escape closes and returns focus to the trigger; Tab and a click outside close
 * without stealing focus back. A trigger that becomes disabled closes an open
 * menu.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

/** A menu at least this wide opens leftward from the trigger's right edge —
 *  unless the trigger sits too near the left edge (a narrow pill wraps it),
 *  where it opens rightward instead. */
const DEFAULT_MIN_WIDTH = 240;

export interface UseMenuButtonOptions {
  disabled?: boolean;
  /** The menu's min-width, for choosing which edge it aligns to. */
  minWidth?: number;
}

export function useMenuButton({ disabled, minWidth = DEFAULT_MIN_WIDTH }: UseMenuButtonOptions = {}) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState<"end" | "start">("end");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    setAlign(rect && rect.right < minWidth ? "start" : "end");
    setOpen(true);
  }, [minWidth]);

  // A click anywhere outside closes the menu without stealing focus back.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  // A trigger that locks (a run starting, a list reloading) closes the menu.
  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  // On open, focus the checked item — the menu-button pattern's landing spot.
  useEffect(() => {
    if (!open) return;
    const items = menuItems(menuRef.current);
    (items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }, [open]);

  const onButtonClick = () => (open ? close(false) : openMenu());

  const onButtonKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu();
    }
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
    } else if (e.key === "Tab") {
      close(false);
    } else if (moveMenuFocus(menuRef.current, e.key)) {
      e.preventDefault();
    }
  };

  return {
    open,
    align,
    close,
    rootRef,
    buttonRef,
    menuRef,
    menuId,
    onButtonClick,
    onButtonKeyDown,
    onMenuKeyDown,
  };
}

/**
 * Arrow keys wrap, Home and End jump — focus among a menu's
 * `[role^="menuitem"]` items. Returns whether `key` was one of those, so the
 * caller can prevent its default. Shared with a menu that is not driven by
 * this hook (HelpLauncher's, whose trigger lives in a page header).
 */
export function moveMenuFocus(menu: HTMLElement | null, key: string): boolean {
  const items = menuItems(menu);
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  switch (key) {
    case "ArrowDown":
      next = i < 0 ? 0 : (i + 1) % items.length;
      break;
    case "ArrowUp":
      next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = items.length - 1;
      break;
    default:
      return false;
  }
  items[next]?.focus();
  return true;
}

export function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
}
