"use client";
import { useEffect, useState } from "react";
import * as Icons from "lucide-react";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";
import { useGroupMutations } from "@/lib/hooks/useGroupMutations";
import { GroupRow } from "./GroupRow";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function GroupManagerDialog({ open, onClose }: Props) {
  const { data } = useNetworkGroups();
  const { createGroup, renameGroup, deleteGroup, groupToastForError } = useGroupMutations();
  const [newName, setNewName] = useState("");
  const [toast, setToast] = useState<string | null>(null);

  // ESC closes the dialog. Only bound while open so we don't steal Escape
  // from the rest of the page.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label="Manage groups"
        onClick={(e) => e.stopPropagation()}
        className="bg-surface-primary border border-separator rounded-lg w-full max-w-lg max-h-[80vh] overflow-y-auto shadow-xl"
      >
        <div className="p-4 border-b border-separator flex items-center justify-between">
          <h2 className="type-title-3 text-label-primary">Manage groups</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-label-secondary hover:text-label-primary"
          >
            <Icons.X className="w-5 h-5" />
          </button>
        </div>

        {groups.length === 0 ? (
          <p className="p-4 type-subheadline text-label-tertiary">
            No groups yet. Create one below to start organizing devices.
          </p>
        ) : (
          <ul className="divide-y divide-separator">
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

        <div className="p-3 border-t border-separator flex gap-2">
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
            className="flex-1 bg-surface-secondary border border-separator rounded px-3 py-1.5 type-body"
            aria-label="New group name"
          />
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!newName.trim()}
            className="dp-btn-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Create
          </button>
        </div>

        {toast && (
          <div
            role="alert"
            className="px-4 py-2 text-system-red flex items-center justify-between border-t border-separator"
          >
            <span>{toast}</span>
            <button
              type="button"
              onClick={() => setToast(null)}
              aria-label="Dismiss"
              className="ml-2 text-label-secondary"
            >
              ×
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
