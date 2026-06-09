"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { useConversationList } from "@/lib/hooks/useConversationList";
import { translateError } from "@/lib/friendly-errors";
import type { ConversationSummary } from "@/lib/api";
import { ChatHistoryRow } from "./ChatHistoryRow";
import { exportConversationMarkdown } from "@/lib/export-conversation";

export interface ChatHistoryPanelHandle {
  optimisticInsert: (item: ConversationSummary) => void;
  applyTurnCompleted: (id: string) => Promise<void>;
}

export interface ChatHistoryPanelProps {
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /** When provided, the panel writes its imperative handle here so the
   *  parent (e.g. useChat) can drive optimistic insert + turn-completed. */
  handleRef?: React.MutableRefObject<ChatHistoryPanelHandle | null>;
}

export function ChatHistoryPanel({
  activeConversationId,
  onSelect,
  onNewChat,
  handleRef,
}: ChatHistoryPanelProps) {
  const {
    groups,
    flat,
    hasMore,
    isLoading,
    error,
    loadMore,
    setSearch,
    optimisticInsert,
    applyTurnCompleted,
    rename,
    remove,
  } = useConversationList();
  // WARP-844 — raw input value, debounced into the hook's search needle
  // so we don't refetch on every keystroke.
  const [searchDraft, setSearchDraft] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchDraft.trim()), 250);
    return () => clearTimeout(t);
  }, [searchDraft, setSearch]);
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] = useState<ConversationSummary | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const deleteHeadingId = "chat-history-delete-heading";

  // Publish imperative handle for useChat to call into.
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = { optimisticInsert, applyTurnCompleted };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef, optimisticInsert, applyTurnCompleted]);

  // Infinite scroll sentinel.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore || isLoading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMore();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, isLoading, loadMore]);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      const ok = await remove(target.id);
      if (!ok) toast("Chat already deleted");
      // If the user just deleted the chat they're currently viewing,
      // route back to a fresh /chat so the messages column doesn't keep
      // pointing at a dead id. The parent owns routing — we ask via
      // onNewChat() rather than calling router.push ourselves.
      if (target.id === activeConversationId) {
        onNewChat();
      }
    } catch (err) {
      toast(translateError(err, "chat"));
    }
  };

  const handleRename = async (id: string, title: string) => {
    try {
      await rename(id, title);
    } catch (err) {
      toast(translateError(err, "chat"));
    }
  };

  const handleExport = async (id: string) => {
    try {
      await exportConversationMarkdown(id);
    } catch (err) {
      toast(translateError(err, "chat"));
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="px-3 pt-3 pb-2 border-b border-separator">
        <button
          type="button"
          onClick={onNewChat}
          className="w-full flex items-center justify-center gap-2 h-9 rounded-md
                     bg-accent text-white type-subheadline font-medium
                     hover:bg-accent-strong transition-colors"
        >
          <Plus size={16} /> New chat
        </button>
        <div className="relative mt-2">
          <Search
            size={14}
            aria-hidden="true"
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-label-tertiary pointer-events-none"
          />
          <input
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search chats…"
            aria-label="Search chats"
            className="dp-input type-footnote h-8 w-full pl-8 pr-7"
          />
          {searchDraft && (
            <button
              type="button"
              onClick={() => setSearchDraft("")}
              aria-label="Clear search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-sm text-label-tertiary hover:text-label-primary"
            >
              <X size={12} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {isLoading && flat.length === 0 ? (
          <div className="px-2 py-4 type-footnote text-label-tertiary">Loading chats…</div>
        ) : error ? (
          <div className="px-2 py-4 type-footnote text-system-red">{error}</div>
        ) : flat.length === 0 ? (
          <div className="px-2 py-8 text-center type-footnote text-label-tertiary">
            No chats yet. Start by asking something below.
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <div key={group.label} className="mb-3">
                <div className="px-2 py-1 type-caption-2 text-label-tertiary uppercase tracking-wide">
                  {group.label}
                </div>
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <ChatHistoryRow
                      key={item.id}
                      id={item.id}
                      title={item.title}
                      active={item.id === activeConversationId}
                      onSelect={() => onSelect(item.id)}
                      onRenameSubmit={(title) => handleRename(item.id, title)}
                      onDeleteRequest={() => setPendingDelete(item)}
                      onExport={() => void handleExport(item.id)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {hasMore && <div ref={sentinelRef} className="h-4" aria-hidden />}
          </>
        )}
      </div>

      <Dialog
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        labelledBy={deleteHeadingId}
        maxWidth="sm"
      >
        <div className="p-5">
          <h2 id={deleteHeadingId} className="type-headline mb-2">
            Delete this chat?
          </h2>
          <p className="type-subheadline text-label-secondary mb-4">
            &ldquo;{pendingDelete?.title?.trim() || "Untitled chat"}&rdquo; will be permanently removed.
            This can&rsquo;t be undone.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className="type-subheadline text-accent hover:text-accent-hover px-3 py-2 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmDelete()}
              className="type-subheadline px-4 py-1.5 rounded-md bg-system-red text-white
                         hover:bg-system-red/90 inline-flex items-center gap-1.5 min-h-[36px]"
            >
              Delete
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
