"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Car,
  Check,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import {
  deleteKnownPlate,
  fetchKnownPlates,
  nameKnownPlate,
} from "@/lib/api";
import type { KnownPlate } from "@/lib/types";

/**
 * License plate management (Phase 7.6).
 *
 * Lists every plate Frigate's LPR has read off events, with a per-row
 * "name this plate" affordance so the operator can tag them
 * ("ABC-1234 → Alice's Civic"). Tagged plates show their owner-name in
 * notifications and event descriptions.
 *
 * Frigate's LPR feature must be enabled. Without it, /api/cameras/plates
 * returns []; we surface that as a hint.
 */
export default function PlatesPage() {
  const router = useRouter();
  const [plates, setPlates] = useState<KnownPlate[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setPlates(await fetchKnownPlates());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load plates");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const startEdit = (plate: KnownPlate) => {
    setEditing(plate.plate);
    setEditValue(plate.name ?? "");
  };

  const commitEdit = async () => {
    if (!editing) return;
    const trimmed = editValue.trim();
    if (!trimmed) return;
    setBusy(editing);
    try {
      await nameKnownPlate(editing, trimmed);
      setEditing(null);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (plate: KnownPlate) => {
    if (
      !confirm(
        `Forget plate "${plate.plate}"${plate.name ? ` (${plate.name})` : ""}? It will be re-detected next time it appears.`,
      )
    )
      return;
    setBusy(plate.plate);
    try {
      await deleteKnownPlate(plate.plate);
      await refresh();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-4">
        <button
          onClick={() => router.push("/cameras")}
          className="p-2 -ml-2 rounded-full hover:bg-surface-secondary"
          aria-label="Back to cameras"
        >
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="type-large-title text-label-primary">License plates</h1>
          <p className="type-subheadline text-label-tertiary mt-0.5">
            License plates this Droplet has read. Name them so notifications
            show <span className="font-mono">&ldquo;Alice&apos;s Civic
            arrived&rdquo;</span> instead of a string of characters.
          </p>
        </div>
        <button
          onClick={() => void refresh()}
          disabled={loading}
          className="dp-btn-secondary flex items-center gap-2 px-3 py-2 rounded-lg"
        >
          <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
          <span className="type-subheadline">Refresh</span>
        </button>
      </div>

      {error && (
        <div className="dp-card p-4 mb-3 text-system-red flex items-center gap-2">
          <AlertTriangle size={14} />
          <span className="type-subheadline">{error}</span>
        </div>
      )}

      {loading && !plates ? (
        <div className="dp-card p-4 space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 rounded animate-pulse bg-surface-secondary" />
          ))}
        </div>
      ) : !plates || plates.length === 0 ? (
        <div className="dp-card text-center py-12">
          <Car size={32} className="mx-auto text-label-quaternary mb-3" />
          <h2 className="type-title-3 text-label-primary mb-1">
            No plates read yet
          </h2>
          <p className="type-subheadline text-label-tertiary max-w-md mx-auto">
            License-plate recognition isn&apos;t enabled, or no vehicle has
            driven by yet. Plates appear here after the first event with a
            readable plate.
          </p>
        </div>
      ) : (
        <ul className="dp-card divide-y divide-separator">
          {plates.map((p) => (
            <li
              key={p.plate}
              className="flex items-center gap-3 p-3"
            >
              <div className="w-12 h-9 rounded bg-system-yellow/15 flex items-center justify-center flex-shrink-0">
                <span className="type-caption-1 font-mono font-bold text-system-yellow">
                  {p.plate.slice(0, 4)}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <span className="type-subheadline text-label-primary font-mono block truncate">
                  {p.plate}
                </span>
                {editing === p.plate ? (
                  <div className="flex items-center gap-1 mt-1">
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      autoFocus
                      maxLength={60}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void commitEdit();
                        if (e.key === "Escape") setEditing(null);
                      }}
                      className="flex-1 h-7 px-2 rounded border border-separator bg-surface-secondary type-caption-1 text-label-primary focus:border-accent focus:outline-none"
                      placeholder="Alice's Civic"
                    />
                    <button
                      onClick={() => void commitEdit()}
                      disabled={busy === p.plate}
                      className="p-1.5 rounded text-accent hover:bg-accent/10"
                      title="Save"
                    >
                      {busy === p.plate ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Check size={12} />
                      )}
                    </button>
                    <button
                      onClick={() => setEditing(null)}
                      className="p-1.5 rounded text-label-tertiary hover:bg-surface-secondary"
                      title="Cancel"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <span
                    className={`type-caption-2 truncate block ${
                      p.name ? "text-label-secondary" : "text-label-tertiary italic"
                    }`}
                  >
                    {p.name ?? "Unnamed"} · {p.eventCount} event
                    {p.eventCount === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              {editing !== p.plate && (
                <>
                  <button
                    onClick={() => startEdit(p)}
                    className="p-1.5 rounded text-label-tertiary hover:text-label-primary hover:bg-surface-secondary"
                    title="Name this plate"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => handleDelete(p)}
                    disabled={busy === p.plate}
                    className="p-1.5 rounded text-label-tertiary hover:text-system-red hover:bg-system-red/10"
                    title="Forget plate"
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
