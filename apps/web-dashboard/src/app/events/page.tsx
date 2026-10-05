"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Activity,
  Eye,
  Film,
  Layers,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useCameras } from "@/lib/hooks/useCameras";
import { useEvents } from "@/lib/hooks/useEvents";
import { useReviews } from "@/lib/hooks/useReviews";
import { useCameraBusinessHours } from "@/lib/hooks/useCameraBusinessHours";
import { useMotionActivity } from "@/lib/hooks/useMotionActivity";
import { searchEventsSemantic, setEventRetain } from "@/lib/api";
import {
  CAMERAS_UNAVAILABLE_TITLE,
  FILES_UNAVAILABLE_HINT,
  isCamerasUnavailableError,
} from "@/lib/files-unavailable";
import { EventCard } from "@/components/events/EventCard";
import { EventClipModal } from "@/components/events/EventClipModal";
import { EventFilterBar } from "@/components/events/EventFilterBar";
import { ReviewCard } from "@/components/events/ReviewCard";
import { ReviewClipModal } from "@/components/events/ReviewClipModal";
import { ReviewFilterBar } from "@/components/events/ReviewFilterBar";
import { BusinessHoursPanel } from "@/components/events/BusinessHoursPanel";
import { MotionFilterBar, recentMotionRange, type MotionPeriod } from "@/components/events/MotionFilterBar";
import { MotionCard } from "@/components/events/MotionCard";
import { MotionClipModal } from "@/components/events/MotionClipModal";
import type {
  EventDetail,
  EventFilter,
  FilteredEventsResult,
  ReviewFilter,
  ReviewItem,
  MotionActivity,
  MotionActivityResult,
  MotionFilter,
} from "@/lib/types";

type Tab = "events" | "alerts" | "detections" | "motion";

const TAB_DEFS: Array<{ id: Tab; label: string; icon: typeof AlertTriangle }> = [
  { id: "alerts", label: "Alerts", icon: AlertTriangle },
  { id: "detections", label: "Detections", icon: Eye },
  { id: "motion", label: "Motion", icon: Activity },
  { id: "events", label: "All events", icon: Layers },
];

/**
 * Events page — Frigate-parity surface for what the cameras have been
 * seeing. Tabs split the data:
 *   - Alerts: review clusters with severity=alert (the sharper end —
 *     things the operator probably wants pushed to a phone).
 *   - Detections: object and audio detection reviews.
 *   - Motion: movement in retained footage, including movement with no object.
 *   - All events: the raw event stream with the full filter rail.
 *
 * Each tab keeps its own filter state so switching back to a tab
 * restores the rail you left it in. The retain toggle on the events
 * modal calls /api/cameras/events/:id/retain and invalidates the
 * events SWR cache so the "Saved" badge on the card flips on close.
 */
