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
import { useAuth } from "@/lib/auth";

const CATEGORIES: MemoryFact["category"][] = [
  "Tone",
  "Workflow",
  "Scope",
  "Schedule",
  "Other",
  // WARP-1120 (D-9) — business-knowledge facts from the onboarding interview.
  "Business",
];

/** WARP-845 — distribution ladder, widest reach last. The label says who
 *  RECEIVES the fact in their chats. */
const AUDIENCES: { value: MemoryFact["audience"]; label: string }[] = [
  { value: "owner", label: "Owners" },
  { value: "admin", label: "Admins+" },
  { value: "family", label: "Team" },
  { value: "guest", label: "Everyone" },
];

/** Mirrors the server's roleRank/canTargetAudience ladder so the select
 *  never offers an audience the API would 403 (`audience_above_role`).
 *  Unknown role falls back to the family view. */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  family: 1,
  guest: 0,
};
const AUDIENCE_RANK: Record<MemoryFact["audience"], number> = {
  owner: 3,
  admin: 2,
  family: 1,
  guest: 0,
};
function audienceOptionsForRole(role: string | undefined) {
  const rank = ROLE_RANK[role ?? ""] ?? 1;
  return AUDIENCES.filter((a) => AUDIENCE_RANK[a.value] <= rank);
}

function friendlyMemoryError(err: unknown): string {
  const msg = (err as Error).message ?? String(err);
  return msg.includes("audience_above_role")
    ? "You can't target an audience above your own role."
    : msg;
}

export function MemoryPanel() {
  const [open, setOpen] = useState(false);
  const [facts, setFacts] = useState<MemoryFact[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<MemoryFact["category"]>("Other");
  const [audience, setAudience] = useState<MemoryFact["audience"]>("family");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const { user } = useAuth();
  const audienceOptions = audienceOptionsForRole(user?.role);

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

  const handleAudience = async (
    fact: MemoryFact,
    next: MemoryFact["audience"],
  ) => {
    setError(null);
    try {
      const { fact: updated } = await updateMemoryFact(fact.id, {
        audience: next,
      });
      setFacts((prev) =>
        (prev ?? []).map((f) => (f.id === fact.id ? updated : f)),
      );
    } catch (err) {
      setError(friendlyMemoryError(err));
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
      const { fact } = await createMemoryFact({
        category,
        fact: trimmed,
        audience,
      });
      setFacts((prev) => [fact, ...(prev ?? [])]);
      setDraft("");
    } catch (err) {
      setError(friendlyMemoryError(err));
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
        className={`p-1.5 rounded-sm max-lg:inline-flex max-lg:items-center max-lg:justify-center max-lg:h-11 max-lg:w-11 transition-colors ${
          open
            ? "text-[var(--brand)] bg-[var(--brand-subtle)]"
            : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]"
        }`}
      >
        <Brain size={16} aria-hidden="true" />
        <span className="sr-only">Memory</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Assistant memory"
          className="absolute right-0 mt-1 w-96 max-w-[90vw] z-20 rounded-2xl p-3 backdrop-blur-xl backdrop-saturate-150"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--card-bd)",
            boxShadow: "var(--lift)",
          }}
        >
          <div className="type-caption-1 mb-2" style={{ color: "var(--text-muted)" }}>
            Assistant Memory
          </div>

          {facts === null ? (
            <div className="type-footnote py-2" style={{ color: "var(--text-muted)" }}>Loading…</div>
          ) : facts.length === 0 ? (
            <div className="type-footnote py-2" style={{ color: "var(--text-muted)" }}>
              Nothing saved yet. Add a fact below, or ask the assistant to
              remember something — it will ask for your approval first.
            </div>
          ) : (
            <ul className="space-y-1 mb-2 max-h-72 overflow-y-auto">
              {facts.map((fact) => (
                <li
                  key={fact.id}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md"
                  style={{ background: "var(--card-inner)" }}
                >
                  <span
                    className="flex-none inline-flex h-5 px-1.5 items-center rounded-full type-caption-2 font-medium"
                    style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
                  >
                    {fact.category}
                  </span>
                  <span
                    className="type-footnote truncate flex-1"
                    style={{
                      color: fact.active ? "var(--text)" : "var(--text-faint)",
                      textDecoration: fact.active ? "none" : "line-through",
                    }}
                    title={fact.fact}
                  >
                    {fact.fact}
                  </span>
                  <label className="sr-only" htmlFor={`audience-${fact.id}`}>
                    Audience
                  </label>
                  <select
                    id={`audience-${fact.id}`}
                    value={fact.audience}
                    onChange={(e) =>
                      void handleAudience(
                        fact,
                        e.target.value as MemoryFact["audience"],
                      )
                    }
                    title="Who receives this fact"
                    className="type-caption-2 h-6 w-24 flex-none rounded-[var(--radius-input)] outline-none bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] focus:border-[var(--brand)]"
                  >
                    {/* If the fact's current audience outranks the caller
                        (e.g. an admin viewing an owner-only fact), keep it
                        visible as a disabled option so the select doesn't
                        render blank. */}
                    {!audienceOptions.some((a) => a.value === fact.audience) && (
                      <option value={fact.audience} disabled>
                        {AUDIENCES.find((a) => a.value === fact.audience)
                          ?.label ?? fact.audience}
                      </option>
                    )}
                    {audienceOptions.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={fact.active}
                    aria-label={`Active: ${fact.fact}`}
                    onClick={() => void handleToggle(fact)}
                    className="flex-none w-7 h-4 rounded-full transition-colors relative"
                    style={{ background: fact.active ? "var(--brand)" : "var(--inset)" }}
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
                    className="flex-none p-1 rounded-sm text-[var(--text-muted)] hover:text-system-red hover:bg-system-red/10"
                  >
                    <Trash2 size={12} aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div
            className="flex items-center gap-1.5 pt-2"
            style={{ borderTop: "1px solid var(--card-bd)" }}
          >
            <label className="sr-only" htmlFor="memory-category">
              Category
            </label>
            <select
              id="memory-category"
              value={category}
              onChange={(e) =>
                setCategory(e.target.value as MemoryFact["category"])
              }
              className="type-footnote h-8 w-28 flex-none rounded-[var(--radius-input)] outline-none bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] focus:border-[var(--brand)]"
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="memory-audience">
              Audience
            </label>
            <select
              id="memory-audience"
              value={audience}
              onChange={(e) =>
                setAudience(e.target.value as MemoryFact["audience"])
              }
              title="Who receives this fact"
              className="type-footnote h-8 w-28 flex-none rounded-[var(--radius-input)] outline-none bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] focus:border-[var(--brand)]"
            >
              {audienceOptions.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
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
              className="type-footnote h-8 flex-1 min-w-0 rounded-[var(--radius-input)] outline-none bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--brand)]"
            />
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={busy || draft.trim().length === 0}
              className="flex-none inline-flex items-center gap-1 h-8 px-2.5 rounded-md type-footnote transition-colors text-[var(--brand)] hover:bg-[var(--brand-subtle)] disabled:text-[var(--text-faint)] disabled:cursor-not-allowed"
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
