"use client";
import { useState } from "react";
import { useNetworkGroups } from "@/lib/hooks/useNetworkGroups";
import { useGroupMutations } from "@/lib/hooks/useGroupMutations";
import { useDeviceMutations } from "@/lib/hooks/useDeviceMutations";

interface Props {
  mac: string;
  currentGroups: Array<{ id: string; name: string }>;
  onError?: (msg: string) => void;
}

// WARP-85: renders the "+ Add to group" chip inside the device detail panel.
// Typing filters existing groups (excluding ones the device is already in);
// if no exact match, offers a "Create" shortcut that POSTs /api/network/groups
// and then assigns the device to the newly created group in a single flow.
export function GroupTypeahead({ mac, currentGroups, onError }: Props) {
  const { data } = useNetworkGroups();
  const { createGroup, groupToastForError } = useGroupMutations();
  const { assignGroups, toastForError } = useDeviceMutations();
  const [input, setInput] = useState("");

  const currentIds = new Set(currentGroups.map((g) => g.id));
  const q = input.trim().toLowerCase();
  const allGroups = data?.groups ?? [];
  const candidates = allGroups.filter(
    (g) => !currentIds.has(g.id) && (!q || g.name.toLowerCase().includes(q)),
  );
  const exactMatch = allGroups.find((g) => g.name.toLowerCase() === q);
  const showCreate = q.length > 0 && !exactMatch;

  async function handlePick(groupId: string) {
    try {
      await assignGroups(mac, [...currentGroups.map((g) => g.id), groupId]);
      setInput("");
    } catch (err) {
      if (onError) onError(toastForError(err));
    }
  }

  async function handleCreateAndPick() {
    const name = input.trim();
    if (!name) return;
    try {
      const created = await createGroup(name);
      await assignGroups(mac, [...currentGroups.map((g) => g.id), created.id]);
      setInput("");
    } catch (err) {
      if (onError) onError(groupToastForError(err));
    }
  }

  return (
    <div className="relative inline-block">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="+ Add to group"
        aria-label="Add to group"
        className="type-caption-1 px-2 py-0.5 rounded-full border border-dashed border-separator bg-transparent text-label-secondary outline-none focus:border-accent"
      />
      {input && (candidates.length > 0 || showCreate) && (
        <ul
          role="listbox"
          className="absolute left-0 top-full mt-1 bg-surface-primary border border-separator rounded shadow z-10 min-w-[12rem]"
        >
          {candidates.map((g) => (
            <li key={g.id} role="option" aria-selected="false">
              <button
                type="button"
                onClick={() => void handlePick(g.id)}
                className="w-full text-left px-3 py-1.5 hover:bg-surface-secondary type-caption-1 text-label-primary"
              >
                {g.name}
              </button>
            </li>
          ))}
          {showCreate && (
            <li role="option" aria-selected="false">
              <button
                type="button"
                onClick={() => void handleCreateAndPick()}
                className="w-full text-left px-3 py-1.5 hover:bg-surface-secondary type-caption-1 text-accent"
              >
                Create &ldquo;{input.trim()}&rdquo;
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
