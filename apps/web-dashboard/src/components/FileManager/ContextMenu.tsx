"use client";

import { useEffect, useRef } from "react";
import {
  FolderOpen,
  Download,
  Edit3,
  Copy,
  Scissors,
  Trash2,
  Link as LinkIcon,
  History,
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

export type ContextMenuItem = ContextMenuAction | ContextMenuSeparator;

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/**
 * Simple anchored popover with keyboard + outside-click dismissal.
 * Positions itself to stay within the viewport if opened near an edge.
 */
export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

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
  }, [x, y]);

  return (
    <div
      ref={ref}
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
        const action = item as ContextMenuAction;
        const Icon = action.icon;
        return (
          <button
            key={`${action.label}-${idx}`}
            type="button"
            disabled={action.disabled}
            onClick={() => {
              if (!action.disabled) {
                action.onClick();
                onClose();
              }
            }}
            style={
              action.destructive && !action.disabled
                ? { color: "var(--danger)" }
                : undefined
            }
            className={`w-full flex items-center gap-3 px-3 py-2 text-left text-[13px]
              transition-colors duration-150 ease-smooth
              ${
                action.disabled
                  ? "cursor-not-allowed text-[color:var(--text-faint)]"
                  : action.destructive
                  ? "hover:bg-[rgba(239,68,68,0.12)] hover:text-[#ef4444]"
                  : "text-[color:var(--text)] hover:bg-[var(--hover)]"
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
};
