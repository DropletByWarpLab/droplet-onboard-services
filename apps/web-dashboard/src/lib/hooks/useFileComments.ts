"use client";

import useSWR from "swr";
import { fetchFileComments, addFileComment, deleteFileComment } from "../api";
import type { FileCommentInfo } from "../types";

/**
 * WARP-881 / WS-3 — file comments hook.
 *
 * useShares.ts is read-only SWR with no mutators, so there's no
 * optimistic-mutation precedent to clone; this hand-rolls add/delete with
 * optimistic rollback. Reads are user-scoped server-side (a family member
 * sees only their own; owner/admin see all) — the hook is agnostic to that.
 *
 * The SWR key is the same `/api/files…` shape useFileRealtime's blanket
 * invalidation targets, so an MQTT comment event revalidates this list too.
 */
export function useFileComments(filePath: string | null) {
  const key = filePath
    ? `/api/files/${filePath.replace(/^\/+/, "")}/comments`
    : null;

  const { data, error, isLoading, mutate } = useSWR<FileCommentInfo[]>(
    key,
    () => fetchFileComments(filePath as string),
    { revalidateOnFocus: true },
  );

  const comments = data ?? [];

  /** Optimistically append a comment, rolling back on failure. */
  const add = async (body: string): Promise<void> => {
    const trimmed = body.trim();
    if (!trimmed) return;
    const optimistic: FileCommentInfo = {
      id: `optimistic-${Date.now()}`,
      ncFileId: -1,
      authorUserId: "__me__",
      body: trimmed,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await mutate(
      async (current = []) => {
        const saved = await addFileComment(filePath as string, trimmed);
        // Replace the optimistic placeholder with the server row.
        return [saved, ...current.filter((c) => c.id !== optimistic.id)];
      },
      {
        optimisticData: [optimistic, ...comments],
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  /** Optimistically remove a comment, rolling back on failure. */
  const remove = async (id: string): Promise<void> => {
    await mutate(
      async (current = []) => {
        await deleteFileComment(id);
        return current.filter((c) => c.id !== id);
      },
      {
        optimisticData: comments.filter((c) => c.id !== id),
        rollbackOnError: true,
        revalidate: false,
      },
    );
  };

  return {
    comments,
    error: error as Error | undefined,
    isLoading,
    add,
    remove,
    refresh: mutate,
  };
}
