"use client";

// WARP-3520 — the small action menu the item drawer (Archive / Restore /
// Delete) and the project header (Project settings / Archived items) share.
//
// A kebab button that opens an in-flow, absolutely-positioned menu — no portal,
// no positioning library — which is the same restraint LabelsEditor chose: the
// Dialog drawer scrolls and clips, and a portal'd popover has to be told about
// both. ARIA menu-button pattern: `aria-haspopup="menu"` + `aria-expanded` on
// the trigger, `role="menu"` / `role="menuitem"` inside, Arrow/Home/End to move,
// Enter/Space to choose, Escape to close and return focus to the trigger.
//
// Escape is handled with `stopPropagation()` on purpose: the canonical <Dialog>
// listens for Escape on `window`, so a menu inside a drawer that let the key
// through would close the whole drawer along with the menu.

import { useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { PmIcon } from "./icons";
import "./editing.css";

export interface MenuItemSpec {
  id: string;
  label: string;
  /** PmIcon name. */
  icon?: string;
  /** Destructive styling (red). */
  danger?: boolean;
  /** Omitted from the menu — for role- and state-dependent entries. */
  hidden?: boolean;
  onSelect: () => void;
}

export function MenuButton({
  label,
  items,
  icon = "more",
  align = "right",
  className = "pm-iconbtn",
  buttonRef,
}: {
  /** Accessible name of the trigger, e.g. "Item actions". */
  label: string;
  items: MenuItemSpec[];
  /** PmIcon name of the trigger glyph. */
  icon?: string;
  align?: "left" | "right";
  /** Class of the trigger button. */
  className?: string;
  /** The trigger, for a caller that must put focus back on it itself (a dialog
   *  the menu opened is unmounted rather than closed, so the Dialog primitive's
   *  own focus restore never runs). */
  buttonRef?: { current: HTMLButtonElement | null };
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const visible = items.filter((i) => !i.hidden);

  const itemEls = (): HTMLElement[] =>
    Array.from(wrapRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  // Close on a press outside the menu.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Move focus into the menu when it opens.
  useEffect(() => {
    if (open) itemEls()[0]?.focus();
  }, [open]);

  if (visible.length === 0) return null;

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" && !open) {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const els = itemEls();
    const at = els.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        break;
      case "ArrowDown":
        e.preventDefault();
        els[(at + 1) % els.length]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        els[(at - 1 + els.length) % els.length]?.focus();
        break;
      case "Home":
        e.preventDefault();
        els[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        els[els.length - 1]?.focus();
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
    }
  };

  return (
    // `pm-scope` on the wrapper itself: the project header's actions row is
    // outside the page's `.pm-scope` div (ShellPage renders it), and the menu
    // panel's `--bg-canvas` / `--border` tokens are defined there.
    <span className="pm-menu-wrap pm-scope" ref={wrapRef}>
      <button
        ref={(el) => {
          triggerRef.current = el;
          if (buttonRef) buttonRef.current = el;
        }}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onTriggerKeyDown}
      >
        <PmIcon name={icon} size={16} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className={"pm-menu" + (align === "left" ? " align-left" : " align-right")}
          onKeyDown={onMenuKeyDown}
        >
          {visible.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              className={"pm-menu-item" + (item.danger ? " danger" : "")}
              onClick={() => {
                // Focus goes back to the trigger BEFORE the action runs: an action
                // that opens a dialog records the focused element as the place to
                // return to, and a removed menu item is not one.
                close();
                item.onSelect();
              }}
            >
              {item.icon && <PmIcon name={item.icon} size={14} />}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
