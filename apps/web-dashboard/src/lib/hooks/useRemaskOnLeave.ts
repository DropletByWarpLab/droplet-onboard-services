"use client";

import { useEffect } from "react";

/**
 * WARP-3135 — mask a revealed password again when the person leaves the window.
 *
 * Same rule as the Mac client (DropletAgent #9, WARP-3086): the window losing
 * focus (`blur` on `window` — Alt+Tab, a click into another app) or the page
 * going hidden (tab switch, minimise, screen lock) sets the reveal back to
 * false, so coming back shows dots, not a secret someone revealed and walked
 * away from. The caller re-masks on submit itself; this covers leaving.
 *
 * Window blur only, never the input's: clicking the eye blurs the input, and
 * an element's `blur` does not bubble, so it never reaches this non-capture
 * listener. Listening in the capture phase would re-mask on every click of
 * the eye and make it unusable.
 *
 * Pass the `useState` setter — its identity is stable, so the listeners
 * attach once per mount.
 */
export function useRemaskOnLeave(setRevealed: (revealed: boolean) => void): void {
  useEffect(() => {
    const mask = () => setRevealed(false);
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") mask();
    };
    window.addEventListener("blur", mask);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("blur", mask);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [setRevealed]);
}
