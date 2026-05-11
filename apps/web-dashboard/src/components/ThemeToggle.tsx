"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/lib/theme";

const options: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "system", icon: Monitor, label: "Auto" },
  { value: "dark", icon: Moon, label: "Dark" },
];

/**
 * Theme picker. WARP-298 promoted this from "three unrelated buttons" to
 * the WAI-ARIA radiogroup pattern so SR users hear it as one mutually-
 * exclusive control and keyboard users can use Arrow / Home / End to move
 * through options (per https://www.w3.org/WAI/ARIA/apg/patterns/radio/).
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === theme),
  );

  const move = (delta: number) => {
    const n = options.length;
    const next = options[(activeIndex + delta + n) % n];
    setTheme(next.value);
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
        setTheme(options[0].value);
        break;
      case "End":
        e.preventDefault();
        setTheme(options[options.length - 1].value);
        break;
      // Space / Enter on a radio = activate (which already happens via the
      // implicit button click handler, but be explicit so we don't rely on
      // the browser's button-click-on-Space behaviour for role=radio).
      case " ":
      case "Enter":
        e.preventDefault();
        setTheme(options[activeIndex].value);
        break;
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      className="flex items-center bg-surface-secondary rounded-sm p-0.5"
    >
      {options.map((opt) => {
        const isActive = theme === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={isActive}
            aria-label={`${opt.label} theme`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => setTheme(opt.value)}
            onKeyDown={handleKey}
            className={`
              flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-[6px]
              text-[12px] font-medium transition-all duration-200 ease-smooth
              min-h-[32px] flex-1
              ${
                isActive
                  ? "bg-surface-tertiary text-label-primary shadow-sm"
                  : "text-label-tertiary hover:text-label-secondary"
              }
            `}
          >
            <Icon size={14} aria-hidden="true" />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
