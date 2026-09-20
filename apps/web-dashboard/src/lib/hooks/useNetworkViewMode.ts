"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type NetworkViewMode = "simple" | "advanced";

/** WARP-2962: the Network page opens in Simple — the everyday Overview — and
 *  only opens Advanced when the URL named a tab. A deep link to `?tab=wifi`
 *  is asking for a surface that only exists in Advanced, so it opens there. */
export function defaultMode(deepLinkedTab: boolean): NetworkViewMode {
  return deepLinkedTab ? "advanced" : "simple";
}

/**
 * Simple ⟷ Advanced view mode for the Network page (WARP-612).
 *
 * Re-syncs the default if `deepLinkedTab` ever changes (a cross-tab jump or
 * browser back/forward rewrites `?tab=` after mount), but never clobbers an
 * explicit user choice: once the user picks a mode, that choice wins for the
 * session.
 */
export function useNetworkViewMode(deepLinkedTab: boolean) {
  const [mode, setMode] = useState<NetworkViewMode>(() => defaultMode(deepLinkedTab));
  const userChose = useRef(false);

  useEffect(() => {
    if (userChose.current) return;
    setMode(defaultMode(deepLinkedTab));
  }, [deepLinkedTab]);

  const choose = useCallback((next: NetworkViewMode) => {
    userChose.current = true;
    setMode(next);
  }, []);

  return { mode, choose };
}
