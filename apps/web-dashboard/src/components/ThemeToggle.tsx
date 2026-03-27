"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type Theme } from "@/lib/theme";

const options: { value: Theme; icon: typeof Sun; label: string }[] = [
  { value: "light", icon: Sun, label: "Light" },
  { value: "system", icon: Monitor, label: "Auto" },
  { value: "dark", icon: Moon, label: "Dark" },
];

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex items-center bg-surface-secondary rounded-sm p-0.5">
      {options.map((opt) => {
        const isActive = theme === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            onClick={() => setTheme(opt.value)}
            aria-label={`${opt.label} theme`}
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
            <Icon size={14} />
            <span className="hidden sm:inline">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
