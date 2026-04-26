"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Eye, Film, Layers, RefreshCw } from "lucide-react";
import { useCameras } from "@/lib/hooks/useCameras";
import { useEvents } from "@/lib/hooks/useEvents";
import { useReviews } from "@/lib/hooks/useReviews";
import { setEventRetain } from "@/lib/api";
import { EventCard } from "@/components/events/EventCard";
import { EventClipModal } from "@/components/events/EventClipModal";
import { EventFilterBar } from "@/components/events/EventFilterBar";
import { ReviewCard } from "@/components/events/ReviewCard";
import { ReviewClipModal } from "@/components/events/ReviewClipModal";
import { ReviewFilterBar } from "@/components/events/ReviewFilterBar";
import type {
  EventDetail,
  EventFilter,
  ReviewFilter,
  ReviewItem,
} from "@/lib/types";

type Tab = "events" | "alerts" | "detections";

const TAB_DEFS: Array<{ id: Tab; label: string; icon: typeof AlertTriangle }> = [
  { id: "alerts", label: "Alerts", icon: AlertTriangle },
  { id: "detections", label: "Detections", icon: Eye },
  { id: "events", label: "All events", icon: Layers },
];

/**
 * Events page — Frigate-parity surface for what the cameras have been
 * seeing. Tabs split the data:
 *   - Alerts: review clusters with severity=alert (the sharper end —
 *     things the operator probably wants pushed to a phone).
 *   - Detections: review clusters with severity=detection.
 *   - All events: the raw event stream with the full filter rail.
 *
 * Each tab keeps its own filter state so switching back to a tab
 * restores the rail you left it in. The retain toggle on the events
 * modal calls /api/cameras/events/:id/retain and invalidates the
 * events SWR cache so the "Saved" badge on the card flips on close.
 */
