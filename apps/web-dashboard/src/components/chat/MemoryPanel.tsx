"use client";

/**
 * WARP-461 — Memory panel (the surface routes/memory.ts has promised
 * since Phase B4). Lists the workspace's durable memory facts with an
 * active toggle, delete ("Forget"), and an add row. Facts marked active
 * are injected into every chat turn's base system prompt, so this panel
 * is the user's window into — and control over — what the assistant
 * remembers.
 *
 * Memory is WORKSPACE-global (not per-conversation), so the panel is
 * always available from the chat header.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, Plus, Trash2 } from "lucide-react";
import {
  createMemoryFact,
  deleteMemoryFact,
  listMemoryFacts,
  updateMemoryFact,
  type MemoryFact,
} from "@/lib/api";

const CATEGORIES: MemoryFact["category"][] = [
  "Tone",
  "Workflow",
  "Scope",
  "Schedule",
  "Other",
];

export function MemoryPanel() {
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState<MemoryFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<MemoryFact["category"]>("Other");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { facts } = await listMemoryFacts();
      setFacts(facts);
    } catch (err) {
      setError((err as Error).message);
      setFacts([]);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Light dismiss on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const handleToggle = async (fact: MemoryFact) => {
    setError(null);
    try {
      const { fact: updated } = await updateMemoryFact(fact.id, {
        active: !fact.active,
      });
      setFacts((prev) =>
        (prev ?? []).map((f) => (f.id === fact.id ? updated : f)),
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleDelete = async (fact: MemoryFact) => {
    setError(null);
    try {
      await deleteMemoryFact(fact.id);
      setFacts((prev) => (prev ?? []).filter((f) => f.id !== fact.id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleAdd = async () => {
    const trimmed = draft.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { fact } = await createMemoryFact({ category, fact: trimmed });
      setFacts((prev) => [fact, ...(prev ?? [])]);
      setDraft("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="What the assistant remembers"
        className={`p-1.5 rounded-sm transition-colors ${
          open
            ? "text-accent bg-accent-subtle"
            : "text-label-tertiary hover:text-label-primary hover:bg-surface-secondary"
        }`}
      >
        <Brain size={16} aria-hidden="true" />
        <span className="sr-only">Memory</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Assistant memory"
          className="absolute right-0 mt-1 w-96 max-w-[90vw] z-20 bg-surface-elevated dp-material rounded-lg shadow-lg border border-separator p-3"
        >
          <div className="type-caption-1 text-label-tertiary uppercase tracking-wider mb-2">
            Assistant memory
          </div>

          {facts === null ? (
            <div className="type-footnote text-label-tertiary py-2">Loading…</div>
          ) : facts.length === 0 ? (
            <div className="type-footnote text-label-tertiary py-2">
              Nothing saved yet. Add a fact below, or ask the assistant to
              remember something — it will ask for your approval first.
            </div>
          ) : (
            <ul className="space-y-1 mb-2 max-h-72 overflow-y-auto">
              {facts.map((fact) => (
                <li
                  key={fact.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-surface-secondary"
                >
                  <span className="flex-none inline-flex h-5 px-1.5 items-center rounded-full type-caption-2 font-medium bg-accent-subtle text-accent">
                    {fact.category}
                  </span>
                  <span
                    className={`type-footnote truncate flex-1 ${
                      fact.active
                        ? "text-label-primary"
                        : "text-label-quaternary line-through"
                    }`}
                    title={fact.fact}
                  >
                    {fact.fact}
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={fact.active}
                    aria-label={`Active: ${fact.fact}`}
                    onClick={() => void handleToggle(fact)}
                    className={`flex-none w-7 h-4 rounded-full transition-colors relative ${
                      fact.active ? "bg-accent" : "bg-surface-tertiary"
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform ${
                        fact.active ? "translate-x-3.5" : "translate-x-0.5"
                      }`}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(fact)}
                    aria-label={`Forget: ${fact.fact}`}
                    className="flex-none p-1 rounded-sm text-label-tertiary hover:text-system-red hover:bg-system-red/10"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-1.5 pt-2 border-t border-separator">
            <label className="sr-only" htmlFor="memory-category">
              Category
            </label>
            <select
              id="memory-category"
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as MemoryFact["category"])
              }
              className="dp-input type-footnote h-8 w-28 flex-none"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="memory-draft">
              New fact
            </label>
            <input
              id="memory-draft"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAdd();
              }}
              placeholder="e.g. Prefers answers in French"
              className="dp-input type-footnote h-8 flex-1 min-w-0"
            />
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={busy || draft.trim().length === 0}
              className="flex-none inline-flex items-center gap-1 h-8 px-2.5 rounded-md type-footnote text-accent hover:bg-accent-subtle disabled:text-label-quaternary disabled:cursor-not-allowed transition-colors"
            >
              <Plus size={14} aria-hidden="true" /> Add
            </button>
          </div>

          {error && (
            <div className="mt-2 type-caption-1 text-system-red" role="alert">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
