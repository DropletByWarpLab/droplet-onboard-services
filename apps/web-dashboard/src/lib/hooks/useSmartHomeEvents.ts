"use client";

import { useEffect, useRef } from "react";
import { mutate } from "swr";

const DEVICES_KEY = "/api/matter/devices";

/**
 * Connects to the Matter SSE endpoint for real-time state updates.
 * When a state_changed or connection_changed event arrives, triggers SWR revalidation.
 */
export function useSmartHomeEvents() {
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/matter/devices/events");
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "state_changed" || data.type === "connection_changed") {
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
