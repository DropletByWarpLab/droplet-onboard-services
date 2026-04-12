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
      className="fixed z-50 min-w-[200px] dp-card dp-material py-1 animate-slide-up"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, idx) => {
        if ("separator" in item && item.separator) {
          return (
            <div
              key={`sep-${idx}`}
              className="h-px bg-separator my-1 mx-2"
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
            className={`w-full flex items-center gap-3 px-3 py-2 type-subheadline text-left
              transition-colors duration-150 ease-smooth
              ${
                action.disabled
                  ? "text-label-quaternary cursor-not-allowed"
                  : action.destructive
                  ? "text-system-red hover:bg-system-red/10"
                  : "text-label-primary hover:bg-surface-secondary"
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
