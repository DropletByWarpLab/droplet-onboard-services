"use client";

// The viewer's wall-calendar day, kept current across local midnight and across
// a laptop waking up on a later day. Overdue styling and the "today" markers in
// the calendar, timeline and My Work all read from here, so a tab left open
// overnight does not keep calling yesterday "today".
//
// Client-only views: the first render reads the browser's own clock, so these
// views must not be server-rendered with a date baked into the markup.

import { useEffect, useState } from "react";
import { todayLocal, type DateOnly } from "./dateOnly";

export function useToday(): DateOnly {
  const [today, setToday] = useState<DateOnly>(() => todayLocal());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => setToday(todayLocal());
    const arm = () => {
      const now = new Date();
      // One second past the next local midnight. `Date` normalises a day that
      // does not exist (a DST gap at midnight), so this cannot loop or skip.
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 1);
      timer = setTimeout(() => {
        refresh();
        arm();
      }, Math.max(1_000, next.getTime() - now.getTime()));
    };
    arm();
    // A sleeping machine's timer fires late (or not at all); catch up on wake.
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  return today;
}
