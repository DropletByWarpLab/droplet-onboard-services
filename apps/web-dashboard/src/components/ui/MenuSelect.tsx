"use client";
/**
 * WARP-3043 — a themed stand-in for a native `<select>` on a themed popover
 * or card (/chat's Memory panel, Context pins, the interview's review card).
 * The browser paints a select's open list itself, outside every token; this is
 * the menu-button pattern (useMenuButton) over pick-menu.css instead. The
 * trigger reads "{label}: {chosen}"; the items are `menuitemradio` with
 * exactly one `aria-checked`; a disabled option stays visible (a value the
 * caller may not choose, kept so the trigger never reads blank) but cannot be
 * picked.
 *
 * These controls sit inside scrolling lists (Memory's facts, the message
 * scroller), which would clip an absolutely placed list. So the menu is
 * `position: fixed`, placed from the trigger's box — below it when it fits,
 * else above — and a scroll that moves the trigger closes it. The placement is
 * measured against wherever `top: 0; left: 0` actually lands, because a
 * `backdrop-filter` ancestor (the Memory panel's glass) makes itself the
 * containing block of a fixed descendant.
 */
import { useEffect, useLayoutEffect } from "react";
import { Check, ChevronDown } from "lucide-react";
import { useMenuButton } from "./useMenuButton";
import "./pick-menu.css";

export interface MenuSelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface MenuSelectProps<T extends string> {
  /** The control's name: the trigger reads "{label}: {chosen}", the menu is named {label}. */
  label: string;
  value: T;
  options: readonly MenuSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  title?: string;
  id?: string;
  /** Size and type classes for the trigger; its tone is `.pick-select`'s. */
  className?: string;
}

/** Space kept between the trigger and the menu, and from the viewport edge. */
const GAP = 8;

export function MenuSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  title,
  id,
  className,
}: MenuSelectProps<T>) {
  const menu = useMenuButton({ disabled });
  const chosen = options.find((o) => o.value === value)?.label ?? value;

  useLayoutEffect(() => {
    const m = menu.menuRef.current;
    const b = menu.buttonRef.current;
    if (!menu.open || !m || !b) return;
    m.style.top = "0px";
    m.style.left = "0px";
    const origin = m.getBoundingClientRect();
    const t = b.getBoundingClientRect();
    const below = window.innerHeight - t.bottom - GAP;
    const top = below >= origin.height || below >= t.top - GAP ? t.bottom + GAP : t.top - GAP - origin.height;
    const left = Math.max(GAP, Math.min(t.left, window.innerWidth - GAP - origin.width));
    m.style.top = `${top - origin.top}px`;
    m.style.left = `${left - origin.left}px`;
  }, [menu.open, menu.menuRef, menu.buttonRef]);

  // A fixed menu does not follow its trigger: any scroll but the menu's own,
  // or a resize, closes it.
  const { open, close, menuRef } = menu;
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      if (!menuRef.current?.contains(e.target as Node)) close(false);
    };
    const onResize = () => close(false);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, close, menuRef]);

  const pick = (o: MenuSelectOption<T>) => {
    if (o.disabled) return;
    // As a select: re-choosing the current value is not a change.
    if (o.value !== value) onChange(o.value);
    menu.close(true);
  };

  return (
    <div ref={menu.rootRef} className="pick-select-wrap">
      <button
        ref={menu.buttonRef}
        id={id}
        type="button"
        className={`pick-select${className ? ` ${className}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menu.menuId : undefined}
        aria-label={`${label}: ${chosen}`}
        title={title}
        disabled={disabled}
        onClick={menu.onButtonClick}
        onKeyDown={menu.onButtonKeyDown}
      >
        <span className="pick-select-value">{chosen}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {menu.open && (
        <div
          ref={menu.menuRef}
          id={menu.menuId}
          role="menu"
          aria-label={label}
          className="pick-menu"
          data-placement="fixed"
          onKeyDown={menu.onMenuKeyDown}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="menuitemradio"
              aria-checked={o.value === value}
              aria-disabled={o.disabled || undefined}
              tabIndex={-1}
              className="pick-item"
              onClick={() => pick(o)}
            >
              <span className="pick-item-text">
                <span className="pick-item-name">{o.label}</span>
              </span>
              {o.value === value && <Check size={14} className="pick-check" aria-hidden="true" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
