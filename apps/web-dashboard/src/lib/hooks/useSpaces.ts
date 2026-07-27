"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { fetchSpaces } from "../api";
import {
  displayLocationForPath,
  filesUrlForEntry,
  inSpacePath,
  libraryLabelForPath,
  resolveFileSpace,
} from "../space-attribution";
import type { FileSpacesResponse } from "../types";

/**
 * WARP-883 (ADR-027 WS-5) — which Files spaces exist for the current user.
 *
 * Drives the My Files / Shared switcher: the switcher only appears when the
 * shared "Household" space is available. Defaults to shared-unavailable until
 * the probe resolves so the UI never flashes a switcher that then vanishes.
 */
export function useSpaces() {
  const { data, error, isLoading } = useSWR<FileSpacesResponse>(
    "/api/files/spaces",
    () => fetchSpaces(),
    { revalidateOnFocus: false }
  );

  return {
    spaces: data?.spaces ?? [],
    sharedAvailable: data?.sharedAvailable ?? false,
    error,
    isLoading,
  };
}

/**
 * WARP-1549 — library attribution for any sub-view that lists files it did not
 * browse into: Favorites, Recents, Trash, Shared.
 *
 * The space list IS the attribution source (ADR-029: never read Nextcloud
 * state as truth), so this is just `useSpaces()` plus the pure resolver in
 * `lib/space-attribution.ts`. Rows are attributed at render time, which is
 * what makes a revoked membership stop claiming its library on the very next
 * render rather than persisting in cached row data.
 *
 * While the space list is still loading — or if its probe failed — `label`
 * returns null for everything, so the UI says nothing rather than declaring
 * that a library file is in My Files.
 */
export function useSpaceAttribution() {
  const { spaces, isLoading, error } = useSpaces();
  return useMemo(
    () => ({
      spaces,
      isLoading,
      error,
      /** Full attribution for a home-relative path (confidence included). */
      resolve: (path: string) => resolveFileSpace(path, spaces),
      /** The library chip's text, or null for "make no claim". */
      label: (path: string) => libraryLabelForPath(path, spaces),
      /** A file's PARENT folder, shown inside its library when attributable. */
      location: (path: string) => displayLocationForPath(path, spaces),
      /** A FOLDER path, shown inside its library when attributable. */
      folderLocation: (path: string) => inSpacePath(path, spaces),
      /** The `/files` link a row click should navigate to. */
      href: (entry: { path: string; isDirectory: boolean }) =>
        filesUrlForEntry(entry, spaces),
    }),
    [spaces, isLoading, error]
  );
}
