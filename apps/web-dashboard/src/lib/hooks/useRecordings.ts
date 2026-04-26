"use client";

import useSWR from "swr";
import {
  fetchRecordingSegments,
  fetchRecordingsSummary,
  fetchTimeline,
} from "@/lib/api";
import type {
  RecordingDay,
  RecordingSegment,
  TimelineEntry,
} from "@/lib/types";

/**
 * Per-camera daily/hourly summary. Hits Frigate once per camera and
 * paints the date picker + scrubber's hourly heatmap. Refresh
 * interval is 60s — operators are usually scrubbing the past, but a
 * tab left open should pick up today's accumulating activity.
 */
export function useRecordingsSummary(cameraName: string | null) {
  const { data, error, isLoading, mutate } = useSWR<RecordingDay[]>(
    cameraName ? ["recordings-summary", cameraName] : null,
    () => fetchRecordingsSummary(cameraName!),
    { refreshInterval: 60_000, revalidateOnFocus: false },
  );
  return {
    days: data ?? [],
    isLoading,
    error,
    refresh: () => mutate(),
  };
}

/**
 * Segments + timeline entries for the chosen `after`/`before` window.
 * Both are fetched together because the Recordings page needs them
 * at the same render — segments to know what's actually playable,
 * timeline to dot the scrubber.
 *
 * The window key uses both timestamps so changing the date or hour
 * triggers a refetch; SWR caches by [camera, after, before] so going
 * back to a previously-viewed hour is instant.
 */
export function useRecordingsRange(
  cameraName: string | null,
  after: number | null,
  before: number | null,
) {
  const enabled =
    !!cameraName &&
    after !== null &&
    before !== null &&
    after > 0 &&
    before > after;

  const segmentsKey = enabled
    ? (["recordings-segments", cameraName, after, before] as const)
    : null;
  const timelineKey = enabled
    ? (["recordings-timeline", cameraName, after, before] as const)
    : null;

  const segmentsSwr = useSWR<RecordingSegment[]>(
    segmentsKey,
    () => fetchRecordingSegments(cameraName!, after!, before!),
    { revalidateOnFocus: false },
  );
  const timelineSwr = useSWR<TimelineEntry[]>(
    timelineKey,
    () => fetchTimeline(cameraName!, after!, before!),
    { revalidateOnFocus: false },
  );

  return {
    segments: segmentsSwr.data ?? [],
    timeline: timelineSwr.data ?? [],
    isLoading: segmentsSwr.isLoading || timelineSwr.isLoading,
    error: segmentsSwr.error ?? timelineSwr.error,
    refresh: () => {
      void segmentsSwr.mutate();
      void timelineSwr.mutate();
    },
  };
}
