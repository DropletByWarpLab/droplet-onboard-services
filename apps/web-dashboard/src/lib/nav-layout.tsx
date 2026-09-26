"use client";

/**
 * WARP-2971 — which navigation shell a person sees.
 *
 *   sidebar    the left rail + mobile tab bar (`components/Sidebar.tsx`),
 *              the default and the shape every shipped box renders today
 *   workspace  the handoff's three-level top-tab shell
 *              (`components/workspace/WorkspaceShell.tsx`)
 *
 * A per-person DISPLAY preference, persisted exactly like the theme
 * (`lib/theme.tsx`): localStorage on this browser, no server round-trip,
 * because it changes how the same routes are presented and nothing about
 * what the person may reach. Both layouts resolve the same `nav-config.ts`
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
  useRef,
  useState,
} from "react";

export type NavLayout = "sidebar" | "workspace";

export const NAV_LAYOUT_STORAGE_KEY = "droplet-nav-layout";
export const DEFAULT_NAV_LAYOUT: NavLayout = "sidebar";

export function isNavLayout(value: unknown): value is NavLayout {
  return value === "sidebar" || value === "workspace";
}

interface NavLayoutContextValue {
  layout: NavLayout;
  setLayout: (layout: NavLayout) => void;
  // WARP-3139 — the layout the Settings toggle just chose, waiting for the
  // toggle instance that renders it (the same one, or the one remounted by
  // AuthGate's shell swap) to take focus back. A ref, not state: a hand-off
  // between two instances, never rendered from.
  focusRequest: { current: NavLayout | null };
}

const NavLayoutContext = createContext<NavLayoutContextValue>({
  layout: DEFAULT_NAV_LAYOUT,
  setLayout: () => {},
  // Without a provider the layout never changes, so no request is ever honoured.
  focusRequest: { current: null },
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

  // Lives here, above AuthGate, so it outlives the shell swap (WARP-3139).
  const focusRequest = useRef<NavLayout | null>(null);

  const value = useMemo(
    () => ({ layout, setLayout, focusRequest }),
    [layout, setLayout],
  );
  return (
    <NavLayoutContext.Provider value={value}>{children}</NavLayoutContext.Provider>
  );
}

export function useNavLayout(): NavLayoutContextValue {
  return useContext(NavLayoutContext);
}
