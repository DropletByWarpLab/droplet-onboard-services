"use client";

import { useEffect, useState } from "react";

/**
 * WARP-837 — SSR-safe `matchMedia` hook.
 *
 * Returns whether `query` currently matches, and re-renders when it changes.
 * Used by EmailWorkspace to switch between the desktop multi-column layout and
 * the mobile single-pane layout from React state (so the switch is testable by
 * mocking `matchMedia`, not by inspecting CSS).
 *
 * SSR / old-browser safe: returns `false` on the server and on the first client
 * paint, then re-derives from `matchMedia` in a post-mount effect. Effects never
 * run on the server, so the server markup and the client's first paint agree
 * (no hydration mismatch); the desktop layout is the default the effect upgrades
 * to once `matchMedia` reports a wide viewport.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    // Safari < 14 only has the deprecated addListener; support both.
    if (mql.addEventListener) {
      mql.addEventListener("change", update);
      return () => mql.removeEventListener("change", update);
    }
    mql.addListener(update);
    return () => mql.removeListener(update);
  }, [query]);

  return matches;
}
