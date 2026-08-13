"use client";

import { useEffect, useState } from "react";
import { Check, MapPin, Pencil, Plus, Trash2, X } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useAuth } from "@/lib/auth";
import {
  createWorkspaceLocation,
  deleteWorkspaceLocation,
  fetchWorkspaceLocations,
  updateWorkspaceLocation,
  type WorkspaceLocation,
} from "@/lib/api";

/**
 * WARP-1906 — Settings → "Locations": the premade buildings + named
 * conference rooms this workspace offers as suggestions in the event form's
 * Location field (they rank ahead of the map lookup there).
 *
 * The smallest honest admin surface: a flat list of "Building - Room" rows
 * with inline rename + remove, and a two-field add row. No optimistic
 * writes — each mutation resolves before the list changes, and a failed add
 * keeps the typed values with the error line (§7.9: never lose edits).
 *
 * Renders nothing for family/guest — Settings is an admin surface (§6.3).
 * Indigo shell tokens only (dp-card / type-* / text-label-* / --brand),
 * mirroring BusinessProfileCard.
 */

const SAVE_ERROR_LINE =
  "That didn’t save — your entries are still here. Try again.";
const REMOVE_ERROR_LINE = "That didn’t remove the location. Try again.";

function sortRows(rows: WorkspaceLocation[]): WorkspaceLocation[] {
  return [...rows].sort(
    (a, b) =>
      a.building.localeCompare(b.building) || a.room.localeCompare(b.room),
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-input)",
  color: "var(--text)",
};

const inputClass =
  "w-full px-3 py-2 type-footnote focus:outline-none focus:ring-2 focus:ring-[var(--brand)] placeholder:text-[var(--text-faint)] transition-shadow";

