"use client";

/**
 * WARP-1683 — "New message": pick one colleague for a DM, several for a
 * group (a name field appears once it's a group). The roster is
 * GET /api/team-chat/contacts — every ACTIVE member, all roles — minus
 * the caller. The server dedupes direct pairs, so re-picking an existing
 * DM lands in the existing conversation instead of a duplicate.
 */

import { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { Dialog } from "@/components/Dialog";
import { createTeamChatThread } from "@/lib/api";
import { useTeamChatContacts } from "@/lib/hooks/useTeamChat";

export function NewThreadDialog({
  open,
  onClose,
  meId,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  meId: string;
  onCreated: (threadId: string) => void;
}) {
  const { contacts, isLoading } = useTeamChatContacts();
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roster = useMemo(() => {
    const others = (contacts ?? []).filter((c) => c.id !== meId);
    const q = query.trim().toLowerCase();
    if (!q) return others;
    return others.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        c.username.toLowerCase().includes(q),
    );
  }, [contacts, meId, query]);

  const isGroup = selected.length > 1;

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  function reset() {
    setSelected([]);
    setTitle("");
    setQuery("");
    setError(null);
  }

  async function create() {
    if (selected.length === 0 || creating) return;
    setCreating(true);
    setError(null);
    try {
      const thread = await createTeamChatThread({
        kind: isGroup ? "group" : "direct",
        participantIds: selected,
        ...(isGroup && title.trim().length > 0 ? { title: title.trim() } : {}),
      });
      reset();
      onCreated(thread.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start conversation");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      labelledBy="new-message-title"
    >
      <div>
        <h2 id="new-message-title" className="mx-dlg-title">
          New message
        </h2>
        <p className="mx-dlg-sub">
          Pick one person for a direct message, or several for a group.
        </p>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people"
          aria-label="Search people"
          className="mx-field mt-3"
        />

        <div className="mx-list mt-2 max-h-60">
          {isLoading && !contacts && (
            <p className="mx-quiet px-3 py-3">Loading people…</p>
          )}
          {contacts && roster.length === 0 && (
            <p className="mx-quiet px-3 py-3">
              {query ? "No one matches that search." : "No other members yet."}
            </p>
          )}
          {roster.map((c) => {
            const active = selected.includes(c.id);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => toggle(c.id)}
                aria-pressed={active}
                className={`mx-row items-center ${active ? "is-active" : ""}`}
              >
                <span aria-hidden="true" className="mx-ava w-7 h-7 text-[11px]">
                  {c.displayName.slice(0, 2).toUpperCase()}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="mx-row-name block truncate">
                    {c.displayName}
                  </span>
                  <span className="mx-row-preview block truncate">
                    {c.username}
                  </span>
                </span>
                {active && (
                  <Check
                    size={16}
                    className="flex-shrink-0"
                    style={{ color: "var(--brand)" }}
                    aria-hidden="true"
                  />
                )}
              </button>
            );
          })}
        </div>

        {isGroup && (
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
            placeholder="Group name (optional)"
            aria-label="Group name"
            className="mx-field mt-3"
          />
        )}

        {error && (
          <p role="alert" className="mx-error mt-2">
            {error}
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            className="btn"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void create()}
            disabled={selected.length === 0 || creating}
            className="btn primary"
          >
            {creating
              ? "Starting…"
              : isGroup
                ? `Start group (${selected.length})`
                : "Start conversation"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
