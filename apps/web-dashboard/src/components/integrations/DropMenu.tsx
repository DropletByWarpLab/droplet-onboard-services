"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * WARP-3965 — a small menu button for the Connectors pages (Add ▾, ⋯). The ARIA
 * menu-button pattern without a portal: the menu is absolutely positioned inside
 * the wrapper, closes on Escape or a press outside, and a disabled item stays
 * visible with its reason as the tooltip (a hidden item cannot explain itself).
 */
export interface DropMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  /** Tooltip shown on a disabled item. */
  reason?: string;
  danger?: boolean;
  /** Omitted entirely — for entries the role never sees. */
  hidden?: boolean;
}

export function DropMenu({
  label,
  trigger,
  items,
  align = "right",
  className = "btn",
}: {
  /** Accessible name of the trigger. */
  label: string;
  trigger: ReactNode;
  items: DropMenuItem[];
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  const visible = items.filter((i) => !i.hidden);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (visible.length === 0) return null;

  return (
    <span ref={wrap} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        className={className}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className="card"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            ...(align === "right" ? { right: 0 } : { left: 0 }),
            zIndex: 20,
            minWidth: 232,
            padding: 6,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {visible.map((i) => (
            <button
              key={i.id}
              type="button"
              role="menuitem"
              className="btn ghost"
              disabled={i.disabled}
              title={i.disabled ? i.reason : undefined}
              style={{ justifyContent: "flex-start", color: i.danger ? "var(--danger-ink)" : undefined }}
              onClick={() => {
                setOpen(false);
                i.onSelect();
              }}
            >
              {i.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
