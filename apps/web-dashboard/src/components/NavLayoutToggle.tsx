"use client";

import { LayoutPanelTop, PanelLeft } from "lucide-react";
import { useNavLayout, type NavLayout } from "@/lib/nav-layout";
import { useEffect, useRef } from "react";

const options: { value: NavLayout; icon: typeof PanelLeft; label: string }[] = [
  { value: "sidebar", icon: PanelLeft, label: "Sidebar" },
  { value: "workspace", icon: LayoutPanelTop, label: "Workspace tabs" },
];

/**
 * WARP-2971 — picks the navigation layout (see `lib/nav-layout.tsx`). The
 * same WAI-ARIA radiogroup `ThemeToggle` is (WARP-298): one mutually
 * exclusive control, Arrow / Home / End move through it, and it takes the
 * indigo shell surface tokens because it mounts in a Settings `.lrow`
 * (ThemeToggle's `fit="content"` posture, WARP-1344).
 *
 * WARP-3139 — focus follows the choice. AuthGate wraps the page in a
 * different shell per layout, so a choice here remounts this control and the
 * focused radio with it; the choice is handed across that remount through the
 * provider's `focusRequest`, and the checked radio takes focus back.
 */
export function NavLayoutToggle() {
  const { layout, setLayout, focusRequest } = useNavLayout();
  const group = useRef<HTMLDivElement>(null);

  // WARP-3139 — only a choice made in this control that actually changes the
  // layout asks for focus; re-choosing the current one has nothing to restore.
  const choose = (next: NavLayout) => {
    if (next !== layout) focusRequest.current = next;
    setLayout(next);
  };

  // Runs in the surviving instance, or on mount of the one AuthGate remounted.
  // A normal load or a layout change made elsewhere has no pending request, so
  // it never steals focus; consuming it makes StrictMode's re-run a no-op.
  useEffect(() => {
    if (focusRequest.current !== layout) return;
    focusRequest.current = null;
    group.current
      ?.querySelector<HTMLButtonElement>('[role="radio"][aria-checked="true"]')
      ?.focus();
  }, [layout, focusRequest]);

  // WARP-3139 — relative to the radio that received the key, not the checked
  // one: DOM focus can sit on an unchecked radio (a press dragged off before
  // it became a click, a screen reader's cursor).
  const handleKey = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const n = options.length;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        choose(options[(index + 1) % n].value);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        choose(options[(index - 1 + n) % n].value);
        break;
      case "Home":
        e.preventDefault();
        choose(options[0].value);
        break;
      case "End":
        e.preventDefault();
        choose(options[n - 1].value);
        break;
      case " ":
      case "Enter":
        e.preventDefault();
        choose(options[index].value);
        break;
    }
  };

  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label="Navigation layout"
      className="flex items-center rounded-sm p-0.5 bg-[var(--inset)]"
    >
      {options.map((opt, i) => {
        const isActive = layout === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={`${opt.label} navigation`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => choose(opt.value)}
            onKeyDown={(e) => handleKey(e, i)}
            className={`
              flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-[6px]
              text-[12px] font-medium transition-all duration-200 ease-smooth
              min-h-[32px]
              ${
                isActive
                  ? "bg-[var(--card-bg)] text-[var(--text)] shadow-sm"
                  : "text-[var(--text-muted)] hover:text-[var(--text)]"
              }
            `}
          >
            <Icon size={14} aria-hidden="true" className="flex-shrink-0" />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
