"use client";

import { useEffect, useState } from "react";
import { Clock, User, Car, Dog, LayoutGrid, List } from "lucide-react";
import type { DetectionEvent } from "@/lib/types";
import { prettifyCameraKey } from "@/lib/camera-display";
import { cameraDetectionDetail } from "@/lib/camera-detection";
import { EventCard } from "@/components/events/EventCard";
import { EventClipModal } from "@/components/events/EventClipModal";
import { ThumbImage } from "@/components/events/ThumbImage";

interface CameraEventsProps {
  events: DetectionEvent[];
  cameraLabel?: (key: string) => string;
}

const LABEL_ICONS: Record<string, typeof User> = {
  person: User,
  car: Car,
  dog: Dog,
};
const LAYOUT_KEY = "droplet.camera-detections.layout";

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function CameraEvents({
  events,
  cameraLabel = prettifyCameraKey,
}: CameraEventsProps) {
  const [layout, setLayout] = useState<"grid" | "list">("list");
  const [peopleOnly, setPeopleOnly] = useState(false);
  const [selected, setSelected] = useState<DetectionEvent | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LAYOUT_KEY);
      if (saved === "grid" || saved === "list") setLayout(saved);
    } catch {
      /* The control still works when browser storage is unavailable. */
    }
  }, []);

  const changeLayout = (next: "grid" | "list") => {
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* Optional preference. */
    }
  };

  // Keep an open detection current as its recording finishes, even if a new
  // detection pushes it out of the recent feed while the person is watching.
  const activeEvent =
    selected && (events.find((event) => event.id === selected.id) ?? selected);
  const visibleEvents = peopleOnly
    ? events.filter((event) => event.label === "person")
    : events;

  useEffect(() => {
    const updated =
      selected && events.find((event) => event.id === selected.id);
    if (updated && updated !== selected) setSelected(updated);
  }, [events, selected]);

  if (events.length === 0 && !activeEvent) return null;

  return (
    <>
      <div className="sect flex-wrap">
        <h2>Recent detections</h2>
        <span className="sx">{visibleEvents.length}</span>
        <div className="flex items-center flex-wrap gap-2 ml-auto">
          <div className="pills" role="group" aria-label="Detection filter">
            <button
              type="button"
              className={`pill ${!peopleOnly ? "active" : ""}`}
              aria-pressed={!peopleOnly}
              onClick={() => setPeopleOnly(false)}
            >
              All
            </button>
            <button
              type="button"
              className={`pill flex items-center gap-1 ${peopleOnly ? "active" : ""}`}
              aria-pressed={peopleOnly}
              onClick={() => setPeopleOnly(true)}
            >
              <User size={13} /> People
            </button>
          </div>
          <div className="pills" role="group" aria-label="Detection layout">
            <button
              type="button"
              className={`pill ${layout === "grid" ? "active" : ""}`}
              aria-label="Grid view"
              title="Grid view"
              aria-pressed={layout === "grid"}
              onClick={() => changeLayout("grid")}
            >
              <LayoutGrid size={15} />
            </button>
            <button
              type="button"
              className={`pill ${layout === "list" ? "active" : ""}`}
              aria-label="List view"
              title="List view"
              aria-pressed={layout === "list"}
              onClick={() => changeLayout("list")}
            >
              <List size={15} />
            </button>
          </div>
        </div>
      </div>
      {visibleEvents.length === 0 ? (
        <div className="card">
          <p className="type-footnote text-[color:var(--text-muted)]">
            No recent people detected.
          </p>
        </div>
      ) : layout === "grid" ? (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
          aria-label="Detection grid"
        >
          {visibleEvents.map((event) => (
            <EventCard
              key={event.id}
              event={cameraDetectionDetail(event)}
              cameraName={cameraLabel(event.camera)}
              onClick={() => setSelected(event)}
            />
          ))}
        </div>
      ) : (
        <div className="card" style={{ padding: 0 }}>
          <div className="rows" aria-label="Detection list">
            {visibleEvents.map((event) => {
              const Icon = LABEL_ICONS[event.label] || Clock;
              const cameraDisplay = cameraLabel(event.camera);
              return (
                <button
                  key={event.id}
                  type="button"
                  onClick={() => setSelected(event)}
                  aria-label={`View ${event.label} on ${cameraDisplay}, ${formatTimeAgo(event.startTime)}`}
                  className="lrow w-full text-left hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--brand)]"
                  style={{ padding: 12 }}
                >
                  <div
                    className="w-16 h-12 rounded overflow-hidden flex-shrink-0"
                    style={{ background: "var(--card-inner)" }}
                  >
                    <ThumbImage
                      src={cameraDetectionDetail(event).thumbnail}
                      alt={`${event.label} on ${cameraDisplay}`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                      retryKey={event.endTime}
                      iconSize={16}
                    />
                  </div>
                  <div className="rt">
                    <div className="flex items-center gap-2">
                      <Icon
                        size={14}
                        className="flex-shrink-0"
                        style={{ color: "var(--brand)" }}
                      />
                      <span
                        className="type-subheadline font-medium capitalize"
                        style={{ color: "var(--text)" }}
                      >
                        {event.label}
                      </span>
                      <span
                        className="type-caption-2"
                        style={{ color: "var(--text-faint)" }}
                      >
                        {Math.round(event.score * 100)}%
                      </span>
                    </div>
                    <p
                      className="type-caption-1 truncate mt-0.5"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {cameraDisplay}
                    </p>
                  </div>
                  <span
                    className="type-caption-1 flex-shrink-0"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {formatTimeAgo(event.startTime)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {activeEvent && (
        <EventClipModal
          key={activeEvent.id}
          event={cameraDetectionDetail(activeEvent)}
          initialMedia="snapshot"
          cameraName={cameraLabel(activeEvent.camera)}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