export default function EventsPage() {
  const { cameras } = useCameras();
  const [tab, setTab] = useState<Tab>("alerts");

  const [eventFilter, setEventFilter] = useState<EventFilter>({});
  const [alertsFilter, setAlertsFilter] = useState<ReviewFilter>({
    severity: ["alert"],
  });
  const [detectionsFilter, setDetectionsFilter] = useState<ReviewFilter>({
    severity: ["detection"],
  });

  // ---------- Data hooks (always all three subscribed; SWR de-dupes) ----------
  const eventsHook = useEvents(eventFilter);
  const alertsHook = useReviews(alertsFilter);
  const detectionsHook = useReviews(detectionsFilter);

  const [playingEvent, setPlayingEvent] = useState<EventDetail | null>(null);
  const [playingReview, setPlayingReview] = useState<ReviewItem | null>(null);

  const knownLabels = useMemo(() => {
    const set = new Set<string>();
    for (const e of eventsHook.events) set.add(e.label);
    for (const fallback of ["person", "car", "dog", "cat"]) set.add(fallback);
    return Array.from(set).sort();
  }, [eventsHook.events]);

  const handleRetainToggle = async (event: EventDetail, retain: boolean) => {
    await setEventRetain(event.id, retain);
    // Refresh events so the badge state on the card matches the modal.
    await eventsHook.refresh();
  };

  const reviewsHook = tab === "alerts" ? alertsHook : detectionsHook;
  const reviewsFilter = tab === "alerts" ? alertsFilter : detectionsFilter;
  const setReviewsFilter = tab === "alerts" ? setAlertsFilter : setDetectionsFilter;

  const headerCount = (() => {
    if (tab === "events") return eventsHook.events.length;
    return reviewsHook.reviews.length;
  })();
  const headerLoading = (() => {
    if (tab === "events") return eventsHook.isLoading;
    return reviewsHook.isLoading;
  })();
  const headerHasMore = (() => {
    if (tab === "events") return eventsHook.hasMore;
    return reviewsHook.hasMore;
  })();
  const refreshActive = () => {
    if (tab === "events") return eventsHook.refresh();
    return reviewsHook.refresh();
  };

  return (
    <div className="p-6">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h1 className="type-large-title text-label-primary">Events</h1>
          <p className="type-subheadline text-label-tertiary mt-1">
            {headerLoading
              ? "Loading…"
              : headerCount === 0
                ? "Nothing to triage right now"
                : `${headerCount} ${tab === "events" ? "event" : "item"}${
                    headerCount === 1 ? "" : "s"
                  }${headerHasMore ? " (more available)" : ""}`}
          </p>
        </div>
        <button
          onClick={() => refreshActive()}
          disabled={headerLoading}
          className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <RefreshCw size={16} className={headerLoading ? "animate-spin" : ""} />
          <span className="type-subheadline">Refresh</span>
        </button>
      </div>

      {/* Tab strip — Frigate splits the timeline by review severity, so
          the dashboard does too. Each tab carries its own filter. */}
      <div className="flex items-center gap-1 mb-4 border-b border-separator">
        {TAB_DEFS.map((t) => {
          const Icon = t.icon;
          const active = t.id === tab;
          const unreviewedBadge =
            t.id === "alerts"
              ? alertsHook.reviews.filter((r) => !r.hasBeenReviewed).length
              : t.id === "detections"
                ? detectionsHook.reviews.filter((r) => !r.hasBeenReviewed).length
                : 0;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-2 px-3 py-2 -mb-px border-b-2 transition-colors ${
                active
                  ? "border-accent text-label-primary"
                  : "border-transparent text-label-tertiary hover:text-label-secondary"
              }`}
            >
              <Icon size={14} />
              <span className="type-subheadline font-medium">{t.label}</span>
              {unreviewedBadge > 0 && (
                <span className="type-caption-2 px-1.5 py-0.5 rounded-full bg-accent text-white min-w-[18px] text-center">
                  {unreviewedBadge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Filter rail — events tab gets the full bar, review tabs get the
          trimmed-down camera+time+reviewed bar. */}
      {tab === "events" ? (
        <EventFilterBar
          cameras={cameras}
          knownLabels={knownLabels}
          filter={eventFilter}
          onChange={setEventFilter}
        />
      ) : (
        <ReviewFilterBar
          cameras={cameras}
          filter={reviewsFilter}
          onChange={setReviewsFilter}
        />
      )}

      {/* Body */}
      {tab === "events" ? (
        <EventsBody
          events={eventsHook.events}
          isLoading={eventsHook.isLoading}
          isLoadingMore={eventsHook.isLoadingMore}
          hasMore={eventsHook.hasMore}
          loadMore={eventsHook.loadMore}
          error={eventsHook.error}
          onOpen={setPlayingEvent}
        />
      ) : (
        <ReviewsBody
          reviews={reviewsHook.reviews}
          isLoading={reviewsHook.isLoading}
          isLoadingMore={reviewsHook.isLoadingMore}
          hasMore={reviewsHook.hasMore}
          loadMore={reviewsHook.loadMore}
          error={reviewsHook.error}
          onOpen={setPlayingReview}
        />
      )}

      {playingEvent && (
        <EventClipModal
          event={playingEvent}
          onClose={() => setPlayingEvent(null)}
          onToggleRetain={handleRetainToggle}
        />
      )}
      {playingReview && (
        <ReviewClipModal
          review={playingReview}
          onClose={() => setPlayingReview(null)}
          onMarkViewed={(rv) => reviewsHook.markViewed(rv.id)}
        />
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Body components — extracted just to keep the parent's render block readable.
// They're tightly coupled to their hook outputs, no need to be fully generic.
// ----------------------------------------------------------------------------

function EventsBody({
  events,
  isLoading,
  isLoadingMore,
  hasMore,
  loadMore,
  error,
  onOpen,
}: {
  events: EventDetail[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: unknown;
  onOpen: (e: EventDetail) => void;
}) {
  if (error) {
    return (
      <div className="dp-card p-4 mb-4 text-system-red">
        <p className="type-subheadline">
          Couldn&apos;t load events:{" "}
          {error instanceof Error ? error.message : String(error)}
        </p>
      </div>
    );
  }
  if (isLoading && events.length === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="dp-card aspect-video animate-pulse bg-surface-secondary"
          />
        ))}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="dp-card text-center py-16">
        <Film size={32} className="mx-auto text-label-quaternary mb-3" />
        <h2 className="type-title-3 text-label-primary mb-1">No events yet</h2>
        <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
          As cameras detect motion or objects, the events will show up here.
          Try widening the filters above.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {events.map((ev) => (
          <EventCard key={ev.id} event={ev} onClick={onOpen} />
        ))}
      </div>
      {hasMore && (
        <div className="flex items-center justify-center mt-6">
          <button
            onClick={loadMore}
            disabled={isLoadingMore}
            className="dp-btn-secondary flex items-center gap-2 px-4 py-2 rounded-lg disabled:opacity-60"
          >
            {isLoadingMore && <RefreshCw size={14} className="animate-spin" />}
            <span className="type-subheadline">
              {isLoadingMore ? "Loading…" : "Load more"}
            </span>
          </button>
        </div>
      )}
    </>
  );
}

function ReviewsBody({
  reviews,
  isLoading,
  isLoadingMore,
  hasMore,
  loadMore,
  error,
  onOpen,
}: {
  reviews: ReviewItem[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: unknown;
  onOpen: (rv: ReviewItem) => void;
}) {
  if (error) {
    return (
      <div className="dp-card p-4 mb-4 text-system-red">
        <p className="type-subheadline">
          Couldn&apos;t load reviews:{" "}
          {error instanceof Error ? error.message : String(error)}
        </p>
        <p className="type-caption-1 text-label-tertiary mt-1">
          The Reviews resource needs Frigate 0.13+. If you&apos;re on an older
          version, switch to the &ldquo;All events&rdquo; tab.
        </p>
      </div>
    );
  }
  if (isLoading && reviews.length === 0) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="dp-card aspect-video animate-pulse bg-surface-secondary"
          />
        ))}
      </div>
    );
  }
  if (reviews.length === 0) {
    return (
      <div className="dp-card text-center py-16">
        <Eye size={32} className="mx-auto text-label-quaternary mb-3" />
        <h2 className="type-title-3 text-label-primary mb-1">All clear</h2>
        <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
          No clusters in this severity tier match the current filters.
        </p>
      </div>
    );
  }
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {reviews.map((rv) => (
          <ReviewCard key={rv.id} review={rv} onClick={onOpen} />
        ))}
      </div>
      {hasMore && (
        <div className="flex items-center justify-center mt-6">
          <button
            onClick={loadMore}
            disabled={isLoadingMore}
            className="dp-btn-secondary flex items-center gap-2 px-4 py-2 rounded-lg disabled:opacity-60"
          >
            {isLoadingMore && <RefreshCw size={14} className="animate-spin" />}
            <span className="type-subheadline">
              {isLoadingMore ? "Loading…" : "Load more"}
            </span>
          </button>
        </div>
      )}
    </>
  );
}
