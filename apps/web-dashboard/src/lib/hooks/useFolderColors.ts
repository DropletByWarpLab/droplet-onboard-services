"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { fetchFolderColors } from "../api";
import type { FolderColor } from "../types";

const KEY = "/api/files/folder-colors";

/**
 * The caller's folder colours as a `ncFileId → colour` map. A listing entry
 * looks its colour up by the `ncFileId` it already carries, so the listing
 * (and its cache) stays untouched. A failed fetch degrades to "no colours" —
 * colour is decoration, never worth blocking the list over.
 */
export function useFolderColors() {
  const { data, mutate } = useSWR(KEY, fetchFolderColors, {
    revalidateOnFocus: false,
  });
  const colors = useMemo(
    () => new Map<number, FolderColor>((data ?? []).map((c) => [c.ncFileId, c.color])),
    [data]
  );
  return { colors, refresh: mutate };
}
