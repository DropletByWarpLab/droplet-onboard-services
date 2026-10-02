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
 * The deep-link rule is ONE-DIRECTIONAL. A `?tab=` arriving after mount (a
 * cross-tab jump, browser back/forward) opens Advanced, because the tab it
 * names only exists there. Losing the `?tab=` does not close Advanced again:
 * the Overview tab's own href is the bare /network path, so a symmetric
 * re-sync would throw a user out of the tab surface they are working in the
 * moment they clicked Overview. Only the Simple pill — an explicit choice,
 * which also wins over every later re-sync — goes back.
 */
export function useNetworkViewMode(deepLinkedTab: boolean) {
  const [mode, setMode] = useState<NetworkViewMode>(() => defaultMode(deepLinkedTab));
  const userChose = useRef(false);

  useEffect(() => {
    if (userChose.current || !deepLinkedTab) return;
    setMode("advanced");
  }, [deepLinkedTab]);

  const choose = useCallback((next: NetworkViewMode) => {
    userChose.current = true;
    setMode(next);
  }, []);

  return { mode, choose };
}
