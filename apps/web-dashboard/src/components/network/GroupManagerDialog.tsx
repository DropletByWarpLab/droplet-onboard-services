"use client";
import { useEffect, useState } from "react";
import * as Icons from "lucide-react";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";
import { useGroupMutations } from "@/lib/hooks/useGroupMutations";
import { IconPicker, type DeviceIconName } from "./IconPicker";

// Preset color swatches for groups. Tailwind `bg-system-*` tokens aren't safe
// to pass through `style={{ backgroundColor }}`, so we keep raw hex values
// here and apply them inline. These mirror the system-* palette.
const PRESET_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

interface Props {
  open: boolean;
  onClose: () => void;
}

export function GroupManagerDialog({ open, onClose }: Props) {
  const { data } = useNetworkGroups();
  const { createGroup, renameGroup, deleteGroup, groupToastForError } = useGroupMutations();
  const [newName, setNewName] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [iconOpenId, setIconOpenId] = useState<string | null>(null);

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
      setConfirmDeleteId(null);
    } catch (err) {
      setToast(groupToastForError(err));
      setConfirmDeleteId(null);
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
            {groups.map((g) => {
              const count = g._count.devices;
              const countLabel = `${count} device${count === 1 ? "" : "s"}`;
              return (
                <li key={g.id} className="p-3">
                  <div className="flex items-center gap-2">
                    <input
                      defaultValue={g.name}
                      onBlur={(e) => {
                        const next = e.target.value.trim();
                        if (next && next !== g.name) {
                          void handleRename(g.id, { name: next });
                        }
                      }}
                      className="type-body text-label-primary bg-transparent border-b border-transparent hover:border-separator focus:border-accent outline-none flex-1 min-w-0"
                      aria-label={`Rename ${g.name}`}
                    />
                    <span className="type-caption-1 text-label-tertiary whitespace-nowrap">
                      {countLabel}
                    </span>
                    {confirmDeleteId !== g.id ? (
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(g.id)}
                        aria-label={`Delete ${g.name}`}
                        className="type-caption-1 text-system-red px-2 py-1 rounded hover:bg-system-red/10"
                      >
                        Delete
                      </button>
                    ) : (
                      <div className="flex items-center gap-1">
                        <span className="type-caption-1 text-label-secondary">
                          {count} ungrouped. Delete?
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleDelete(g.id)}
                          className="type-caption-1 px-2 py-1 bg-system-red text-white rounded"
                        >
                          Yes
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="type-caption-1 px-2 py-1 bg-surface-secondary rounded"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className="type-caption-1 text-label-tertiary">Color</span>
                    {PRESET_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => void handleRename(g.id, { color: c })}
                        aria-label={`Color ${c}`}
                        className={`w-5 h-5 rounded-full border ${
                          g.color === c ? "ring-2 ring-accent" : "border-separator"
                        }`}
                        style={{ backgroundColor: c }}
                      />
                    ))}
                    <button
                      type="button"
                      onClick={() => void handleRename(g.id, { color: null })}
                      className="type-caption-1 text-label-secondary ml-1"
                    >
                      None
                    </button>
                  </div>

                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setIconOpenId(iconOpenId === g.id ? null : g.id)}
                      className="type-caption-1 text-label-secondary"
                    >
                      {iconOpenId === g.id
                        ? "Hide icon picker"
                        : `Icon: ${g.icon ?? "None"}`}
                    </button>
                    {iconOpenId === g.id && (
                      <div className="mt-2">
                        <IconPicker
                          value={g.icon ?? null}
                          onSelect={(icon: DeviceIconName) => {
                            void handleRename(g.id, { icon });
                            setIconOpenId(null);
                          }}
                        />
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
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
            className="dp-button-primary text-sm disabled:opacity-50 disabled:cursor-not-allowed"
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
