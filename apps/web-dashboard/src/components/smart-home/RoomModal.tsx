"use client";

import { useId, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { RoomGlyph } from "./RoomGlyph";
import { ROOM_GLYPHS, SUGGESTED_ROOMS } from "./rooms-model";
import type { Room } from "@/lib/types";

/**
 * WARP-1396 §5.4 — create or rename a room: a name (1–32 speakable chars) and
 * a glyph from the fixed 12-icon set. Six suggested names as one-tap chips on
 * create. No colors, no photos — glyph + name only.
 */
interface RoomModalProps {
  /** Existing room to rename, or null to create. */
  room: Room | null;
  onSave: (name: string, icon: string) => Promise<unknown>;
  onClose: () => void;
}

export function RoomModal({ room, onSave, onClose }: RoomModalProps) {
  const headingId = useId();
  const [name, setName] = useState(room?.name ?? "");
  const [icon, setIcon] = useState(room?.icon ?? "home");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const canSave = trimmed.length > 0 && trimmed.length <= 32 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed, icon);
      onClose();
    } catch {
      setError("That didn’t save — your changes are still here. Try again.");
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} labelledBy={headingId} placement="center">
      <div className="p-5 space-y-4" style={{ minWidth: 320 }}>
        <h2 id={headingId} className="type-title-3" style={{ color: "var(--text)" }}>
          {room ? "Rename room" : "New room"}
        </h2>

        {!room && (
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested names">
            {SUGGESTED_ROOMS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => {
                  setName(n);
                  const g = ROOM_GLYPHS.find((x) => x.suggests === n);
                  if (g) setIcon(g.icon);
                }}
                className="type-caption-1 px-2.5 py-1 rounded-full transition-colors
                  bg-[var(--card-inner)] text-[var(--text-muted)] hover:bg-[var(--hover)]
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
              >
                {n}
              </button>
            ))}
          </div>
        )}

        <div>
          <label className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
            Room name
          </label>
          <input
            autoFocus
            value={name}
            maxLength={64}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && void handleSave()}
            className="w-full rounded-lg px-3 py-2 type-body bg-[var(--card-inner)]
              text-[var(--text)] border border-[var(--card-bd)]
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          />
          <p className="type-caption-1 mt-1.5" style={{ color: "var(--text-muted)" }}>
            This is also the name you’ll use when you ask Droplet out loud.
          </p>
        </div>

        <div>
          <span className="type-caption-1 mb-1.5 block" style={{ color: "var(--text-muted)" }}>
            Icon
          </span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Room icon">
            {ROOM_GLYPHS.map((g) => {
              const on = g.icon === icon;
              return (
                <button
                  key={g.icon}
                  type="button"
                  aria-label={g.suggests}
                  aria-pressed={on}
                  onClick={() => setIcon(g.icon)}
                  className={`w-9 h-9 rounded-lg flex items-center justify-center transition-colors
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] ${
                      on
                        ? "bg-[var(--brand-subtle)] text-[var(--brand)]"
                        : "bg-[var(--card-inner)] text-[var(--text-muted)] hover:bg-[var(--hover)]"
                    }`}
                >
                  <RoomGlyph icon={g.icon} size={18} />
                </button>
              );
            })}
          </div>
        </div>

        {error && (
          <p
            role="alert"
            className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="type-subheadline px-4 py-2 rounded-lg text-[var(--text-muted)]
              hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2
              focus-visible:ring-[var(--brand)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void handleSave()}
            className="type-subheadline px-4 py-2 rounded-lg bg-[var(--brand)] text-white
              disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--brand-hover)]
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
          >
            {room ? "Save" : "Create room"}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
