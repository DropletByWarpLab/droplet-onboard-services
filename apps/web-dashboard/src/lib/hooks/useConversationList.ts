/**
 * WARP-331 — paginated chat-history list for /chat.
 *
 * Drives `ChatHistoryPanel`. Owns the list state, exposes the mutation
 * helpers the panel + useChat call into. Date-grouping is derived on
 * every render via `groupConversationsByDate` — cheap, keeps state flat.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  listConversations,
  renameConversation,
  deleteConversation,
  fetchConversation,
  type ConversationSummary,
} from "@/lib/api";
import {
  groupConversationsByDate,
  type ConversationGroup,
} from "@/lib/group-conversations-by-date";

type ConversationGroupRow = ConversationGroup<ConversationSummary>;

const PAGE_SIZE = 30;

export function useConversationList(): {
  groups: ConversationGroupRow[];
  flat: ConversationSummary[];
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  optimisticInsert: (item: ConversationSummary) => void;
  applyTurnCompleted: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<boolean>;
} {
  const [flat, setFlat] = useState<ConversationSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const offsetRef = useRef(0);
  const inFlightRef = useRef(false);

  // Mirror of `flat` kept in a ref so callbacks can read the latest list
  // without needing it in their dep arrays.
  const flatRef = useRef<ConversationSummary[]>([]);
  useEffect(() => {
    flatRef.current = flat;
  }, [flat]);

  // Tracks ids of conversations currently being renamed so that a
  // concurrent turn-completed event doesn't clobber the user's intended
  // title with a server-derived one.
  const pendingRenameIdsRef = useRef<Set<string>>(new Set());

  // Unmount guard — shared by loadMore, applyTurnCompleted, and remove.
  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const page = await listConversations({ limit: PAGE_SIZE, offset: 0 });
        if (cancelled) return;
        setFlat(page);
        offsetRef.current = page.length;
        setHasMore(page.length === PAGE_SIZE);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load conversations");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadMore = useCallback(async () => {
    if (inFlightRef.current || !hasMore) return;
    inFlightRef.current = true;
    try {
      const next = await listConversations({
        limit: PAGE_SIZE,
        offset: offsetRef.current,
      });
      if (!isMountedRef.current) return;
      setFlat((prev) => [...prev, ...next]);
      offsetRef.current += next.length;
      setHasMore(next.length === PAGE_SIZE);
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load more");
    } finally {
      inFlightRef.current = false;
    }
  }, [hasMore]);

  const optimisticInsert = useCallback((item: ConversationSummary) => {
    setFlat((prev) => {
      // De-dupe by id (the server may already have raced us with the real row).
      const without = prev.filter((c) => c.id !== item.id);
      return [item, ...without];
    });
  }, []);

  const applyTurnCompleted = useCallback(async (id: string) => {
    const detail = await fetchConversation(id);
    if (!detail) return;
    if (!isMountedRef.current) return;
    setFlat((prev) =>
      prev.map((c) => {
        if (c.id !== id) return c;
        // If a rename is in flight for this id, don't clobber the user's
        // intended title with the server's auto-derived one. Bump updatedAt
        // either way so date-bucket ordering tracks the new turn.
        if (pendingRenameIdsRef.current.has(id)) {
          return { ...c, updatedAt: detail.updatedAt };
        }
        return { ...c, title: detail.title, updatedAt: detail.updatedAt };
      }),
    );
  }, []);

  const rename = useCallback(async (id: string, title: string) => {
    // Snapshot prevTitle BEFORE entering the functional updater so the
    // updater stays pure (safe under React StrictMode's double-invoke).
    const prevTitle = flatRef.current.find((c) => c.id === id)?.title ?? null;
    pendingRenameIdsRef.current.add(id);
    setFlat((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    try {
      const final = await renameConversation(id, title);
      setFlat((prev) => prev.map((c) => (c.id === id ? { ...c, title: final.title } : c)));
    } catch (err) {
      // Revert
      setFlat((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title: prevTitle } : c)),
      );
      throw err;
    } finally {
      pendingRenameIdsRef.current.delete(id);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    const ok = await deleteConversation(id);
    if (!isMountedRef.current) return ok;
    if (ok) setFlat((prev) => prev.filter((c) => c.id !== id));
    return ok;
  }, []);

  const groups = useMemo(
    // Date buckets are anchored to the time of last `flat` change.
    // After midnight, "Today" items stay in "Today" until flat next
    // mutates — acceptable for a short-lived sidebar session.
    () => groupConversationsByDate(flat, new Date()),
    [flat],
  );

  return {
    groups,
    flat,
    hasMore,
    isLoading,
    error,
    loadMore,
    optimisticInsert,
    applyTurnCompleted,
    rename,
    remove,
  };
}
