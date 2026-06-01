"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type NetworkViewMode = "simple" | "advanced";

/** Persona default for the Network Simple/Advanced view: Business installs open
 *  on Advanced (full OpenWrt surface), Home installs on Simple. */
export function personaDefaultMode(isBusiness: boolean): NetworkViewMode {
  return isBusiness ? "advanced" : "simple";
}

/**
 * Simple ⟷ Advanced view mode for the Network page (WARP-612).
 *
 * `isBusiness` from `useWorkspace()` can resolve *asynchronously* — the
 * workspace type lazy-inits from localStorage and is then hydrated from the
 * orchestrator after first paint — so a plain `useState(persona default)`
 * captures a stale "home" value and a Business install would wrongly stick on
 * Simple. This hook re-syncs the persona default whenever `isBusiness` resolves,
 * but never clobbers an explicit user choice: once the user picks a mode, that
 * choice wins for the session.
 */
export function useNetworkViewMode(isBusiness: boolean) {
  const [mode, setMode] = useState<NetworkViewMode>(() => personaDefaultMode(isBusiness));
  const userChose = useRef(false);

  useEffect(() => {
    if (userChose.current) return;
    setMode(personaDefaultMode(isBusiness));
  }, [isBusiness]);

  const choose = useCallback((next: NetworkViewMode) => {
    userChose.current = true;
    setMode(next);
  }, []);

  return { mode, choose };
}
