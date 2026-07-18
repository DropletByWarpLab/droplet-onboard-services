"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type NetworkViewMode = "simple" | "advanced";

/** Persona default for the Network Simple/Advanced view: Business installs
 *  open on Advanced (full OpenWrt surface). WARP-1341: `isBusiness` is now
 *  statically true, so Advanced is the effective default. */
export function personaDefaultMode(isBusiness: boolean): NetworkViewMode {
  return isBusiness ? "advanced" : "simple";
}

/**
 * Simple ⟷ Advanced view mode for the Network page (WARP-612).
 *
 * Re-syncs the persona default if `isBusiness` ever changes, but never
 * clobbers an explicit user choice: once the user picks a mode, that
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
