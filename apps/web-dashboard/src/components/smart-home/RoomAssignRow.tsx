"use client";

import { useState } from "react";
import { Check, Plus, ChevronDown } from "lucide-react";
import type { MatterDevice, Room } from "@/lib/types";
import { RoomGlyph } from "./RoomGlyph";
import { RoomModal } from "./RoomModal";

/**
 * WARP-1396 §5.3 — the detail-panel Room row: the device's current room as a
 * chip, tapping opens a picker (radio list of rooms + "New room" creator +
 * "No room"). Selection applies instantly (the alias upsert), the picker
 * closes, and the parent revalidates.
 */
interface RoomAssignRowProps {
  device: MatterDevice;
  rooms: Room[];
  onSetAlias: (
    nodeId: string,
    patch: { name?: string | null; roomId?: string | null },
  ) => Promise<unknown>;
  onCreateRoom?: (name: string, icon: string) => Promise<Room>;
}

export function RoomAssignRow({ device, rooms, onSetAlias, onCreateRoom }: RoomAssignRowProps) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const current = rooms.find((r) => r.id === device.roomId) ?? null;

  async function assign(roomId: string | null) {
    setOpen(false);
    await onSetAlias(device.nodeId, { roomId });
  }

  return (
    <div className="px-5 py-3 relative" style={{ borderBottom: "1px solid var(--card-bd)" }}>
      <div className="flex items-center justify-between gap-3">
        <span className="type-subheadline" style={{ color: "var(--text)" }}>
          Room
        </span>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 type-caption-1 px-2.5 py-1.5 rounded-lg
            bg-[var(--card-inner)] text-[var(--text)] hover:bg-[var(--hover)]
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        >
          {current ? (
            <>
              <RoomGlyph icon={current.icon} size={14} />
              {current.name}
            </>
          ) : (
            <span style={{ color: "var(--text-muted)" }}>No room</span>
          )}
          <ChevronDown size={14} style={{ color: "var(--text-muted)" }} />
        </button>
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="listbox"
            aria-label="Assign room"
            className="absolute right-5 z-20 mt-1 min-w-[220px] max-h-[60vh] overflow-y-auto py-1 rounded-lg shadow-lg"
            style={{ background: "var(--card)", border: "1px solid var(--card-bd)" }}
          >
            {rooms.map((r) => {
              const on = r.id === device.roomId;
              return (
                <button
                  key={r.id}
                  role="option"
                  aria-selected={on}
                  type="button"
                  onClick={() => void assign(r.id)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 type-subheadline text-left
                    text-[var(--text)] hover:bg-[var(--hover)]"
                >
                  <RoomGlyph icon={r.icon} size={15} />
                  <span className="flex-1 truncate">{r.name}</span>
                  {on && <Check size={15} style={{ color: "var(--brand)" }} />}
                </button>
              );
            })}

            {onCreateRoom && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setCreating(true);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 type-subheadline text-left
                  text-[var(--brand)] hover:bg-[var(--hover)]"
              >
                <Plus size={15} /> New room
              </button>
            )}

            <div className="my-1 h-px" style={{ background: "var(--card-bd)" }} />
            <button
              role="option"
              aria-selected={!device.roomId}
              type="button"
              onClick={() => void assign(null)}
              className="w-full flex items-center gap-2.5 px-3 py-2 type-subheadline text-left
                text-[var(--text-muted)] hover:bg-[var(--hover)]"
            >
              <span className="flex-1">No room</span>
              {!device.roomId && <Check size={15} style={{ color: "var(--brand)" }} />}
            </button>
          </div>
        </>
      )}

      {creating && onCreateRoom && (
        <RoomModal
          room={null}
          onSave={async (name, icon) => {
            const room = await onCreateRoom(name, icon);
            await onSetAlias(device.nodeId, { roomId: room.id });
          }}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}
