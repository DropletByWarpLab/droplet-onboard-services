"use client";

/**
 * Accent color preference — user-selectable, replaces the previous
 * brand-locked violet.
 *
 * Stefan 2026-05-18: users should be able to pick their accent color
 * via Settings → Appearance. ADR-003's violet remains the DEFAULT
 * (and the brand color in marketing assets), but per-user accent
 * preference is a personalization layer on top.
 *
 * Storage: `localStorage["droplet-accent"]` (mirrors the useTheme +
 * useWorkspace pattern). Cross-tab synced via `storage` event. SSR-
 * safe — first paint uses the default until the client mounts.
 *
 * Mechanism: the AccentProvider mounts a `<style>` element that sets
 * the CSS variables (--color-accent, --color-accent-hover,
 * --color-accent-subtle, --shadow-hero) at `:root`. Every existing
 * `text-accent` / `bg-accent` / `dp-tile-interactive:hover` / etc.
 * call site re-paints automatically because they read those
 * variables. NO component code changes required for the swap.
 *
 * Role colors (--role-owner / --role-admin / …) are deliberately
 * NOT swapped — those are identity tokens (Business workspace
 * persona), not personalization. Same reason a corporate identity
 * doesn't change colors when you pick a desktop theme.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export interface AccentPreset {
  /** Stable identifier persisted in localStorage. */
  id: string;
  /** Display label in the picker UI. */
  label: string;
  /** Primary accent — used by buttons, focus rings, active states. */
  accent: string;
  /** Hover / pressed state. ~10% darker than `accent` in light mode. */
  accentHover: string;
  /** Subtle tint for active-nav backgrounds, role pills, etc. */
  accentSubtle: string;
  /**
   * Glow color under the AI hero capsule. RGBA-as-string is awkward
   * inside a CSS var so we precompute the full shadow string.
   */
  shadowHero: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  {
    id: "violet",
    label: "Violet",
    accent: "#6d28d9",
    accentHover: "#5b21b6",
    accentSubtle: "rgba(109, 40, 217, 0.10)",
    shadowHero: "0 30px 80px -40px rgba(109, 40, 217, 0.35)",
  },
  {
    id: "purple",
    label: "Electric purple",
    accent: "#bc13fe",
    accentHover: "#9a0fcc",
    accentSubtle: "rgba(188, 19, 254, 0.10)",
    shadowHero: "0 30px 80px -40px rgba(188, 19, 254, 0.35)",
  },
  {
    id: "indigo",
    label: "Indigo",
    accent: "#6366f1",
    accentHover: "#4f46e5",
    accentSubtle: "rgba(99, 102, 241, 0.10)",
    shadowHero: "0 30px 80px -40px rgba(99, 102, 241, 0.35)",
  },
  {
    id: "blue",
    label: "Blue",
    accent: "#2563eb",
    accentHover: "#1d4ed8",
    accentSubtle: "rgba(37, 99, 235, 0.10)",
    shadowHero: "0 30px 80px -40px rgba(37, 99, 235, 0.35)",
  },
  {
    id: "cyan",
    label: "Cyan",
    accent: "#0891b2",
    accentHover: "#0e7490",
    accentSubtle: "rgba(8, 145, 178, 0.10)",
    shadowHero: "0 30px 80px -40px rgba(8, 145, 178, 0.35)",
  },
  {
    id: "emerald",
    label: "Emerald",
    accent: "#10b981",
    accentHover: "#059669",
    accentSubtle: "rgba(16, 185, 129, 0.10)",
    shadowHero: "0 30px 80px -40px rgba(16, 185, 129, 0.35)",
  },
  {
    id: "amber",
    label: "Amber",
    accent: "#d97706",
    accentHover: "#b45309",
    accentSubtle: "rgba(217, 119, 6, 0.10)",
    shadowHero: "0 30px 80px -40px rgba(217, 119, 6, 0.35)",
  },
  {
    id: "rose",
    label: "Rose",
    accent: "#e11d48",
    accentHover: "#be123c",
    accentSubtle: "rgba(225, 29, 72, 0.10)",
    shadowHero: "0 30px 80px -40px rgba(225, 29, 72, 0.35)",
  },
];

const DEFAULT_ACCENT_ID = "violet";

interface AccentContextValue {
  accent: AccentPreset;
  accentId: string;
  setAccentId: (id: string) => void;
  presets: AccentPreset[];
}

const AccentContext = createContext<AccentContextValue | undefined>(undefined);

const STORAGE_KEY = "droplet-accent";

function findPreset(id: string | null | undefined): AccentPreset {
  const p = ACCENT_PRESETS.find((x) => x.id === id);
  return p ?? ACCENT_PRESETS.find((x) => x.id === DEFAULT_ACCENT_ID)!;
}

function readStored(): string {
  if (typeof window === "undefined") return DEFAULT_ACCENT_ID;
  return window.localStorage.getItem(STORAGE_KEY) ?? DEFAULT_ACCENT_ID;
}

export function AccentProvider({ children }: { children: ReactNode }) {
  const [accentId, setAccentIdState] = useState<string>(readStored);

  // Cross-tab sync — picking a different accent in one tab updates
  // every other open tab without a reload.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      setAccentIdState(e.newValue ?? DEFAULT_ACCENT_ID);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const setAccentId = useCallback((id: string) => {
    setAccentIdState(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Private mode — preference is per-session.
    }
  }, []);

  const accent = useMemo(() => findPreset(accentId), [accentId]);

  // Inject the chosen accent into :root via a <style> element. Using
  // CSS variables instead of inline styles on every component means
  // every `text-accent` / `bg-accent` / `border-accent` Tailwind
  // utility AND every `var(--color-accent)` in globals.css re-paints
  // for free. No component refactor needed.
  //
  // Both `:root` (light mode) and `.dark :root` would be affected,
  // but light/dark accents differ — light gets the brand color, dark
  // gets a brightened sibling. Per accent preset we ONLY set the
  // base; the existing `.dark` block in globals.css still applies its
  // dark-mode adjustment to the brightness, but using the new base.
  // To keep this v0.1 simple we override BOTH light and dark with
  // the same preset color; the next iteration can compute a brighter
  // sibling for the dark scheme.
  const css = useMemo(
    () => `
:root, .dark {
  --color-accent: ${accent.accent};
  --color-accent-hover: ${accent.accentHover};
  --color-accent-subtle: ${accent.accentSubtle};
  --shadow-hero: ${accent.shadowHero};
}
`,
    [accent],
  );

  const value = useMemo<AccentContextValue>(
    () => ({ accent, accentId, setAccentId, presets: ACCENT_PRESETS }),
    [accent, accentId, setAccentId],
  );

  return (
    <AccentContext.Provider value={value}>
      {/* Inline <style> tag is the cheapest way to inject CSS that
          targets pseudo-classes (:root) — Next.js's <style jsx
          global> would also work but pulls in a runtime. */}
      <style data-droplet-accent={accentId}>{css}</style>
      {children}
    </AccentContext.Provider>
  );
}

export function useAccent(): AccentContextValue {
  const ctx = useContext(AccentContext);
  if (!ctx) throw new Error("useAccent must be used within AccentProvider");
  return ctx;
}
