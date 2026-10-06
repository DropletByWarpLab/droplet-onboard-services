"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  FolderOpen,
  Download,
  Edit3,
  Copy,
  Scissors,
  Trash2,
  Link as LinkIcon,
  History,
  Palette,
  FolderPlus,
  Upload,
  ClipboardPaste,
  type LucideIcon,
} from "lucide-react";

export interface ContextMenuAction {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
  separator?: false;
}

export interface ContextMenuSeparator {
  separator: true;
}

/**
 * A menu entry that expands, in place, into a row of colour swatches
 * ("Color ▸"). Inline rather than a flyout so it can never fall off a narrow
 * viewport and works the same for touch, pointer and keyboard.
 */
export interface ContextMenuSwatchGroup {
  label: string;
  icon: LucideIcon;
  swatches: {
    label: string;
    /** CSS colour; omit for the "no colour" swatch. */
    css?: string;
    selected?: boolean;
    onSelect: () => void;
  }[];
  separator?: false;
}

export type ContextMenuItem =
  | ContextMenuAction
  | ContextMenuSeparator
  | ContextMenuSwatchGroup;

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Anchored popover with keyboard + outside-click dismissal.
 * Positions itself to stay within the viewport if opened near an edge.
 *
 * Keyboard: focus lands on the first enabled item; ArrowUp/ArrowDown/Home/End
 * move, Enter/Space activate, Esc closes (and hands focus back to whatever
 * opened it), Tab closes. A swatch group opens with ArrowRight/Enter/Space and
 * closes with ArrowLeft/Esc.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const focusSwatchesOnExpand = useRef(false);

  const topItems = () =>
    Array.from(
      ref.current?.querySelectorAll<HTMLElement>("[data-cm-top]:not(:disabled)") ?? []
    );
  const swatchButtons = () =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-cm-sub]") ?? []);

  // Focus the first enabled item on open; give focus back on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    topItems()[0]?.focus();
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
  }, []);

  // Keyboard-driven expand: once the swatch row exists, move focus into it.
  useEffect(() => {
    if (expanded !== null && focusSwatchesOnExpand.current) {
      focusSwatchesOnExpand.current = false;
      const subs = swatchButtons();
      (subs.find((b) => b.getAttribute("aria-checked") === "true") ?? subs[0])?.focus();
    }
  }, [expanded]);

  const handleMenuKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.hasAttribute("data-cm-sub")) {
      const subs = swatchButtons();
      const i = subs.indexOf(target);
      if (e.key === "ArrowRight") {
        e.preventDefault();
        subs[(i + 1) % subs.length]?.focus();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (i === 0) {
          const parent = ref.current?.querySelector<HTMLElement>("[aria-expanded='true']");
          setExpanded(null);
          parent?.focus();
        } else {
          subs[i - 1]?.focus();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const parent = ref.current?.querySelector<HTMLElement>("[aria-expanded='true']");
        setExpanded(null);
        parent?.focus();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // Leave the swatch row for the neighbouring item.
        e.preventDefault();
        const parent = ref.current?.querySelector<HTMLElement>("[aria-expanded='true']");
        const tops = topItems();
        const at = parent ? tops.indexOf(parent) : -1;
        const next = e.key === "ArrowDown" ? at + 1 : at - 1;
        tops[(next + tops.length) % tops.length]?.focus();
      }
      return;
    }
    const tops = topItems();
    const i = tops.indexOf(target);
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        tops[(i + 1) % tops.length]?.focus();
        return;
      case "ArrowUp":
        e.preventDefault();
        tops[(i - 1 + tops.length) % tops.length]?.focus();
        return;
      case "Home":
        e.preventDefault();
        tops[0]?.focus();
        return;
      case "End":
        e.preventDefault();
        tops[tops.length - 1]?.focus();
        return;
      case "Tab":
        e.preventDefault();
        onClose();
        return;
      case "ArrowRight":
      case "ArrowLeft": {
        if (target.getAttribute("aria-haspopup") !== "menu") return;
        e.preventDefault();
        const idx = Number(target.getAttribute("data-cm-idx"));
        if (e.key === "ArrowRight") {
          focusSwatchesOnExpand.current = true;
          if (expanded === idx) {
            focusSwatchesOnExpand.current = false;
            const subs = swatchButtons();
            (subs.find((b) => b.getAttribute("aria-checked") === "true") ?? subs[0])?.focus();
          } else {
            setExpanded(idx);
          }
        } else {
          setExpanded(null);
        }
      }
    }
  };

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  useEffect(() => {
    if (!ref.current) return;
    // Clamp to viewport
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw) left = vw - rect.width - 8;
    if (top + rect.height > vh) top = vh - rect.height - 8;
    ref.current.style.left = `${left}px`;
    ref.current.style.top = `${top}px`;
  }, [x, y, expanded]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label="Actions"
      onKeyDown={handleMenuKeyDown}
      className="card fixed z-50 min-w-[200px] animate-slide-up"
      style={{
        left: x,
        top: y,
        padding: "4px 0",
        background: "var(--glass)",
        backdropFilter: "blur(20px) saturate(150%)",
        WebkitBackdropFilter: "blur(20px) saturate(150%)",
        border: "1px solid var(--card-bd)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--lift)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, idx) => {
        if ("separator" in item && item.separator) {
          return (
            <div
              key={`sep-${idx}`}
              className="h-px my-1 mx-2"
              style={{ background: "var(--card-bd)" }}
            />
          );
        }
        if ("swatches" in item) {
          const group = item;
          const GroupIcon = group.icon;
          const isOpen = expanded === idx;
          return (
            <div key={`${group.label}-${idx}`}>
              <button
                type="button"
                role="menuitem"
                data-cm-top=""
                data-cm-idx={idx}
                aria-haspopup="menu"
                aria-expanded={isOpen}
                onClick={() => {
                  focusSwatchesOnExpand.current = false;
                  setExpanded(isOpen ? null : idx);
                }}
                tabIndex={-1}
                className="w-full flex items-center gap-3 px-3 py-2 text-left text-[13px] text-[color:var(--text)] hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)] focus-visible:outline-none transition-colors duration-150 ease-smooth"
              >
                <GroupIcon size={14} />
                <span className="flex-1">{group.label}</span>
                <ChevronRight
                  size={14}
                  className={`transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}
                />
              </button>
              {isOpen && (
                <div
                  role="group"
                  aria-label={group.label}
                  className="flex flex-wrap items-center gap-2 px-3 pb-2 pt-1"
                >
                  {group.swatches.map((sw) => (
                    <button
                      key={sw.label}
                      type="button"
                      role="menuitemradio"
                      aria-checked={!!sw.selected}
                      aria-label={sw.label}
                      title={sw.label}
                      data-cm-sub=""
                      tabIndex={-1}
                      onClick={() => {
                        sw.onSelect();
                        onClose();
                      }}
                      className={`w-5 h-5 rounded-full flex items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] focus-visible:ring-offset-1 ${sw.selected ? "ring-2 ring-[var(--brand)]" : ""}`}
                      style={{
                        background: sw.css ?? "transparent",
                        border: sw.css
                          ? "1px solid rgba(0,0,0,0.15)"
                          : "1.5px dashed var(--text-faint)",
                      }}
                    >
                      {!sw.css && (
                        <span aria-hidden="true" className="text-[11px] leading-none text-[color:var(--text-muted)]">
                          ×
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        }
        const action = item as ContextMenuAction;
        const Icon = action.icon;
        return (
          <button
            key={`${action.label}-${idx}`}
            type="button"
            role="menuitem"
            data-cm-top=""
            tabIndex={-1}
            disabled={action.disabled}
            onClick={() => {
              if (!action.disabled) {
                action.onClick();
                onClose();
              }
            }}
            style={
              action.destructive && !action.disabled
                ? { color: "var(--danger-ink)" }
                : undefined
            }
            className={`w-full flex items-center gap-3 px-3 py-2 text-left text-[13px]
              transition-colors duration-150 ease-smooth focus-visible:outline-none
              ${
                action.disabled
                  ? "cursor-not-allowed text-[color:var(--text-faint)]"
                  : action.destructive
                  ? "hover:bg-[rgba(239,68,68,0.12)] hover:text-[#ef4444] focus-visible:bg-[rgba(239,68,68,0.12)]"
                  : "text-[color:var(--text)] hover:bg-[var(--hover)] focus-visible:bg-[var(--hover)]"
              }`}
          >
            <Icon size={14} />
            <span className="flex-1">{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// Re-export the standard icons so page code can build menus without a second import
export const contextMenuIcons = {
  Open: FolderOpen,
  Download,
  Rename: Edit3,
  Copy,
  Cut: Scissors,
  Delete: Trash2,
  Share: LinkIcon,
  Versions: History,
  Color: Palette,
  NewFolder: FolderPlus,
  Upload,
  Paste: ClipboardPaste,
};
