"use client";

/**
 * WARP-2976 (ADR-059 §2.3) — the department switcher.
 *
 * ONE component for both shells: the top of the sidebar (and its 64px icon
 * rail), the top of the phone's More drawer, and the Workspace-tabs header.
 *
 * What it does, and all it does:
 *   · shows the department the shell is arranged around, or Whole business;
 *   · picking a department opens its home (`/d/<slug>`) and makes it active,
 *     which narrows the nav to that department's profile ∩ the existing gates;
 *   · picking Whole business opens `/` and restores today's nav;
 *   · owner/admin also get a way to the Business overview (`/d`).
 * It SHOWS; it never grants. Nothing here changes what a person may reach.
 *
 * It renders nothing below two choices (`showSwitcher`) — a control with one
 * option is a dead control. Whole business is always a choice, so that means
 * "renders nothing for a person in no department".
 *
 * Accessibility: the WAI-ARIA menu-button pattern. The trigger carries
 * `aria-haspopup="menu"` and `aria-expanded`; the choices are
 * `menuitemradio` with `aria-checked` (exactly one is checked), and the
 * overview is a plain `menuitem` after a separator. Arrow keys, Home and End
 * move focus; Enter and Space pick; Escape and Tab close and return focus.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronsUpDown, LayoutGrid, PanelsTopLeft, type LucideIcon } from "lucide-react";

import { useActiveDepartment } from "@/lib/departments/active-department";
import { departmentHomeHref } from "@/lib/departments/department-nav";
import { departmentIcon } from "@/lib/departments/templates";

import "@/components/shell/indigo-tokens.css";
import "./department-switcher.css";

export const WHOLE_BUSINESS_LABEL = "Whole business";
export const NOT_SET_UP_CAPTION = "Not set up";

export type DepartmentSwitcherVariant = "sidebar" | "rail" | "drawer" | "header";

interface Entry {
  key: string;
  label: string;
  caption?: string;
  icon: LucideIcon;
  /** `null` for the overview link, which is not a choice. */
  checked: boolean | null;
  onSelect: () => void;
}

export function DepartmentSwitcher({
  variant = "sidebar",
  className,
  onNavigate,
}: {
  variant?: DepartmentSwitcherVariant;
  /** Wrapper spacing from the host — applied only when the switcher renders,
   *  so a viewer without one gets no stray padding. */
  className?: string;
  /** Called after a choice navigates (the drawer closes itself with it). */
  onNavigate?: () => void;
}) {
  const { choices, active, canSeeOverview, showSwitcher, setActive } =
    useActiveDepartment();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  // A click anywhere outside closes the menu without stealing focus back.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  // On open, focus the checked choice (or the first) — the menu-button
  // pattern's landing spot.
  useEffect(() => {
    if (!open) return;
    const items = menuItems(menuRef.current);
    const checked = items.find((el) => el.getAttribute("aria-checked") === "true");
    (checked ?? items[0])?.focus();
  }, [open]);

  if (!showSwitcher) return null;

  const go = (href: string) => {
    close(false);
    router.push(href);
    onNavigate?.();
  };

  const entries: Entry[] = [
    {
      key: "__whole",
      label: WHOLE_BUSINESS_LABEL,
      icon: LayoutGrid,
      checked: active === null,
      onSelect: () => {
        setActive(null);
        go("/");
      },
    },
  ];
  for (const d of choices) {
    entries.push({
      key: d.id,
      label: d.name,
      // Only a POSITIVE null is "not set up"; an absent key is unknown.
      caption: d.profile === null ? NOT_SET_UP_CAPTION : undefined,
      icon: departmentIcon(d.profile?.icon),
      checked: active?.id === d.id,
      onSelect: () => {
        setActive(d.slug);
        go(departmentHomeHref(d.slug));
      },
    });
  }

  const current = active
    ? { label: active.name, icon: departmentIcon(active.profile?.icon) }
    : { label: WHOLE_BUSINESS_LABEL, icon: LayoutGrid };
  const CurrentIcon = current.icon;

  const onButtonKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(true);
    }
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = menuItems(menuRef.current);
    const i = items.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    switch (e.key) {
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
      case "Escape":
        e.preventDefault();
        close(true);
        return;
      case "Tab":
        close(false);
        return;
      default:
        return;
    }
    e.preventDefault();
    items[next]?.focus();
  };

  const isRail = variant === "rail";

  return (
    <div
      ref={rootRef}
      className={"dept-switcher" + (className ? ` ${className}` : "")}
      data-variant={variant}
    >
      <button
        ref={buttonRef}
        type="button"
        className="dept-switcher-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Department: ${current.label}`}
        title={isRail ? current.label : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={onButtonKeyDown}
      >
        <span className="dept-switcher-glyph" aria-hidden="true">
          <CurrentIcon size={isRail ? 16 : 15} />
        </span>
        {!isRail && (
          <>
            <span className="dept-switcher-label">{current.label}</span>
            <ChevronsUpDown size={14} className="dept-switcher-chevron" aria-hidden="true" />
          </>
        )}
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Departments"
          className="dept-switcher-menu"
          onKeyDown={onMenuKeyDown}
        >
          {entries.map((entry) => {
            const Icon = entry.icon;
            return (
              <button
                key={entry.key}
                type="button"
                role="menuitemradio"
                aria-checked={entry.checked === true}
                tabIndex={-1}
                className="dept-switcher-item"
                onClick={entry.onSelect}
              >
                <span className="dept-switcher-glyph" aria-hidden="true">
                  <Icon size={14} />
                </span>
                <span className="dept-switcher-item-text">
                  <span className="dept-switcher-item-name">{entry.label}</span>
                  {entry.caption && (
                    <span className="dept-switcher-item-caption">{entry.caption}</span>
                  )}
                </span>
                {entry.checked && (
                  <Check size={14} className="dept-switcher-check" aria-hidden="true" />
                )}
              </button>
            );
          })}
          {canSeeOverview && (
            <>
              <div role="separator" className="dept-switcher-sep" />
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                className="dept-switcher-item"
                onClick={() => go("/d")}
              >
                <span className="dept-switcher-glyph" aria-hidden="true">
                  <PanelsTopLeft size={14} />
                </span>
                <span className="dept-switcher-item-text">
                  <span className="dept-switcher-item-name">Business overview</span>
                </span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(
    menu.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]'),
  );
}
