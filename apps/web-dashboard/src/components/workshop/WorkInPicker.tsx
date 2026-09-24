"use client";
/**
 * WARP-2974 (ADR-056) — the composer's `Work in` chip.
 *
 * A menu button, not a native `<select>`: the browser draws a select's open
 * list itself (a light OS list on Windows), so none of the Workshop's tone
 * reaches it. This menu takes the Mac app's chrome (DropletAgent design spec
 * §5): a tone and a soft lift, no stroke; the chosen row carries a check, the
 * focused row a tonal fill.
 *
 * Accessibility: the WAI-ARIA menu-button pattern, as DepartmentSwitcher. The
 * trigger carries `aria-haspopup="menu"` and `aria-expanded`; the choices are
 * `menuitemradio` with exactly one `aria-checked`. Arrow keys, Home and End
 * move focus; Enter and Space pick; Escape closes and returns focus; Tab and
 * a click outside close.
 */
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Check, ChevronDown, Hammer } from "lucide-react";
import type { WorkspaceSummary } from "./workspaces/api";

export const NO_WORKSPACE_LABEL = "No workspace";

/** A menu at least this wide opens leftward from the chip's right edge —
 *  unless the chip sits too near the left edge (a narrow pill wraps it under
 *  the field), where it opens rightward instead. */
const MENU_MIN_WIDTH = 240;

interface Choice {
  id: string;
  label: string;
  caption: string;
}

export interface WorkInPickerProps {
  workspaces: WorkspaceSummary[];
  workspaceId: string;
  onWorkspaceId: (id: string) => void;
  disabled?: boolean;
}

export function WorkInPicker({ workspaces, workspaceId, onWorkspaceId, disabled }: WorkInPickerProps) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState<"end" | "start">("end");
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  // Only an active workspace takes a new run. The chip still names a chosen
  // workspace that is not (a `?workspace=` link to a proposed one), so what
  // it says always matches what Start would send.
  const choices: Choice[] = [
    { id: "", label: NO_WORKSPACE_LABEL, caption: "An ordinary run, across the box" },
    ...workspaces
      .filter((w) => w.status === "active")
      .map((w) => ({ id: w.id, label: w.name, caption: "Custom tool · a workshop run" })),
  ];
  const currentLabel = workspaces.find((w) => w.id === workspaceId)?.name ?? NO_WORKSPACE_LABEL;

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    setAlign(rect && rect.right < MENU_MIN_WIDTH ? "start" : "end");
    setOpen(true);
  };

  // A click anywhere outside closes the menu without stealing focus back.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, close]);

  // A run starting (or the composer locking) closes an open menu.
  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  // On open, focus the checked choice — the menu-button pattern's landing spot.
  useEffect(() => {
    if (!open) return;
    const items = menuItems(menuRef.current);
    (items.find((el) => el.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }, [open]);

  const pick = (id: string) => {
    onWorkspaceId(id);
    close(true);
  };

  const onButtonKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      openMenu();
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

  return (
    <div ref={rootRef} className="ws-workin-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="ws-workin"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Work in: ${currentLabel}`}
        title="An ordinary run works across the box. A custom tool's workspace makes it a workshop run."
        disabled={disabled}
        data-testid="workspace-picker"
        onClick={() => (open ? close(false) : openMenu())}
        onKeyDown={onButtonKeyDown}
      >
        <Hammer size={13} aria-hidden />
        <span className="ws-workin-label">{currentLabel}</span>
        <ChevronDown size={14} className="ws-workin-chevron" aria-hidden />
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Work in"
          className="ws-workin-menu"
          data-align={align}
          onKeyDown={onMenuKeyDown}
        >
          {choices.map((c, idx) => (
            <div key={c.id || "__none"} role="none">
              {idx === 1 && <div role="separator" className="ws-workin-sep" />}
              <button
                type="button"
                role="menuitemradio"
                aria-checked={c.id === workspaceId}
                tabIndex={-1}
                className="ws-workin-item"
                onClick={() => pick(c.id)}
              >
                <span className="ws-workin-item-text">
                  <span className="ws-workin-item-name">{c.label}</span>
                  <span className="ws-workin-item-caption">{c.caption}</span>
                </span>
                {c.id === workspaceId && <Check size={14} className="ws-workin-check" aria-hidden />}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (!menu) return [];
  return Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));
}
