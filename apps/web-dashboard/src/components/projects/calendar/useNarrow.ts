"use client";

// True below `maxWidth` CSS px. The calendar collapses to an agenda list there
// (brief §7: mobile adapts density, not identity — the dense list IS the phone
// layout). Starts false so the server and the first client render agree; a
// jsdom/SSR environment without `matchMedia` simply stays on the desktop layout.

import { useEffect, useState } from "react";

export function useNarrow(maxWidth = 720): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`);
    const update = () => setNarrow(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [maxWidth]);
  return narrow;
}
