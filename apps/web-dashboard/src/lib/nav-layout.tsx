"use client";

/**
 * WARP-2971 — which navigation shell a person sees.
 *
 *   sidebar    the left rail + mobile tab bar (`components/Sidebar.tsx`),
 *              the default and the shape every shipped box renders today
 *   workspace  the handoff's three-level top-tab shell
 *              (`components/workspace/WorkspaceShell.tsx`)
 *   assistant  WARP-3062 — opens on Ask AI, with an "Ask AI | Overview"
 *              switch at the top that crosses to the business side, which
 *              is the sidebar layout's own nav, unchanged
 *              (`components/assistant/AssistantShell.tsx`)
 *
 * A per-person DISPLAY preference, persisted exactly like the theme
 * (`lib/theme.tsx`): localStorage on this browser, no server round-trip,
 * because it changes how the same routes are presented and nothing about
 * what the person may reach. Every layout resolves the same `nav-config.ts`
 * gates, so switching can never widen access.
 *
 * Unlike `useTheme`, the hook does NOT throw outside its provider — it
 * answers `sidebar`. `AuthGate` reads it on every protected render, and the
 * gate's tests mount it without the root layout's providers; a missing
 * provider must mean "the default shell", not a crash.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type NavLayout = "sidebar" | "workspace" | "assistant";

export const NAV_LAYOUT_STORAGE_KEY = "droplet-nav-layout";
// WARP-3062 leaves this alone: the assistant layout is opt-in first, so
// nobody's screen changes until they pick it in Settings → Appearance.
export const DEFAULT_NAV_LAYOUT: NavLayout = "sidebar";

export function isNavLayout(value: unknown): value is NavLayout {
  return value === "sidebar" || value === "workspace" || value === "assistant";
}

interface NavLayoutContextValue {
  layout: NavLayout;
  setLayout: (layout: NavLayout) => void;
}

const NavLayoutContext = createContext<NavLayoutContextValue>({
  layout: DEFAULT_NAV_LAYOUT,
  setLayout: () => {},
});

export function NavLayoutProvider({ children }: { children: React.ReactNode }) {
  // Starts at the default on BOTH server and client and adopts the stored
  // value after mount. The theme provider reads localStorage in its state
  // initialiser, which it can afford because the theme is a class on <html>
  // (guarded by suppressHydrationWarning); this preference swaps the whole
  // shell, and a server/client disagreement there is a hydration error. The
  // switch lands before anything shell-shaped paints — AuthGate holds every
  // protected route behind its loading state until the session probe
  // resolves, which is at least one tick after this effect.
  const [layout, setLayoutState] = useState<NavLayout>(DEFAULT_NAV_LAYOUT);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(NAV_LAYOUT_STORAGE_KEY);
      if (isNavLayout(stored)) setLayoutState(stored);
    } catch {
      // Storage unavailable (private mode, blocked) — stay on the default.
    }
  }, []);

  const setLayout = useCallback((next: NavLayout) => {
    setLayoutState(next);
    try {
      localStorage.setItem(NAV_LAYOUT_STORAGE_KEY, next);
    } catch {
      // Same: the choice still applies for this session.
    }
  }, []);

  const value = useMemo(() => ({ layout, setLayout }), [layout, setLayout]);
  return (
    <NavLayoutContext.Provider value={value}>{children}</NavLayoutContext.Provider>
  );
}

export function useNavLayout(): NavLayoutContextValue {
  return useContext(NavLayoutContext);
}
