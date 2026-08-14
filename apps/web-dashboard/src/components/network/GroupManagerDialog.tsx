"use client";
import { useId, useState } from "react";
import * as Icons from "lucide-react";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";
import { useGroupMutations } from "@/lib/hooks/useGroupMutations";
import { GroupRow } from "./GroupRow";
import { Dialog } from "@/components/Dialog";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * WARP-289: rebuilt on the shared <Dialog> primitive. Escape close, focus
 * restore, body scroll-lock, and the role=dialog + aria-modal +
 * aria-labelledby triad come from there.
 */
export function GroupManagerDialog({ open, onClose }: Props) {
  const { data } = useNetworkGroups();
  const { createGroup, renameGroup, deleteGroup, groupToastForError } = useGroupMutations();
  const [newName, setNewName] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  const headingId = useId();

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    try {
      await createGroup(name);
      setNewName("");
    } catch (err) {
      setToast(groupToastForError(err));
    }
  }

  async function handleRename(
    id: string,
    patch: { name?: string; color?: string | null; icon?: string | null },
  ) {
    try {
      await renameGroup(id, patch);
    } catch (err) {
      setToast(groupToastForError(err));
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteGroup(id);
    } catch (err) {
      setToast(groupToastForError(err));
    }
  }

  const groups = data?.groups ?? [];

  return (
    // `flush`: sectioned layout — the full-width header divider + sections
    // own their padding; scroll comes from the primitive body (WARP-1153).
    <Dialog open={open} onClose={onClose} labelledBy={headingId} maxWidth="lg" flush>
      <div>
        <div className="p-4 border-b border-[var(--card-bd)] flex items-center justify-between">
          <h2 id={headingId} className="type-title-3 text-[color:var(--text)]">
            Manage groups
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[color:var(--text-muted)] hover:text-[color:var(--text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] rounded-sm"
          >
            <Icons.X className="w-5 h-5" />
          </button>
        </div>

        {groups.length === 0 ? (
          <p className="p-4 type-subheadline text-[color:var(--text-muted)]">
            No groups yet. Create one below to start organizing devices.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--card-bd)]">
            {groups.map((g) => (
              <GroupRow
                key={g.id}
                group={g}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}

        <div className="p-3 border-t border-[var(--card-bd)] flex gap-2">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="New group name"
            className="flex-1 px-3 py-1.5 type-body outline-none focus:border-[var(--brand)] placeholder:text-[var(--text-faint)] transition-colors"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--text)",
            }}
            aria-label="New group name"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!newName.trim()}
            className="btn primary sm"
          >
            Create
          </button>
        </div>

        {toast && (
          <div
            role="alert"
            className="px-4 py-2 text-system-red flex items-center justify-between border-t border-[var(--card-bd)]"
          >
            <span>{toast}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Dismiss"
              className="ml-2 text-[color:var(--text-muted)]"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