export function LocationsCard() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = user?.role === "owner" || user?.role === "admin";

  const [rows, setRows] = useState<WorkspaceLocation[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Add form.
  const [addBuilding, setAddBuilding] = useState("");
  const [addRoom, setAddRoom] = useState("");
  const [adding, setAdding] = useState(false);

  // Inline rename.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBuilding, setEditBuilding] = useState("");
  const [editRoom, setEditRoom] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchWorkspaceLocations();
        if (!cancelled) setRows(sortRows(list));
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  if (!isAdmin) return null;

  async function handleAdd() {
    const building = addBuilding.trim();
    const room = addRoom.trim();
    if (!building || !room || adding) return;
    setError(null);
    setAdding(true);
    try {
      const created = await createWorkspaceLocation({ building, room });
      setRows((cur) => sortRows([...(cur ?? []), created]));
      setAddBuilding("");
      setAddRoom("");
      toast("Location added", "success");
    } catch {
      // Never lose edits — the typed values stay in the inputs.
      setError(SAVE_ERROR_LINE);
    } finally {
      setAdding(false);
    }
  }

  function startEdit(row: WorkspaceLocation) {
    setError(null);
    setEditingId(row.id);
    setEditBuilding(row.building);
    setEditRoom(row.room);
  }

  async function handleSaveEdit() {
    const building = editBuilding.trim();
    const room = editRoom.trim();
    if (!editingId || !building || !room || savingEdit) return;
    setError(null);
    setSavingEdit(true);
    try {
      const updated = await updateWorkspaceLocation(editingId, {
        building,
        room,
      });
      setRows((cur) =>
        sortRows((cur ?? []).map((r) => (r.id === updated.id ? updated : r))),
      );
      setEditingId(null);
      toast("Location updated", "success");
    } catch {
      setError(SAVE_ERROR_LINE);
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleRemove(row: WorkspaceLocation) {
    if (removingId) return;
    setError(null);
    setRemovingId(row.id);
    try {
      await deleteWorkspaceLocation(row.id);
      setRows((cur) => (cur ?? []).filter((r) => r.id !== row.id));
      toast("Location removed", "success");
    } catch {
      setError(REMOVE_ERROR_LINE);
    } finally {
      setRemovingId(null);
    }
  }

  const addDisabled = !addBuilding.trim() || !addRoom.trim() || adding;

  return (
    <div className="dp-card !p-5 space-y-4" data-testid="locations-card">
      <div className="flex items-start gap-2.5">
        <MapPin size={18} className="text-label-secondary mt-0.5" aria-hidden />
        <div>
          <p className="type-headline" style={{ color: "var(--text)" }}>
            Locations
          </p>
          <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
            Buildings and conference rooms suggested in the event Location
            field.
          </p>
        </div>
      </div>

      {loadFailed ? (
        <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
          Couldn’t load locations — refresh to try again.
        </p>
      ) : rows === null ? null : (
        <>
          {rows.length === 0 ? (
            <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
              No locations yet. Add a building and a room to suggest them when
              someone schedules an event.
            </p>
          ) : (
            <ul className="space-y-1">
              {rows.map((row) =>
                editingId === row.id ? (
                  <li key={row.id} className="flex items-center gap-2 py-1">
                    <input
                      type="text"
                      aria-label="Edit building"
                      value={editBuilding}
                      maxLength={120}
                      onChange={(e) => {
                        setEditBuilding(e.target.value);
                        setError(null);
                      }}
                      className={inputClass}
                      style={inputStyle}
                    />
                    <input
                      type="text"
                      aria-label="Edit room"
                      value={editRoom}
                      maxLength={120}
                      onChange={(e) => {
                        setEditRoom(e.target.value);
                        setError(null);
                      }}
                      className={inputClass}
                      style={inputStyle}
                    />
                    <button
                      type="button"
                      onClick={() => void handleSaveEdit()}
                      disabled={
                        !editBuilding.trim() || !editRoom.trim() || savingEdit
                      }
                      aria-label="Save"
                      className="p-2 rounded-md text-accent hover:bg-accent-subtle transition-colors duration-200 ease-smooth disabled:opacity-40"
                    >
                      <Check size={16} aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel"
                      className="p-2 rounded-md transition-colors duration-200 ease-smooth hover:bg-[var(--hover)]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <X size={16} aria-hidden />
                    </button>
                  </li>
                ) : (
                  <li
                    key={row.id}
                    className="flex items-center gap-2 py-1 group"
                  >
                    <span
                      className="type-subheadline flex-1 min-w-0 truncate"
                      style={{ color: "var(--text)" }}
                    >
                      {row.label}
                    </span>
                    <button
                      type="button"
                      onClick={() => startEdit(row)}
                      disabled={removingId === row.id}
                      aria-label={`Edit ${row.label}`}
                      className="p-2 rounded-md transition-colors duration-200 ease-smooth hover:bg-[var(--hover)]"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <Pencil size={15} aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleRemove(row)}
                      disabled={removingId === row.id}
                      aria-label={`Remove ${row.label}`}
                      className="p-2 rounded-md transition-colors duration-200 ease-smooth hover:bg-system-red/10 hover:text-system-red disabled:opacity-40"
                      style={{ color: "var(--text-muted)" }}
                    >
                      <Trash2 size={15} aria-hidden />
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}

          {error && (
            <p
              role="alert"
              className="type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2"
            >
              {error}
            </p>
          )}

          {/* Add row */}
          <div
            className="flex flex-col sm:flex-row sm:items-end gap-2 pt-3"
            style={{ borderTop: "1px solid var(--card-bd)" }}
          >
            <div className="flex-1 min-w-0">
              <label
                htmlFor="location-building"
                className="block type-caption-1 mb-1"
                style={{ color: "var(--text-muted)" }}
              >
                Building
              </label>
              <input
                id="location-building"
                type="text"
                value={addBuilding}
                maxLength={120}
                placeholder="HQ"
                onChange={(e) => {
                  setAddBuilding(e.target.value);
                  setError(null);
                }}
                className={inputClass}
                style={inputStyle}
              />
            </div>
            <div className="flex-1 min-w-0">
              <label
                htmlFor="location-room"
                className="block type-caption-1 mb-1"
                style={{ color: "var(--text-muted)" }}
              >
                Room
              </label>
              <input
                id="location-room"
                type="text"
                value={addRoom}
                maxLength={120}
                placeholder="Room Aurora"
                onChange={(e) => {
                  setAddRoom(e.target.value);
                  setError(null);
                }}
                className={inputClass}
                style={inputStyle}
              />
            </div>
            <button
              type="button"
              onClick={() => void handleAdd()}
              disabled={addDisabled}
              className="btn primary type-subheadline !min-h-[40px] whitespace-nowrap inline-flex items-center gap-1.5"
            >
              <Plus size={15} aria-hidden />
              {adding ? "Adding…" : "Add location"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
