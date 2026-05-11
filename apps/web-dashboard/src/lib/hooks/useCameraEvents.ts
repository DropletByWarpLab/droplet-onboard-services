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
            // A NEW event was accepted by the server-side per-camera
            // gate (one per camera, gated on prior-recording-ended +
            // 5s cooldown). This is the one type that surfaces to the
            // user: toast + SWR revalidation. Push is dispatched
            // server-side in parallel.
            mutate(CAMERAS_KEY);
            mutate(EVENTS_KEY);
            setNotifications((prev) => [...prev.slice(-9), data]);
            break;

          case "detection_update":
            // Tracker refinement for an already-notified event. The
            // cameras page may consume this for live confidence UI;
            // the notification center MUST ignore it so it does not
            // saturate. No SWR mutate either — every confidence tick
            // would otherwise bust the cameras + events list.
            break;

          case "detection_end":
            // Recording window closed; the clip is finalizing. Refresh
            // the events list so the new clip shows up, but no toast —
            // the user already got the "detection" toast when the
            // event started.
            mutate(EVENTS_KEY);
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
