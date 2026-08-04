"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Folder,
  FolderPlus,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { useToast } from "@/components/Toast";
import { useConversationList } from "@/lib/hooks/useConversationList";
import { translateError } from "@/lib/friendly-errors";
import type { ConversationSummary } from "@/lib/api";
import { ChatHistoryRow } from "./ChatHistoryRow";
import { exportConversationMarkdown } from "@/lib/export-conversation";
import {
  createChatProject,
  deleteChatProject,
  listChatProjects,
  listConversations,
  type ChatProject,
} from "@/lib/api";
import { groupConversationsByDate } from "@/lib/group-conversations-by-date";

export interface ChatHistoryPanelHandle {
  optimisticInsert: (item: ConversationSummary) => void;
  applyTurnCompleted: (id: string) => Promise<void>;
}

export interface ChatHistoryPanelProps {
  activeConversationId: string | null;
  onSelect: (id: string) => void;
  onNewChat: () => void;
  /** WARP-845 — start a new chat filed under (and seeded by) a project. */
  onNewChatInProject?: (project: ChatProject) => void;
  /** When provided, the panel writes its imperative handle here so the
   *  parent (e.g. useChat) can drive optimistic insert + turn-completed. */
  handleRef?: React.MutableRefObject<ChatHistoryPanelHandle | null>;
}

