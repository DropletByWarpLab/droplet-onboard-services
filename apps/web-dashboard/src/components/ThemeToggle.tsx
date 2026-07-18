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
 *
 * `fit` (WARP-1344):
 *   · "fill" (default) — the legacy Sidebar/setup behavior: segments are
 *     `flex-1 min-w-0` with a `truncate`d label so the group fits the 260px
 *     rail and a pathological label ellipsizes instead of overflowing.
 *   · "content" — for the Settings `.lrow` mount, where the fill squeeze
 *     compressed the group to min-content and clipped "Light" to "Li…".
 *     Segments size to their labels (never clip) and the control takes the
 *     indigo shell surface tokens instead of the legacy bg-surface-* ramp.
 */
export function ThemeToggle({ fit = "fill" }: { fit?: "fill" | "content" }) {
  const { theme, setTheme } = useTheme();
  const fitContent = fit === "content";
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
      className={`flex items-center rounded-sm p-0.5 ${
        fitContent ? "bg-[var(--inset)]" : "bg-surface-secondary"
      }`}
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
              flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-[6px]
              text-[12px] font-medium transition-all duration-200 ease-smooth
              min-h-[32px] ${fitContent ? "" : "flex-1 min-w-0"}
              ${
                isActive
                  ? fitContent
                    ? "bg-[var(--card-bg)] text-[var(--text)] shadow-sm"
                    : "bg-surface-tertiary text-label-primary shadow-sm"
                  : fitContent
                    ? "text-[var(--text-muted)] hover:text-[var(--text)]"
                    : "text-label-tertiary hover:text-label-secondary"
              }
            `}
          >
            <Icon size={14} aria-hidden="true" className="flex-shrink-0" />
            {/* fill: px-2 (not 3) + min-w-0 + truncate — in the 260px sidebar
                the three labelled segments had ~1px of slack at default Chrome
                metrics; wider font rendering (Firefox, OS font scaling,
                Android font boosting) pushed the labels out of the pill and
                over the rail edge. Give the row real headroom and let a
                pathological label ellipsize instead of overlapping.
                content: segments size to their labels, so truncation is
                neither needed nor wanted (it clipped "Light" to "Li…" on the
                Settings row — WARP-1344). */}
            <span className={`hidden sm:inline ${fitContent ? "" : "truncate"}`}>
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
