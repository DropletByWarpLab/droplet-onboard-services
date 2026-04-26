"use client";

import { useMemo, useState } from "react";
import { Film, RefreshCw } from "lucide-react";
import { useCameras } from "@/lib/hooks/useCameras";
import { useEvents } from "@/lib/hooks/useEvents";
import { EventCard } from "@/components/events/EventCard";
import { EventClipModal } from "@/components/events/EventClipModal";
import { EventFilterBar } from "@/components/events/EventFilterBar";
import type { EventDetail, EventFilter } from "@/lib/types";

/**
 * Events page — the dashboard's full-feature replacement for Frigate's
 * own /events surface. Phase 2.1 of the parity rollout.
 *
 * Composition:
 *   - EventFilterBar drives a typed EventFilter (cameras, labels,
 *     score floor, time preset, clip-only toggle).
 *   - useEvents wraps SWR Infinite for cursor-paginated fetch with
 *     auto-revalidate every 15 s on the head page.
 *   - EventCard grid renders the page; clicking opens EventClipModal
 *     for inline playback (clip if available, else snapshot).
 *
 * Phase 2.2 will add retain-indefinitely toggling + the Reviews
 * resource (severity-grouped event clusters) on top of this surface.
 */
export default function EventsPage() {
  const { cameras } = useCameras();
  const [filter, setFilter] = useState<EventFilter>({});
  const { events, isLoading, isLoadingMore, hasMore, loadMore, refresh, error } =
    useEvents(filter);
  const [playing, setPlaying] = useState<EventDetail | null>(null);

  // Surface the union of labels seen in the current result set so the
  // filter pills aren't an empty list on first load. Once the operator
  // narrows the filter we still see what they could click next.
  const knownLabels = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) set.add(e.label);
    // Always include the four most common Frigate defaults so a fresh
    // install with no events at all still renders something.
    for (const fallback of ["person", "car", "dog", "cat"]) set.add(fallback);
    return Array.from(set).sort();
  }, [events]);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="type-large-title text-label-primary">Events</h1>
          <p className="type-subheadline text-label-tertiary mt-1">
            {isLoading
              ? "Loading recent events…"
              : events.length === 0
                ? "No events match the current filters"
                : `${events.length} event${events.length === 1 ? "" : "s"}${
                    hasMore ? " (more available)" : ""
                  }`}
          </p>
        </div>
        <button
          onClick={() => refresh()}
          disabled={isLoading}
          className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <RefreshCw size={16} className={isLoading ? "animate-spin" : ""} />
          <span className="type-subheadline">Refresh</span>
        </button>
      </div>

      <EventFilterBar
        cameras={cameras}
        knownLabels={knownLabels}
        filter={filter}
        onChange={setFilter}
      />

      {error && (
        <div className="dp-card p-4 mb-4 text-system-red">
          <p className="type-subheadline">
            Couldn&apos;t load events:{" "}
            {error instanceof Error ? error.message : String(error)}
          </p>
        </div>
      )}

      {isLoading && events.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="dp-card aspect-video animate-pulse bg-surface-secondary"
            />
          ))}
        </div>
      ) : events.length === 0 ? (
        <div className="dp-card text-center py-16">
          <Film
            size={32}
            className="mx-auto text-label-quaternary mb-3"
          />
          <h2 className="type-title-3 text-label-primary mb-1">No events yet</h2>
          <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
            As your cameras detect motion or objects, the events will show up
            here. Try widening the filters above to see older results.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {events.map((ev) => (
              <EventCard key={ev.id} event={ev} onClick={setPlaying} />
            ))}
          </div>

          {hasMore && (
            <div className="flex items-center justify-center mt-6">
              <button
                onClick={loadMore}
                disabled={isLoadingMore}
                className="dp-btn-secondary flex items-center gap-2 px-4 py-2 rounded-lg disabled:opacity-60"
              >
                {isLoadingMore && (
                  <RefreshCw size={14} className="animate-spin" />
                )}
                <span className="type-subheadline">
                  {isLoadingMore ? "Loading…" : "Load more"}
                </span>
              </button>
            </div>
          )}
        </>
      )}

      {playing && (
        <EventClipModal event={playing} onClose={() => setPlaying(null)} />
      )}
    </div>
  );
}
