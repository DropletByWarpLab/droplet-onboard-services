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
  setConversationPinned,
  setConversationProject,
  type ConversationSummary,
} from "@/lib/api";
import {
  groupConversationsByDate,
  type ConversationGroup,
} from "@/lib/group-conversations-by-date";
import { translateError } from "@/lib/friendly-errors";

type ConversationGroupRow = ConversationGroup<ConversationSummary>;

const PAGE_SIZE = 30;

export function useConversationList(): {
  groups: ConversationGroupRow[];
  flat: ConversationSummary[];
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  loadMore: () => Promise<void>;
  /** WARP-844 — current search needle ("" = no filter). */
  search: string;
  setSearch: (q: string) => void;
  optimisticInsert: (item: ConversationSummary) => void;
  /** WARP-845 — append rows not already present (by id). Used by the
   *  sidebar's fetch-on-expand so a folder shows ALL its chats, not just
   *  the ones the paginated main window happens to have loaded. */
  mergeRows: (items: ConversationSummary[]) => void;
  applyTurnCompleted: (id: string) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<boolean>;
  /** WARP-845 — move a chat into (or out of, with null) a project.
   *  Optimistic; reverts on server failure. */
  moveToProject: (id: string, projectId: string | null) => Promise<void>;
  /** WARP-1917 — pin (true) / unpin (false) a chat. Optimistic; reverts
   *  on server failure. */
  togglePin: (id: string, pinned: boolean) => Promise<void>;
  /** WARP-845 — local-only mirror of the FK SET NULL after a project is
   *  deleted server-side: its chats fall back to the date groups without
   *  a refetch. */
  clearProjectLocally: (projectId: string) => void;
} {
  const [flat, setFlat] = useState<ConversationSummary[]>([]);
  const [search, setSearch] = useState("");
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

  // Initial load + refetch-on-search (WARP-844). A search change resets
  // pagination and replaces the list wholesale; "" restores the
  // unfiltered first page.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    (async () => {
      try {
        const page = await listConversations({
          limit: PAGE_SIZE,
          offset: 0,
          ...(search ? { q: search } : {}),
        });
        if (cancelled) return;
        setFlat(page);
        offsetRef.current = page.length;
        setHasMore(page.length === PAGE_SIZE);
      } catch (err) {
        if (cancelled) return;
        setError(translateError(err, "chat"));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [search]);

  const loadMore = useCallback(async () => {
    if (inFlightRef.current || !hasMore) return;
    inFlightRef.current = true;
    try {
      const next = await listConversations({
        limit: PAGE_SIZE,
        offset: offsetRef.current,
        ...(search ? { q: search } : {}),
      });
      if (!isMountedRef.current) return;
      // De-dupe by id (mirrors mergeRows): a pin/unpin mid-session
      // (WARP-1917) reorders the server list, so a later page can re-serve
      // a row an earlier page already delivered. Appending it raw would
      // duplicate a React key and render the chat twice in its date group.
      setFlat((prev) => {
        const known = new Set(prev.map((c) => c.id));
        return [...prev, ...next.filter((c) => !known.has(c.id))];
      });
      // Offset advances by the RAW page length — it tracks the server's
      // ordering, not the locally de-duped count.
      offsetRef.current += next.length;
      setHasMore(next.length === PAGE_SIZE);
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(translateError(err, "chat"));
    } finally {
      inFlightRef.current = false;
    }
  }, [hasMore, search]);

  const optimisticInsert = useCallback((item: ConversationSummary) => {
    setFlat((prev) => {
      // De-dupe by id (the server may already have raced us with the real row).
      const without = prev.filter((c) => c.id !== item.id);
      return [item, ...without];
    });
  }, []);

  const mergeRows = useCallback((items: ConversationSummary[]) => {
    setFlat((prev) => {
      const known = new Set(prev.map((c) => c.id));
      const fresh = items.filter((c) => !known.has(c.id));
      return fresh.length === 0 ? prev : [...prev, ...fresh];
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

  const moveToProject = useCallback(
    async (id: string, projectId: string | null) => {
      const prev = flatRef.current.find((c) => c.id === id)?.projectId ?? null;
      setFlat((cur) =>
        cur.map((c) => (c.id === id ? { ...c, projectId } : c)),
      );
      try {
        await setConversationProject(id, projectId);
      } catch (err) {
        if (!isMountedRef.current) return;
        setFlat((cur) =>
          cur.map((c) => (c.id === id ? { ...c, projectId: prev } : c)),
        );
        setError(translateError(err, "chat"));
      }
    },
    [],
  );

  const togglePin = useCallback(async (id: string, pinned: boolean) => {
    const prev = flatRef.current.find((c) => c.id === id);
    const prevPinned = prev?.pinned ?? false;
    const prevPinnedAt = prev?.pinnedAt ?? null;
    // Optimistic: stamp pinnedAt locally so the Pinned section orders the
    // fresh pin first immediately; the server's own stamp replaces it on
    // the next list fetch.
    setFlat((cur) =>
      cur.map((c) =>
        c.id === id
          ? {
              ...c,
              pinned,
              pinnedAt: pinned ? new Date().toISOString() : null,
            }
          : c,
      ),
    );
    try {
      await setConversationPinned(id, pinned);
    } catch (err) {
      if (!isMountedRef.current) return;
      setFlat((cur) =>
        cur.map((c) =>
          c.id === id
            ? { ...c, pinned: prevPinned, pinnedAt: prevPinnedAt }
            : c,
        ),
      );
      setError(translateError(err, "chat"));
    }
  }, []);

  const clearProjectLocally = useCallback((projectId: string) => {
    setFlat((cur) =>
      cur.map((c) => (c.projectId === projectId ? { ...c, projectId: null } : c)),
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
    search,
    setSearch,
    optimisticInsert,
    mergeRows,
    applyTurnCompleted,
    rename,
    remove,
    moveToProject,
    togglePin,
    clearProjectLocally,
  };
}
