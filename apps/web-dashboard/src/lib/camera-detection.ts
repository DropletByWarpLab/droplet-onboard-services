import type { DetectionEvent, EventDetail } from "@/lib/types";

/** Recent detections carry media flags; the existing event viewer takes URLs. */
export function cameraDetectionDetail(event: DetectionEvent): EventDetail {
  const eventPath = `/api/cameras/events/${encodeURIComponent(event.id)}`;
  return {
    ...event,
    thumbnail: `${eventPath}/thumbnail`,
    snapshotUrl: event.hasSnapshot ? `${eventPath}/snapshot` : null,
    clipUrl: event.hasClip
      ? `/api/cameras/clips/event/${encodeURIComponent(event.id)}`
      : null,
    subLabel: null,
    subLabelScore: null,
    zones: [],
    retainIndefinitely: false,
    description: null,
  };
}
