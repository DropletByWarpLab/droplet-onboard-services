"use client";

import { useEffect, useRef } from "react";
import { mutate } from "swr";

const DEVICES_KEY = "/api/devices/smart-home";

/**
 * Connects to the smart home SSE endpoint for real-time state updates.
 * When a state_changed event arrives, triggers SWR revalidation for instant UI updates.
 */
export function useSmartHomeEvents() {
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/devices/smart-home/events");
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "state_changed") {
          mutate(DEVICES_KEY);
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects on error
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);
}
