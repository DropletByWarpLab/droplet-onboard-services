"use client";

import useSWR from "swr";
import { fetchFileTags, addFileTag, deleteFileTag } from "../api";
import type { FileTagInfo } from "../types";

/**
 * WARP-881 / WS-3 — file tags hook.
 *
 * Tags are file-scoped server-side (every reader sees every tag). Like
 * useFileComments this hand-rolls optimistic add/delete with rollback —
 * useShares.ts has no mutator to clone. Adding a label that already exists
 * is an idempotent server-side upsert, so a duplicate add is a no-op rather
 * than an error; the hook de-dupes the optimistic insert to match.
 */
export function useFileTags(filePath: string | null) {
  const key = filePath ? `/api/files/${filePath.replace(/^\/+/, "")}/tags` : null;

  const { data, error, isLoading, mutate } = useSWR<FileTagInfo[]>(
    key,
    () => fetchFileTags(filePath as string),
    { revalidateOnFocus: true },
  );

  const tags = data ?? [];

  /** Optimistically add a tag (no-op if the label already exists). */
  const add = async (rawLabel: string): Promise<void> => {
    const label = rawLabel.trim();
    if (!label) return;
    // Duplicate add is a server-side upsert no-op — short-circuit so the UI
    // doesn't flash a second chip then snap back.
    if (tags.some((t) => t.label.toLowerCase() === label.toLowerCase())) return;

    const optimistic: FileTagInfo = {
      id: `optimistic-${Date.now()}`,
      ncFileId: -1,
      label,
      addedByUserId: "__me__",
      createdAt: new Date().toISOString(),
    };
    await mutate(
      async (current = []) => {
        const saved = await addFileTag(filePath as string, label);
        return [...current.filter((t) => t.id !== optimistic.id), saved];
      },
      {
        optimisticData: [...tags, optimistic],
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  /** Optimistically remove a tag by label, rolling back on failure. */
  const remove = async (label: string): Promise<void> => {
    await mutate(
      async (current = []) => {
        await deleteFileTag(filePath as string, label);
        return current.filter((t) => t.label !== label);
      },
      {
        optimisticData: tags.filter((t) => t.label !== label),
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  return {
    tags,
    error: error as Error | undefined,
    isLoading,
    add,
    remove,
    refresh: mutate,
  };
}
