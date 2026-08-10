"use client";

/**
 * WARP-460 — "Context" popover for the chat header (FEATURES.md §2.2.7's
 * "Context · N sources"). Lists the session's pins, adds new ones, and
 * removes stale ones against /api/llm/:sessionId/pins. The orchestrator
 * already injects every pin into the system prompt on each turn — this
 * is the missing management surface, not new behavior.
 *
 * Pins are PER-SESSION, so the page only renders this once a
 * conversationId exists (the first turn mints one).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, File, Folder, Mail, Pin, Plus, X } from "lucide-react";
import {
  createContextPin,
  deleteContextPin,
  listContextPins,
  type ContextPin,
} from "@/lib/api";

const KIND_ICON: Record<ContextPin["kind"], typeof Folder> = {
  folder: Folder,
  file: File,
  email_thread: Mail,
  camera: Camera,
  camera_window: Camera,
};

/** Kinds the popover lets the user add by hand. Email threads and camera
 *  windows are pinned from their own surfaces (mail view / camera grid)
 *  where the refs are picked, not typed. */
const ADDABLE_KINDS: ContextPin["kind"][] = ["folder", "file", "camera"];

export function ContextPinsPopover({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [pins, setPins] = useState<ContextPin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<ContextPin["kind"]>("folder");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { pins } = await listContextPins(sessionId);
      setPins(pins);
    } catch (err) {
      setError((err as Error).message);
      setPins([]);
    }
  }, [sessionId]);

  // Lazy-load on first open (and re-fetch on every open so pins added
  // elsewhere — e.g. a future camera-grid pin action — show up).
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

  const handleAdd = async () => {
    const trimmed = ref.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { pin } = await createContextPin(sessionId, { kind, ref: trimmed });
      setPins((prev) => [...(prev ?? []), pin]);
      setRef("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (pin: ContextPin) => {
    setError(null);
    try {
      await deleteContextPin(sessionId, pin.id);
      setPins((prev) => (prev ?? []).filter((p) => p.id !== pin.id));
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Pinned context for this conversation"
        className={`p-1.5 rounded-sm max-lg:inline-flex max-lg:items-center max-lg:justify-center max-lg:h-11 max-lg:w-11 transition-colors ${
          open
            ? "text-[var(--brand)] bg-[var(--brand-subtle)]"
            : "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]"
        }`}
      >
        <Pin size={16} aria-hidden="true" />
        <span className="sr-only">Context</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Pinned context"
          className="absolute right-0 mt-1 w-80 max-w-[85vw] z-20 rounded-2xl p-3 backdrop-blur-xl backdrop-saturate-150"
          style={{
            background: "var(--glass)",
            border: "1px solid var(--card-bd)",
            boxShadow: "var(--lift)",
          }}
        >
          <div className="type-caption-1 mb-2" style={{ color: "var(--text-muted)" }}>
            Context For This Conversation
          </div>

          {pins === null ? (
            <div className="type-footnote py-2" style={{ color: "var(--text-muted)" }}>Loading…</div>
          ) : pins.length === 0 ? (
            <div className="type-footnote py-2" style={{ color: "var(--text-muted)" }}>
              No pinned context yet. Pin a folder or file and the assistant
              will prefer it when searching your documents.
            </div>
          ) : (
            <ul className="space-y-1 mb-2">
              {pins.map((pin) => {
                const Icon = KIND_ICON[pin.kind] ?? Folder;
                return (
                  <li
                    key={pin.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md"
                    style={{ background: "var(--card-inner)" }}
                  >
                    <Icon
                      size={14}
                      aria-hidden="true"
                      className="flex-none text-[var(--text-muted)]"
                    />
                    <span className="type-footnote truncate flex-1 text-[var(--text)]">
                      {pin.ref}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleRemove(pin)}
                      aria-label={`Remove ${pin.ref}`}
                      className="flex-none p-1 rounded-sm text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--hover)]"
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          <div
            className="flex items-center gap-1.5 pt-2"
            style={{ borderTop: "1px solid var(--card-bd)" }}
          >
            <label className="sr-only" htmlFor="pin-kind">
              Kind
            </label>
            <select
              id="pin-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as ContextPin["kind"])}
              className="type-footnote h-8 w-24 flex-none rounded-[var(--radius-input)] outline-none bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] focus:border-[var(--brand)]"
            >
              {ADDABLE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <label className="sr-only" htmlFor="pin-ref">
              Path or reference
            </label>
            <input
              id="pin-ref"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleAdd();
              }}
              placeholder="/share/projects/…"
              className="type-footnote h-8 flex-1 min-w-0 rounded-[var(--radius-input)] outline-none bg-[var(--surface)] border border-[var(--border)] text-[var(--text)] placeholder:text-[var(--text-muted)] focus:border-[var(--brand)]"
            />
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={busy || ref.trim().length === 0}
              aria-label="Add pin"
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
