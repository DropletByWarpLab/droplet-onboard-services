"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { mutate } from "swr";
import type { CameraSSEEvent } from "@/lib/types";

const CAMERAS_KEY = "/api/cameras";
const EVENTS_KEY = "/api/cameras/events/recent";

/**
 * Connects to the camera SSE endpoint for real-time detection events.
 * Triggers SWR revalidation on events and provides a notification queue
 * for toast display.
 */
export function useCameraEvents() {
  const esRef = useRef<EventSource | null>(null);
  const [notifications, setNotifications] = useState<CameraSSEEvent[]>([]);

  const dismissNotification = useCallback((index: number) => {
    setNotifications((prev) => prev.filter((_, i) => i !== index));
  }, []);

  useEffect(() => {
    const es = new EventSource("/api/cameras/events/sse");
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const data: CameraSSEEvent = JSON.parse(event.data);

        switch (data.type) {
          case "detection":
            // Revalidate camera list and events
            mutate(CAMERAS_KEY);
            mutate(EVENTS_KEY);
            // Add to notification queue
            setNotifications((prev) => [...prev.slice(-9), data]);
            break;

          case "camera_discovered":
            mutate("/api/cameras/discovered");
            setNotifications((prev) => [...prev.slice(-9), data]);
            break;

          case "camera_online":
          case "camera_offline":
            mutate(CAMERAS_KEY);
            break;
        }
      } catch {
        // Ignore parse errors
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

  // Auto-dismiss notifications after 10 seconds
  useEffect(() => {
    if (notifications.length === 0) return;
    const timer = setTimeout(() => {
      setNotifications((prev) => prev.slice(1));
    }, 10_000);
    return () => clearTimeout(timer);
  }, [notifications]);

  return { notifications, dismissNotification };
}