export default function EventsPage() {
  const { cameras } = useCameras();
  const hoursHook = useCameraBusinessHours();
  const [tab, setTab] = useState<Tab>("alerts");
  const [hoursScope, setHoursScope] = useState<EventFilter["businessHours"]>();

  const [eventFilter, setEventFilter] = useState<EventFilter>({});
  const [alertsFilter, setAlertsFilter] = useState<ReviewFilter>({
    severity: ["alert"],
  });
  const [detectionsFilter, setDetectionsFilter] = useState<ReviewFilter>({
    severity: ["detection"],
  });
  const [motionFilter, setMotionFilter] = useState<MotionFilter>(recentMotionRange);
  const [motionPeriod, setMotionPeriod] = useState<MotionPeriod>("recent");

  // ---------- Data hooks (always all three subscribed; SWR de-dupes) ----------
  const hoursConfigured = hoursHook.schedule?.configured === true;
  const businessHours = hoursConfigured ? hoursScope : undefined;
  const effectiveEventFilter = useMemo(() => ({ ...eventFilter, businessHours }), [eventFilter, businessHours]);
  const effectiveAlertsFilter = useMemo(() => ({ ...alertsFilter, businessHours }), [alertsFilter, businessHours]);
  const effectiveDetectionsFilter = useMemo(() => ({ ...detectionsFilter, businessHours }), [detectionsFilter, businessHours]);
  const effectiveMotionFilter = useMemo(() => ({ ...motionFilter, businessHours }), [motionFilter, businessHours]);
  // Reclassify cached pages whenever the saved schedule changes, including
  // changes made from another dashboard session.
  const scheduleKey = hoursHook.schedule ? JSON.stringify(hoursHook.schedule) : undefined;
  const eventsHook = useEvents(effectiveEventFilter, scheduleKey);
  const alertsHook = useReviews(effectiveAlertsFilter, scheduleKey);
  const detectionsHook = useReviews(effectiveDetectionsFilter, scheduleKey);
  const motionHook = useMotionActivity(effectiveMotionFilter, scheduleKey, tab === "motion");

  // Semantic search state — only active on the "All events" tab.
  // Local input bound to a debounced query so we don't fire on every
  // keystroke. The result fetch runs in an effect; null = "no search
  // active, render the regular events list."
  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<FilteredEventsResult | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResultKey, setSearchResultKey] = useState("");
  const searchKey = JSON.stringify([searchQuery, effectiveEventFilter, scheduleKey]);
  const currentSearchResults = searchResultKey === searchKey ? searchResults : null;
  const currentSearchError = searchResultKey === searchKey ? searchError : null;

  // Debounce: 350ms after the operator stops typing, kick a search.
  // We don't fire if the input is empty — empty means "go back to
  // the default events list."
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (!trimmed) {
      setSearchQuery("");
      setSearchResults(null);
      setSearchError(null);
      return;
    }
    const t = window.setTimeout(() => setSearchQuery(trimmed), 350);
    return () => window.clearTimeout(t);
  }, [searchInput]);

  // Fire the search whenever the debounced query OR the events filter
  // changes (so e.g. "person near front door" + camera=front_door
  // filter compose correctly).
  useEffect(() => {
    if (!searchQuery) return;
    let cancelled = false;
    setSearching(true);
    setSearchResults(null);
    setSearchError(null);
    searchEventsSemantic(searchQuery, { ...effectiveEventFilter, limit: 60 })
      .then((res) => {
        if (cancelled) return;
        setSearchResults(res);
        setSearchResultKey(searchKey);
      })
      .catch((e) => {
        if (cancelled) return;
        setSearchError(e instanceof Error ? e.message : "Search failed");
        setSearchResults({ events: [], nextCursor: null });
        setSearchResultKey(searchKey);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [searchQuery, effectiveEventFilter, scheduleKey, searchKey]);

  const [playingEvent, setPlayingEvent] = useState<EventDetail | null>(null);
  const [playingReview, setPlayingReview] = useState<ReviewItem | null>(null);
  const [playingMotion, setPlayingMotion] = useState<MotionActivity | null>(null);

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
  const reviewsFilter = tab === "alerts" ? effectiveAlertsFilter : effectiveDetectionsFilter;
  const setReviewsFilter = tab === "alerts" ? setAlertsFilter : setDetectionsFilter;

  const semanticActive = tab === "events" && Boolean(searchQuery);
  const activeItems = tab === "events"
    ? semanticActive ? currentSearchResults?.events ?? [] : eventsHook.events
    : tab === "motion" ? motionHook.activity : reviewsHook.reviews;
  const headerCount = activeItems.length;
  const headerLoading = (() => {
    if (semanticActive) return searching || (!currentSearchResults && !currentSearchError);
    if (tab === "motion") return motionHook.isLoading;
    if (tab === "events") return eventsHook.isLoading;
    return reviewsHook.isLoading;
  })();
  const headerHasMore = (() => {
    if (semanticActive) return false;
    if (tab === "motion") return motionHook.hasMore;
    if (tab === "events") return eventsHook.hasMore;
    return reviewsHook.hasMore;
  })();
  const refreshActive = () => {
    if (tab === "motion") {
      if (motionPeriod === "recent") {
        const latest = recentMotionRange();
        if (latest.before === motionFilter.before && latest.after === motionFilter.after) return motionHook.refresh();
        setMotionFilter((current) => ({ ...current, ...latest }));
      }
      else return motionHook.refresh();
      return;
    }
    if (semanticActive) {
      // A new filter identity reruns semantic search with the same values.
      setEventFilter((current) => ({ ...current }));
      return;
    }
    if (tab === "events") return eventsHook.refresh();
    return reviewsHook.refresh();
  };

  const activityError = tab === "events"
    ? semanticActive ? currentSearchError : eventsHook.error
    : tab === "motion" ? motionHook.error || (motionHook.coverage?.cameras.length && motionHook.coverage.cameras.every((camera) => !camera.available) ? new Error("Motion coverage unavailable") : undefined)
      : reviewsHook.error;

  const sub = activityError
    ? "Camera activity could not be loaded."
    : headerLoading
    ? "Loading the latest camera activity…"
    : headerCount === 0
      ? headerHasMore ? "No matches in activity checked so far." : tab === "motion" ? "No matching movement in retained footage." : "Nothing to triage right now."
      : `${headerCount} ${tab === "events" ? "event" : tab === "motion" ? "movement period" : "item"}${
          headerCount === 1 ? "" : "s"
        }${headerHasMore ? " and counting" : ""} in this view.`;

  function changeEventFilter(next: EventFilter) {
    const { businessHours: scope, ...rest } = next;
    setHoursScope(scope);
    setEventFilter(rest);
  }

  function changeReviewFilter(next: ReviewFilter) {
    const { businessHours: scope, ...rest } = next;
    setHoursScope(scope);
    setReviewsFilter(rest);
  }

  function changeMotionFilter(next: MotionFilter, period?: MotionPeriod) {
    const { businessHours: scope, ...rest } = next;
    setHoursScope(scope);
    setMotionFilter(rest);
    if (period) setMotionPeriod(period);
  }

  const actions = (
    <button
      onClick={() => refreshActive()}
      disabled={headerLoading}
      className="icon-btn"
      aria-label="Refresh events"
      title="Refresh"
      type="button"
    >
      <RefreshCw size={16} className={headerLoading ? "animate-spin" : ""} />
    </button>
  );

  return (
    <ShellPage
      icon={<Film size={15} />}
      label="Events"
      title="Events"
      sub={sub}
      actions={actions}
    >
      {/* Tab strip — Frigate splits the timeline by review severity, so
          the dashboard does too. Each tab carries its own filter. */}
      <div className="tabstrip">
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
              className={"tab" + (active ? " active" : "")}
              type="button"
            >
              <Icon size={14} />
              {t.label}
              {unreviewedBadge > 0 && <span className="tcount">{unreviewedBadge}</span>}
            </button>
          );
        })}
      </div>

      <div className="mb-4"><BusinessHoursPanel
        schedule={hoursHook.schedule}
        isLoading={hoursHook.isLoading}
        error={hoursHook.error}
        onRetry={hoursHook.retry}
        onSave={hoursHook.save}
        activityCount={headerCount}
        outsideCount={activeItems.filter((item) => item.outsideBusinessHours === true).length}
        activityLoading={headerLoading}
        activityError={activityError}
        hasMore={headerHasMore}
      /></div>

      {/* Semantic search input — only on the All events tab. Frigate's
          embeddings stack must be enabled; we surface a clear error
          inline when it isn't. */}
      {tab === "events" && (
        <div className="search" style={{ maxWidth: "100%", height: 44, marginBottom: 18 }}>
          <Search
            size={15}
            className={searching ? "animate-pulse" : ""}
            style={{ color: searching ? "var(--brand)" : "var(--text-muted)", flexShrink: 0 }}
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Find events by description — e.g. “blue car at night”, “dog in driveway”"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput("")}
              className="icon-btn"
              style={{ width: 28, height: 28, border: 0, background: "transparent" }}
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
          {searchQuery && !currentSearchError && (
            <span className="badge info" style={{ flexShrink: 0 }}>
              <Sparkles size={11} />
              Semantic
            </span>
          )}
        </div>
      )}

      {/* Filter rail — events tab gets the full bar, review tabs get the
          trimmed-down camera+time+reviewed bar. */}
      {tab === "motion" ? (
        <div className="mb-4"><MotionFilterBar cameras={cameras} filter={effectiveMotionFilter} period={motionPeriod} businessHoursConfigured={hoursConfigured} onChange={changeMotionFilter} /></div>
      ) : tab === "events" ? (
        <EventFilterBar
          cameras={cameras}
          knownLabels={knownLabels}
          filter={effectiveEventFilter}
          onChange={changeEventFilter}
          businessHoursConfigured={hoursConfigured}
        />
      ) : (
        <ReviewFilterBar
          cameras={cameras}
          filter={reviewsFilter}
          onChange={changeReviewFilter}
          businessHoursConfigured={hoursConfigured}
        />
      )}

      {/* Body */}
      {tab === "motion" ? (
        <MotionBody activity={motionHook.activity} coverage={motionHook.coverage} isLoading={motionHook.isLoading} isLoadingMore={motionHook.isLoadingMore} hasMore={motionHook.hasMore} loadMore={motionHook.loadMore} error={motionHook.error} onRetry={refreshActive} onOpen={setPlayingMotion} />
      ) : tab === "events" && searchQuery ? (
        <EventsBody
          events={currentSearchResults?.events ?? []}
          isLoading={headerLoading}
          isLoadingMore={false}
          hasMore={false}
          loadMore={() => {}}
          error={currentSearchError}
          onOpen={setPlayingEvent}
          searchMode
          searchLimitReached={currentSearchResults?.searchLimitReached}
        />
      ) : tab === "events" ? (
        <EventsBody
          events={eventsHook.events}
          isLoading={eventsHook.isLoading}
          isLoadingMore={eventsHook.isLoadingMore}
          hasMore={eventsHook.hasMore}
          loadMore={eventsHook.loadMore}
          error={eventsHook.error}
          onRetry={eventsHook.refresh}
          onOpen={setPlayingEvent}
          scanLimitReached={eventsHook.scanLimitReached}
        />
      ) : (
        <ReviewsBody
          reviews={reviewsHook.reviews}
          isLoading={reviewsHook.isLoading}
          isLoadingMore={reviewsHook.isLoadingMore}
          hasMore={reviewsHook.hasMore}
          loadMore={reviewsHook.loadMore}
          error={reviewsHook.error}
          onRetry={reviewsHook.refresh}
          onOpen={setPlayingReview}
          scanLimitReached={reviewsHook.scanLimitReached}
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
      {playingMotion && <MotionClipModal key={playingMotion.id} activity={playingMotion} onClose={() => setPlayingMotion(null)} />}
    </ShellPage>
  );
}

