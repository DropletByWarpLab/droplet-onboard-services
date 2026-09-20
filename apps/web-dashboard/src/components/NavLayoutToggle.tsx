"use client";

import { LayoutPanelTop, PanelLeft } from "lucide-react";
import { useNavLayout, type NavLayout } from "@/lib/nav-layout";

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
 */
export function NavLayoutToggle() {
  const { layout, setLayout } = useNavLayout();
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === layout),
  );

  const move = (delta: number) => {
    const n = options.length;
    setLayout(options[(activeIndex + delta + n) % n].value);
  };

  const handleKey = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case "Home":
        e.preventDefault();
        setLayout(options[0].value);
        break;
      case "End":
        e.preventDefault();
        setLayout(options[options.length - 1].value);
        break;
      case " ":
      case "Enter":
        e.preventDefault();
        setLayout(options[activeIndex].value);
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Navigation layout"
      className="flex items-center rounded-sm p-0.5 bg-[var(--inset)]"
    >
      {options.map((opt) => {
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
            onClick={() => setLayout(opt.value)}
            onKeyDown={handleKey}
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
