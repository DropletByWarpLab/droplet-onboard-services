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
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { ShellPage } from "@/components/shell/ShellPage";

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
  const [deleteTarget, setDeleteTarget] = useState<KnownPlate | null>(null);
  const { toast } = useToast();

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
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = (plate: KnownPlate) => {
    setDeleteTarget(plate);
  };

  const performDelete = async () => {
    const plate = deleteTarget;
    if (!plate) return;
    setBusy(plate.plate);
    try {
      await deleteKnownPlate(plate.plate);
      setDeleteTarget(null);
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const actions = (
    <>
      <button onClick={() => router.push("/cameras")} className="btn ghost" type="button">
        <ArrowLeft size={15} />
        Cameras
      </button>
      <button
        onClick={() => void refresh()}
        disabled={loading}
        className="icon-btn"
        aria-label="Refresh"
        title="Refresh"
        type="button"
      >
        <RefreshCw size={16} className={loading ? "animate-spin" : ""} />
      </button>
    </>
  );

  return (
    <ShellPage
      icon={<Car size={15} />}
      label="License plates"
      title="License plates"
      sub="License plates this Droplet has read. Name them so notifications show “Alice’s Civic arrived” instead of a string of characters."
      actions={actions}
    >
      {error && (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 8, color: "#ef4444" }}>
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {loading && !plates ? (
        <div className="card space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-12 rounded animate-pulse" style={{ background: "var(--surface-2)" }} />
          ))}
        </div>
      ) : !plates || plates.length === 0 ? (
        <div className="card">
          <div className="empty">
            <span className="ei"><Car size={24} /></span>
            <span className="eh">No plates read yet</span>
            <span style={{ maxWidth: "44ch" }}>
              License-plate recognition isn&apos;t enabled, or no vehicle has
              driven by yet. Plates appear here after the first event with a
              readable plate.
            </span>
          </div>
        </div>
      ) : (
        <ul className="card divide-y divide-separator" style={{ padding: 0 }}>
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
                      className="flex-1 h-7 px-2 type-caption-1 outline-none focus:border-[var(--brand)]"
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-input)",
                        color: "var(--text)",
                      }}
                      placeholder="Alice's Civic"
                    />
                    <button
                      onClick={() => void commitEdit()}
                      disabled={busy === p.plate}
                      className="p-1.5 rounded hover:bg-[var(--brand-subtle)]"
                      style={{ color: "var(--brand)" }}
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
                      className="p-1.5 rounded hover:bg-[var(--hover)]"
                      style={{ color: "var(--text-muted)" }}
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
                    className="p-1.5 rounded hover:bg-[var(--hover)] text-[color:var(--text-muted)] hover:text-[color:var(--text)]"
                    title="Name this plate"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => handleDelete(p)}
                    disabled={busy === p.plate}
                    className="p-1.5 rounded hover:bg-[rgba(239,68,68,0.1)] text-[color:var(--text-muted)] hover:text-[color:var(--danger)]"
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

      <ConfirmDialog
        open={deleteTarget !== null}
        onConfirm={performDelete}
        onCancel={() => setDeleteTarget(null)}
        title={
          deleteTarget
            ? `Forget plate "${deleteTarget.plate}"${deleteTarget.name ? ` (${deleteTarget.name})` : ""}?`
            : "Forget plate?"
        }
        description="The plate is re-detected next time it appears on camera, so you can re-tag it. The owner name is removed."
        confirmLabel="Forget"
        variant="destructive"
      />
    </ShellPage>
  );
}