export function ChatHistoryPanel({
  activeConversationId,
  onSelect,
  onNewChat,
  onNewChatInProject,
  handleRef,
}: ChatHistoryPanelProps) {
  const {
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
    clearProjectLocally,
  } = useConversationList();
  // WARP-844 — raw input value, debounced into the hook's search needle
  // so we don't refetch on every keystroke.
  const [searchDraft, setSearchDraft] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchDraft.trim()), 250);
    return () => clearTimeout(t);
  }, [searchDraft, setSearch]);
  const { toast } = useToast();
  const [pendingDelete, setPendingDelete] =
    useState<ConversationSummary | null>(null);
  // ── WARP-845 — projects state ──
  const [projects, setProjects] = useState<ChatProject[]>([]);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const [newProjectDraft, setNewProjectDraft] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<ConversationSummary | null>(
    null,
  );
  const [pendingProjectDelete, setPendingProjectDelete] =
    useState<ChatProject | null>(null);
  // Projects whose full contents have been fetched (on first expand).
  // Until then the folder count comes from the server's chatCount —
  // `flat` only holds the paginated main-list window.
  const [fetchedProjects, setFetchedProjects] = useState<Set<string>>(
    () => new Set(),
  );

  const loadProjects = async () => {
    try {
      const { projects } = await listChatProjects();
      setProjects(projects);
    } catch {
      // Project list failing must not take the history panel down —
      // the chats themselves still render in the date groups.
      setProjects([]);
    }
  };
  useEffect(() => {
    void loadProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCreateProject = async (name: string) => {
    const trimmed = name.trim();
    setNewProjectDraft(null);
    if (!trimmed) return;
    try {
      const { project } = await createChatProject({ name: trimmed });
      setProjects((prev) => [project, ...prev]);
      setExpandedProjects((prev) => new Set(prev).add(project.id));
    } catch (err) {
      toast(translateError(err, "chat"));
    }
  };

  const confirmProjectDelete = async () => {
    const target = pendingProjectDelete;
    setPendingProjectDelete(null);
    if (!target) return;
    try {
      await deleteChatProject(target.id);
      setProjects((prev) => prev.filter((p) => p.id !== target.id));
      // Chats survive server-side (FK SET NULL) — mirror that locally so
      // they reappear in the date groups without a refetch.
      clearProjectLocally(target.id);
    } catch (err) {
      toast(translateError(err, "chat"));
    }
  };

  const handleMove = async (projectId: string | null) => {
    const target = pendingMove;
    setPendingMove(null);
    if (!target) return;
    await moveToProject(target.id, projectId);
    // Folder counts for collapsed projects come from the server — keep
    // them honest after a move without bookkeeping deltas locally.
    void loadProjects();
  };

  const toggleProject = (id: string) => {
    const opening = !expandedProjects.has(id);
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    // First expand: pull the folder's full contents — the paginated main
    // list may not have loaded chats older than its current window.
    if (opening && !fetchedProjects.has(id)) {
      setFetchedProjects((prev) => new Set(prev).add(id));
      void (async () => {
        try {
          const rows = await listConversations({
            limit: 100,
            offset: 0,
            projectId: id,
          });
          mergeRows(rows);
        } catch {
          // Non-fatal: the folder still shows whatever the main window
          // has; allow a retry on next expand.
          setFetchedProjects((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }
      })();
    }
  };
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

  // WARP-845 — project-grouped vs ungrouped chats. Date groups only show
  // chats without a project; project chats nest under their folder.
  // While SEARCHING, project membership is ignored: every match renders
  // in the date groups so a chat filed in a collapsed folder is still
  // findable (the projects section hides for the same reason).
  const ungroupedGroups = groupConversationsByDate(
    search ? flat : flat.filter((c) => !c.projectId),
    new Date(),
  );
  // Newest-first inside a folder: fetch-on-expand merges older rows at
  // the END of `flat`, so folder order can't just inherit list order.
  const chatsInProject = (projectId: string) =>
    flat
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return (
    <div className="flex flex-col h-full min-h-0 w-full">
      {/* Design-handoff rail header: "Chats" + quiet icon actions. */}
      <div className="conv-head">
        <span className="conv-head-t">Chats</span>
        <button
          type="button"
          onClick={() => setNewProjectDraft("")}
          aria-label="New project"
          title="New project"
          className="conv-new-btn"
        >
          <FolderPlus size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={onNewChat}
          aria-label="New chat"
          title="New chat"
          className="conv-new-btn"
        >
          <Plus size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="conv-search">
        <Search size={14} aria-hidden="true" />
        <input
          type="search"
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          placeholder="Search chats"
          aria-label="Search chats"
        />
        {searchDraft && (
          <button
            type="button"
            onClick={() => setSearchDraft("")}
            aria-label="Clear search"
            className="chat-iconbtn !w-6 !h-6"
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="conv-list">
        {/* Error renders as a banner so a single failed action (e.g. one
            move PATCH) doesn't blank the whole sidebar. */}
        {error && (
          <div
            role="alert"
            className="px-2 py-2 mb-2 rounded-md bg-system-red/10 type-footnote text-system-red"
          >
            {error}
          </div>
        )}
        {/* WARP-845 — projects (per-user folders) above the date groups.
            Rendered even with zero chats (a fresh user's first move may
            well be "create a project"); hidden while searching, when all
            matches surface in the date groups instead. */}
        {!search && (projects.length > 0 || newProjectDraft !== null) && (
          <div className="conv-group">
            <div className="conv-cap">Projects</div>
            <div className="space-y-0.5">
              {projects.map((project) => {
                const chats = chatsInProject(project.id);
                const expanded = expandedProjects.has(project.id);
                return (
                  <div key={project.id}>
                    <div className="conv-row group/project relative">
                      <button
                        type="button"
                        onClick={() => toggleProject(project.id)}
                        aria-expanded={expanded}
                        className="conv-item !flex-row items-center gap-1.5"
                      >
                        <ChevronRight
                          size={12}
                          aria-hidden="true"
                          className={`flex-none transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
                        />
                        <Folder
                          size={13}
                          aria-hidden="true"
                          className="flex-none text-label-tertiary"
                        />
                        <span className="conv-it-t flex-1">{project.name}</span>
                        <span className="flex-none type-caption-2 text-label-quaternary">
                          {fetchedProjects.has(project.id)
                            ? chats.length
                            : project.chatCount}
                        </span>
                      </button>
                      {/* opacity (not display:none) so the buttons stay
                              keyboard-reachable — matches ChatHistoryRow. */}
                      <div className="conv-acts">
                        {onNewChatInProject && (
                          <button
                            type="button"
                            onClick={() => onNewChatInProject(project)}
                            aria-label={`New chat in ${project.name}`}
                            className="p-1 rounded text-label-tertiary hover:text-label-primary"
                          >
                            <Plus size={12} aria-hidden="true" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setPendingProjectDelete(project)}
                          aria-label={`Delete project ${project.name}`}
                          className="p-1 rounded text-label-tertiary hover:text-system-red"
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </button>
                      </div>
                    </div>
                    {expanded && (
                      <div className="ml-4 space-y-0.5">
                        {chats.length === 0 ? (
                          <div className="px-2 py-1 type-caption-1 text-label-quaternary">
                            No chats yet
                          </div>
                        ) : (
                          chats.map((item) => (
                            <ChatHistoryRow
                              key={item.id}
                              id={item.id}
                              title={item.title}
                              active={item.id === activeConversationId}
                              onSelect={() => onSelect(item.id)}
                              onRenameSubmit={(title) =>
                                handleRename(item.id, title)
                              }
                              onDeleteRequest={() => setPendingDelete(item)}
                              onExport={() => void handleExport(item.id)}
                              onMoveRequest={() => setPendingMove(item)}
                            />
                          ))
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {newProjectDraft !== null && (
                <input
                  className="conv-search !m-0 !h-9 w-full px-3 text-[16px] lg:text-[13px]"
                  autoFocus
                  value={newProjectDraft}
                  onChange={(e) => setNewProjectDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter")
                      void handleCreateProject(newProjectDraft);
                    else if (e.key === "Escape") setNewProjectDraft(null);
                  }}
                  onBlur={() => void handleCreateProject(newProjectDraft)}
                  placeholder="Project name…"
                  aria-label="New project name"
                />
              )}
            </div>
          </div>
        )}
        {isLoading && flat.length === 0 ? (
          <div className="conv-none">Loading chats…</div>
        ) : flat.length === 0 ? (
          !error && (
            <div className="conv-none">
              {search
                ? "No chats match your search."
                : "No chats yet. Start by asking something below."}
            </div>
          )
        ) : (
          <>
            {ungroupedGroups.map((group) => (
              <div key={group.label} className="conv-group">
                <div className="conv-cap">{group.label}</div>
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
                      onMoveRequest={() => setPendingMove(item)}
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
        {/* Body padding comes from the <Dialog> primitive (WARP-1153). */}
        <div>
          <h2 id={deleteHeadingId} className="type-headline mb-2">
            Delete this chat?
          </h2>
          <p className="type-subheadline text-label-secondary mb-4">
            &ldquo;{pendingDelete?.title?.trim() || "Untitled chat"}&rdquo; will
            be permanently removed. This can&rsquo;t be undone.
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

      {/* WARP-845 — move-to-project chooser. */}
      <Dialog
        open={pendingMove !== null}
        onClose={() => setPendingMove(null)}
        labelledBy="move-chat-heading"
        maxWidth="sm"
      >
        <div>
          <h2 id="move-chat-heading" className="type-headline mb-2">
            Move chat to…
          </h2>
          <div className="space-y-1">
            {projects.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => void handleMove(p.id)}
                className="w-full text-left px-3 py-2 rounded-md type-subheadline
                  flex items-center gap-2 text-label-primary
                  hover:bg-surface-secondary transition-colors"
              >
                <Folder
                  size={14}
                  aria-hidden="true"
                  className="text-label-tertiary"
                />
                {p.name}
              </button>
            ))}
            {pendingMove?.projectId && (
              <button
                type="button"
                onClick={() => void handleMove(null)}
                className="w-full text-left px-3 py-2 rounded-md type-subheadline
                  flex items-center gap-2 text-label-secondary
                  hover:bg-surface-secondary transition-colors"
              >
                <X size={14} aria-hidden="true" />
                Remove from project
              </button>
            )}
            {projects.length === 0 && (
              <p className="type-footnote text-label-tertiary px-1 py-2">
                No projects yet — create one with the folder button above the
                search field.
              </p>
            )}
          </div>
        </div>
      </Dialog>

      {/* WARP-845 — delete-project confirm. Chats survive (they fall back
          to the date groups); only the folder + its default persona go. */}
      <Dialog
        open={pendingProjectDelete !== null}
        onClose={() => setPendingProjectDelete(null)}
        labelledBy="delete-project-heading"
        maxWidth="sm"
      >
        <div>
          <h2 id="delete-project-heading" className="type-headline mb-2">
            Delete this project?
          </h2>
          <p className="type-subheadline text-label-secondary mb-4">
            &ldquo;{pendingProjectDelete?.name}&rdquo; will be removed. Its
            chats are kept and move back to the main list.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingProjectDelete(null)}
              className="type-subheadline text-accent hover:text-accent-hover px-3 py-2 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void confirmProjectDelete()}
              className="type-subheadline px-4 py-1.5 rounded-md bg-system-red text-white
                         hover:bg-system-red/90 inline-flex items-center gap-1.5 min-h-[36px]"
            >
              Delete project
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
