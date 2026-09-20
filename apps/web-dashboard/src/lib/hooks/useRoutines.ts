"use client";

import useSWR from "swr";
import {
  fetchRoutine,
  fetchRoutineRuns,
  fetchRoutineSchedules,
  fetchRoutines,
} from "../api";
import type { Routine, RoutineRun, RoutineSchedule } from "../types";

/**
 * WARP-2671 — the `/routines` data layer.
 *
 * One list fetch, unfiltered, sliced client-side into the three tabs. The
 * route supports `?status=`, but a box holds tens of routines, not
 * thousands, and one request that all three tabs share beats three requests
 * that each go stale independently — switching tabs should not re-fetch.
 */
export function useRoutines() {
  const { data, error, isLoading, mutate } = useSWR<Routine[]>(
    "/api/tools?routines",
    () => fetchRoutines(),
    { refreshInterval: 60_000 },
  );

  const routines = data ?? [];
  return {
    routines,
    live: routines.filter((r) => r.status === "live"),
    drafts: routines.filter((r) => r.status === "draft"),
    suggested: routines.filter((r) => r.status === "suggested"),
    isLoading,
    error: error as Error | undefined,
    refresh: mutate,
  };
}

/** A routine with its ordered steps — the list response omits them. */
export function useRoutine(slug: string | null) {
  const { data, error, isLoading, mutate } = useSWR<Routine>(
    slug ? `/api/tools/${slug}` : null,
    () => fetchRoutine(slug as string),
  );
  return {
    routine: data,
    isLoading,
    error: error as Error | undefined,
    refresh: mutate,
  };
}

export function useRoutineRuns(slug: string | null) {
  const { data, error, isLoading, mutate } = useSWR<RoutineRun[]>(
    slug ? `/api/tools/${slug}/runs` : null,
    () => fetchRoutineRuns(slug as string),
    { refreshInterval: 30_000 },
  );
  return {
    runs: data ?? [],
    isLoading,
    error: error as Error | undefined,
    refresh: mutate,
  };
}

export function useRoutineSchedules(slug: string | null) {
  const { data, error, isLoading, mutate } = useSWR<RoutineSchedule[]>(
    slug ? `/api/tools/${slug}/schedules` : null,
    () => fetchRoutineSchedules(slug as string),
  );
  return {
    schedules: data ?? [],
    isLoading,
    error: error as Error | undefined,
    refresh: mutate,
  };
}