function MotionBody({ activity, coverage, isLoading, isLoadingMore, hasMore, loadMore, error, onRetry, onOpen }: {
  activity: MotionActivity[];
  coverage: MotionActivityResult["coverage"] | undefined;
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: unknown;
  onRetry: () => void;
  onOpen: (activity: MotionActivity) => void;
}) {
  if (isCamerasUnavailableError(error)) return <CamerasUnavailable onRetry={onRetry} />;
  if (error) return <div className="card" role="alert"><p className="type-footnote">Could not load recorded movement. Try refreshing.</p><button type="button" className="btn ghost sm mt-2" onClick={onRetry}>Retry motion</button></div>;
  if (isLoading && !activity.length) return <div className="card type-footnote">Checking recorded movement…</div>;
  const unavailable = coverage && coverage.cameras.length > 0 && coverage.cameras.every((camera) => !camera.available);
  return <div className="space-y-4">
    <div className="card space-y-2" aria-label="Motion recording coverage">
      <p className="type-footnote">Motion shows movement in retained footage, including movement with no detected object.</p>
      {coverage && <>
        <p className="type-caption-1 text-[color:var(--text-muted)]">Checked window: {new Date(coverage.after * 1000).toLocaleString()} – {new Date(coverage.before * 1000).toLocaleString()}. Use Refresh to check the latest activity.</p>
        {(coverage.partial || coverage.cameras.some((camera) => camera.hasGaps)) && <p className="type-footnote" role="status">Some of this time was not recorded or could not be checked. Movement may have occurred in those gaps.</p>}
        <div className="flex flex-wrap gap-x-4 gap-y-1 type-caption-1 text-[color:var(--text-muted)]">{coverage.cameras.map((camera) => <span key={camera.camera}>{camera.camera.replace(/_/g, " ")}: {camera.available && camera.recordedSeconds !== null ? `${camera.recordedSeconds < 60 ? `${Math.round(camera.recordedSeconds)}s` : `${Math.round(camera.recordedSeconds / 60)} min`} recorded${camera.hasGaps ? " · Gaps" : ""}` : "Unavailable"}</span>)}</div>
      </>}
    </div>
    {unavailable ? <div className="card" role="alert"><p className="type-footnote">Motion could not be checked for these cameras. Try refreshing.</p><button type="button" className="btn ghost sm mt-2" onClick={onRetry}>Retry motion</button></div>
      : activity.length ? <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">{activity.map((item) => <MotionCard key={item.id} activity={item} onOpen={onOpen} />)}</div>
        : <div className="card type-footnote">{hasMore ? "No matching movement in the footage checked so far. Load more to check older activity." : "No matching movement was found in the retained footage checked for this window."}</div>}
    {hasMore && <div className="flex justify-center"><button type="button" className="btn" disabled={isLoadingMore} onClick={loadMore}>{isLoadingMore ? "Loading…" : "Load more"}</button></div>}
  </div>;
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
  onRetry,
  onOpen,
  searchMode,
  scanLimitReached,
  searchLimitReached,
}: {
  events: EventDetail[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: unknown;
  onOpen: (e: EventDetail) => void;
  onRetry?: () => void;
  /** When true, the empty-state copy reflects a no-results-for-query
   *  state instead of the default "no events yet." */
  searchMode?: boolean;
  scanLimitReached?: boolean;
  searchLimitReached?: boolean;
}) {
  if (isCamerasUnavailableError(error)) return <CamerasUnavailable onRetry={onRetry} />;
  if (error) {
    return (
      <div className="card" style={{ marginBottom: 16, color: "#ef4444" }}>
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
            className="card aspect-video animate-pulse"
            style={{ background: "var(--surface-2)" }}
          />
        ))}
      </div>
    );
  }
  if (events.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <span className="ei"><Film size={24} /></span>
          <span className="eh">
            {hasMore ? "No matches in activity checked so far" : searchMode ? "Nothing matched that query" : "No events yet"}
          </span>
          <span style={{ maxWidth: "40ch" }}>
            {hasMore ? "More activity may be available; load more to check older activity."
              : searchLimitReached ? "Search is limited to the top matches; narrow your search or filters."
              : searchMode
              ? "Try a different phrasing, drop a filter, or pick a wider time range."
              : "As cameras detect motion or objects, the events will show up here. Try widening the filters above."}
          </span>
          {hasMore && <button type="button" className="btn" disabled={isLoadingMore} onClick={loadMore}>{isLoadingMore ? "Loading…" : "Load more"}</button>}
        </div>
      </div>
    );
  }
  return (
    <>
      {(scanLimitReached || searchLimitReached) && <p className="type-footnote text-[color:var(--text-muted)] mb-3">{searchLimitReached ? "Search is limited to the top matches; narrow your search or filters." : "More activity may be available; load more to check older activity."}</p>}
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
            className="btn"
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
  onRetry,
  onOpen,
  scanLimitReached,
}: {
  reviews: ReviewItem[];
  isLoading: boolean;
  isLoadingMore: boolean;
  hasMore: boolean;
  loadMore: () => void;
  error: unknown;
  onOpen: (rv: ReviewItem) => void;
  onRetry?: () => void;
  scanLimitReached?: boolean;
}) {
  if (isCamerasUnavailableError(error)) return <CamerasUnavailable onRetry={onRetry} />;
  if (error) {
    return (
      <div className="card" style={{ marginBottom: 16, color: "#ef4444" }}>
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
            className="card aspect-video animate-pulse"
            style={{ background: "var(--surface-2)" }}
          />
        ))}
      </div>
    );
  }
  if (reviews.length === 0) {
    return (
      <div className="card">
        <div className="empty">
          <span className="ei"><Eye size={24} /></span>
          <span className="eh">{hasMore ? "No matches in activity checked so far" : "All clear"}</span>
          <span style={{ maxWidth: "40ch" }}>
            {hasMore ? "More activity may be available; load more to check older activity." : "No clusters in this severity tier match the current filters."}
          </span>
          {hasMore && <button type="button" className="btn" disabled={isLoadingMore} onClick={loadMore}>{isLoadingMore ? "Loading…" : "Load more"}</button>}
        </div>
      </div>
    );
  }
  return (
    <>
      {scanLimitReached && <p className="type-footnote text-[color:var(--text-muted)] mb-3">More activity may be available; load more to check older activity.</p>}
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
            className="btn"
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

/**
 * WARP-3105 — Frigate is down: the box marks its empty 200 degraded, so say
 * the cameras are unavailable instead of "No events yet" / "All clear".
 */
function CamerasUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="card" role="alert">
      <div className="empty">
        <span className="ei"><AlertTriangle size={24} /></span>
        <span className="eh">{CAMERAS_UNAVAILABLE_TITLE}.</span>
        <span style={{ maxWidth: "40ch" }}>{FILES_UNAVAILABLE_HINT}</span>
        {onRetry && (
          <button type="button" className="btn ghost sm" onClick={onRetry} style={{ marginTop: 10 }}>
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
