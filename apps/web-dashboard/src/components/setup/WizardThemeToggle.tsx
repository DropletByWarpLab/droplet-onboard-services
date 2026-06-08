"use client";

import { Moon, Sun } from "lucide-react";
import { useOptionalTheme } from "@/lib/theme";

/**
 * Light / dark toggle for the first-run wizard (Onboarding-Flow redesign,
 * WIFI-ADDRESS-THEME-HANDOFF §2).
 *
 * The wizard frame paints itself entirely from the design tokens, and the
 * dashboard already ships dark tokens behind the `.dark` document class, so the
 * toggle is pure client state — it flips the SAME shared preference the rest of
 * the dashboard reads. We reuse `useTheme()` (persists to
 * `localStorage["droplet-theme"]`, honours `prefers-color-scheme`, applies the
 * `.dark` class) rather than re-implementing theme state inside the wizard.
 *
 * Two variants so the one control reads correctly on both wizard surfaces:
 *   · `aurora` — white-on-glass, for the dark aurora rail footer.
 *   · `plain`  — for the light mobile progress header.
 *
 * It is a two-option toggle (light · dark) mirroring the mock; the shared hook's
 * third "system" value still works elsewhere — choosing here just pins an
 * explicit preference. Active state reads off `resolvedTheme` so a `system`
 * default still lights the matching pill. `aria-pressed` + a visible focus ring
 * keep it operable by keyboard and screen reader.
 */
export function WizardThemeToggle({
  variant = "aurora",
  compact = false,
}: {
  variant?: "aurora" | "plain";
  compact?: boolean;
}) {
  // Optional so a step component rendered in isolation under unit test (no root
  // ThemeProvider) doesn't throw — the toggle simply doesn't render there.
  const theme = useOptionalTheme();
  const aurora = variant === "aurora";
  if (!theme) return null;
  const { resolvedTheme, setTheme } = theme;
  const opts: { value: "light" | "dark"; Icon: typeof Sun; label: string }[] = [
    { value: "light", Icon: Sun, label: "Light" },
    { value: "dark", Icon: Moon, label: "Dark" },
  ];

  return (
    <div
      role="group"
      aria-label="Appearance"
      className={`inline-flex flex-none gap-0.5 rounded-full p-0.5 ${
        aurora
          ? "border border-white/20 bg-white/[0.12]"
          : "border border-separator bg-surface-secondary"
      }`}
    >
      {opts.map(({ value, Icon, label }) => {
        const on = resolvedTheme === value;
        return (
          <button
            key={value}
            type="button"
            onClick={() => setTheme(value)}
            aria-pressed={on}
            aria-label={`${label} theme`}
            className={`inline-flex items-center justify-center gap-1.5 rounded-full font-semibold transition-colors duration-200 ease-smooth focus-visible:outline-none focus-visible:ring-2 ${
              compact ? "min-h-[30px] px-2.5 text-[11.5px]" : "min-h-[36px] px-3 text-[12px]"
            } ${
              aurora
                ? on
                  ? "bg-white text-accent focus-visible:ring-white/70"
                  : "text-white/70 hover:text-white focus-visible:ring-white/70"
                : on
                  ? "bg-surface-primary text-label-primary shadow-sm focus-visible:ring-accent"
                  : "text-label-tertiary hover:text-label-secondary focus-visible:ring-accent"
            }`}
          >
            <Icon size={14} aria-hidden="true" />
            {!compact && <span>{label}</span>}
          </button>
        );
      })}
    </div>
  );
}
