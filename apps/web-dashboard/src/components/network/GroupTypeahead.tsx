"use client";
import { useEffect, useState } from "react";
import type React from "react";
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
// Keyboard support (a11y): ArrowDown/ArrowUp cycles the highlight across
// existing options and the Create slot, Enter picks the highlighted item,
// Escape clears the input+highlight. The input advertises the active option
// via aria-activedescendant so screen readers track the highlight.
export function GroupTypeahead({ mac, currentGroups, onError }: Props) {
  const { data } = useNetworkGroups();
  const { createGroup, groupToastForError } = useGroupMutations();
  const { assignGroups, toastForError } = useDeviceMutations();
  const [input, setInput] = useState("");
  const [highlighted, setHighlighted] = useState<number | null>(null);

  const currentIds = new Set(currentGroups.map((g) => g.id));
  const q = input.trim().toLowerCase();
  const allGroups = data?.groups ?? [];
  const candidates = allGroups.filter(
    (g) => !currentIds.has(g.id) && (!q || g.name.toLowerCase().includes(q)),
  );
  const exactMatch = allGroups.find((g) => g.name.toLowerCase() === q);
  const showCreate = q.length > 0 && !exactMatch;

  type Item =
    | { kind: "pick"; group: { id: string; name: string }; idx: number }
    | { kind: "create"; idx: number };
  const items: Item[] = [
    ...candidates.map<Item>((g, i) => ({ kind: "pick", group: g, idx: i })),
    ...(showCreate ? [{ kind: "create" as const, idx: candidates.length }] : []),
  ];

  // Reset the highlight whenever the query changes — the old index may now
  // point at a completely different row after filtering.
  useEffect(() => {
    setHighlighted(null);
  }, [input]);

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

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setInput("");
      setHighlighted(null);
      return;
    }
    if (items.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlighted((h) => (h === null ? 0 : (h + 1) % items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlighted((h) =>
        h === null ? items.length - 1 : (h - 1 + items.length) % items.length,
      );
    } else if (e.key === "Enter") {
      if (highlighted === null) return;
      e.preventDefault();
      const item = items[highlighted];
      if (item.kind === "pick") void handlePick(item.group.id);
      else void handleCreateAndPick();
    }
  }

  const showList = Boolean(input) && items.length > 0;

  return (
    <div className="relative inline-block">
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKey}
        placeholder="+ Add to group"
        aria-label="Add to group"
        aria-autocomplete="list"
        aria-controls="gt-listbox"
        aria-activedescendant={
          highlighted !== null ? `gt-opt-${highlighted}` : undefined
        }
        className="type-caption-1 px-2 py-0.5 rounded-full border border-dashed border-[var(--card-bd)] bg-transparent text-[color:var(--text-muted)] outline-none focus:border-[var(--brand)]"
      />
      {showList && (
        <ul
          id="gt-listbox"
          role="listbox"
          className="card absolute left-0 top-full mt-1 z-10 min-w-[12rem]"
          style={{
            padding: "4px 0",
            background: "var(--glass)",
            backdropFilter: "blur(20px) saturate(150%)",
            WebkitBackdropFilter: "blur(20px) saturate(150%)",
            border: "1px solid var(--card-bd)",
            borderRadius: "var(--radius-card)",
            boxShadow: "var(--lift)",
          }}
        >
          {items.map((item) =>
            item.kind === "pick" ? (
              <li
                key={item.group.id}
                role="option"
                aria-selected={highlighted === item.idx}
                id={`gt-opt-${item.idx}`}
                className={highlighted === item.idx ? "bg-[var(--hover)]" : ""}
              >
                <button
                  type="button"
                  onClick={() => void handlePick(item.group.id)}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--hover)] type-caption-1 text-[color:var(--text)]"
                >
                  {item.group.name}
                </button>
              </li>
            ) : (
              <li
                key="create"
                role="option"
                aria-selected={highlighted === item.idx}
                id={`gt-opt-${item.idx}`}
                className={highlighted === item.idx ? "bg-[var(--hover)]" : ""}
              >
                <button
                  type="button"
                  onClick={() => void handleCreateAndPick()}
                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--hover)] type-caption-1 text-[color:var(--brand)]"
                >
                  Create &ldquo;{input.trim()}&rdquo;
                </button>
              </li>
            ),
          )}
        </ul>
      )}
    </div>
  );
}
