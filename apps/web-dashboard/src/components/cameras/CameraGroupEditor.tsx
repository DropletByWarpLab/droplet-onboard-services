"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import type { CameraGroupInfo, CameraInfo } from "@/lib/types";

interface Props {
  /** When set, editing this existing group; null = creating a new one. */
  group: CameraGroupInfo | null;
  cameras: CameraInfo[];
  onClose: () => void;
  onCreate: (input: {
    name: string;
    icon: string | null;
    cameraNames: string[];
  }) => Promise<void>;
  onSaveMeta: (
    id: string,
    patch: { name?: string; icon?: string | null },
  ) => Promise<void>;
  onAddMember: (id: string, cameraName: string) => Promise<void>;
  onRemoveMember: (id: string, cameraName: string) => Promise<void>;
}

/**
 * Modal for creating or editing a camera group.
 *
 * One component, two flows: when `group` is null we render the create
 * form (single submit POSTs name + icon + initial members); when it's
 * non-null we render the edit form (each save independently — name/icon
 * via PATCH on blur, member toggles call POST or DELETE eagerly).
 *
 * Edit-flow saves are eager: tick a camera and it's added immediately.
 * Untick and it's removed. The operator can close anytime without a
 * "save" step. Matches how Apple's Photos albums work and surprises
 * operators less than a "save" button that might silently not have
 * committed yet.
 *
 * Cameras are referenced by their Frigate name throughout — the same
 * key the rest of the API uses.
 */
export function CameraGroupEditor({
  group,
  cameras,
  onClose,
  onCreate,
  onSaveMeta,
  onAddMember,
  onRemoveMember,
}: Props) {
  const isEdit = group !== null;

  const [name, setName] = useState(group?.name ?? "");
  const [icon, setIcon] = useState(group?.icon ?? "");
  const [members, setMembers] = useState<Set<string>>(
    () => new Set(group?.members.map((m) => m.cameraName) ?? []),
  );
  const [saving, setSaving] = useState(false);
  const [savingFor, setSavingFor] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // Esc closes the modal — same pattern as the fullscreen route.
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sortedCameras = useMemo(
    () =>
      cameras
        .slice()
        .sort((a, b) => a.displayName.localeCompare(b.displayName)),
    [cameras],
  );

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name.trim()) {
      setErr("Group needs a name.");
      return;
    }
    setSaving(true);
    try {
      await onCreate({
        name: name.trim(),
        icon: icon.trim() || null,
        cameraNames: Array.from(members),
      });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create group");
    } finally {
      setSaving(false);
    }
  }

  async function commitNameOrIcon() {
    if (!isEdit || !group) return;
    const trimmedName = name.trim();
    const newIcon = icon.trim() || null;
    if (trimmedName === group.name && newIcon === group.icon) return;
    setErr(null);
    setSaving(true);
    try {
      await onSaveMeta(group.id, {
        name: trimmedName !== group.name ? trimmedName : undefined,
        icon: newIcon !== group.icon ? newIcon : undefined,
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save group");
    } finally {
      setSaving(false);
    }
  }

  async function toggleMember(cameraName: string) {
    setErr(null);
    if (!isEdit || !group) {
      // Create flow — stage in local state only; server call happens
      // on form submit.
      setMembers((s) => {
        const next = new Set(s);
        next.has(cameraName) ? next.delete(cameraName) : next.add(cameraName);
        return next;
      });
      return;
    }
    // Edit flow — eager commit
    setSavingFor(cameraName);
    try {
      if (members.has(cameraName)) {
        await onRemoveMember(group.id, cameraName);
        setMembers((s) => {
          const next = new Set(s);
          next.delete(cameraName);
          return next;
        });
      } else {
        await onAddMember(group.id, cameraName);
        setMembers((s) => {
          const next = new Set(s);
          next.add(cameraName);
          return next;
        });
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to update membership");
    } finally {
      setSavingFor(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="relative w-full sm:max-w-lg max-h-[90vh] overflow-y-auto bg-[var(--color-surface-primary)] dp-material rounded-t-2xl sm:rounded-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-separator bg-[var(--color-surface-primary)]">
          <h2 className="type-title-3 text-label-primary">
            {isEdit ? "Edit group" : "New camera group"}
          </h2>
          <button
            onClick={onClose}
            className="p-2 rounded-full hover:bg-surface-secondary transition-colors"
            aria-label="Close"
          >
            <X size={20} className="text-label-secondary" />
          </button>
        </div>

        <form onSubmit={isEdit ? (e) => e.preventDefault() : handleCreate}>
          <div className="p-4 space-y-4">
            <div className="grid grid-cols-[auto_1fr] gap-3">
              <label className="block">
                <span className="type-caption-2 text-label-tertiary block mb-1">
                  Icon
                </span>
                <input
                  type="text"
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  onBlur={commitNameOrIcon}
                  placeholder="🏠"
                  maxLength={4}
                  className="w-14 h-10 text-center text-xl rounded-lg border border-separator bg-surface-secondary focus:border-accent focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="type-caption-2 text-label-tertiary block mb-1">
                  Name
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={commitNameOrIcon}
                  placeholder="Front of house"
                  maxLength={60}
                  required
                  className="w-full h-10 px-3 rounded-lg border border-separator bg-surface-secondary type-subheadline text-label-primary focus:border-accent focus:outline-none"
                  autoFocus
                />
              </label>
            </div>

            <div>
              <h3 className="type-caption-2 text-label-tertiary mb-2">
                Cameras in this group
              </h3>
              {sortedCameras.length === 0 ? (
                <p className="type-footnote text-label-tertiary py-3">
                  No cameras configured yet.
                </p>
              ) : (
                <ul className="space-y-1 max-h-72 overflow-y-auto -mx-1 px-1">
                  {sortedCameras.map((cam) => (
                    <MemberRow
                      key={cam.name}
                      camera={cam}
                      checked={members.has(cam.name)}
                      saving={savingFor === cam.name}
                      onToggle={() => toggleMember(cam.name)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {err && <p className="type-footnote text-system-red">{err}</p>}
          </div>

          <div className="sticky bottom-0 flex items-center justify-end gap-2 p-3 border-t border-separator bg-[var(--color-surface-primary)]">
            <button
              type="button"
              onClick={onClose}
              className="dp-btn-secondary px-3 py-2 rounded-lg type-subheadline"
            >
              {isEdit ? "Done" : "Cancel"}
            </button>
            {!isEdit && (
              <button
                type="submit"
                disabled={saving || !name.trim()}
                className="dp-btn-primary flex items-center gap-2 px-3 py-2 rounded-lg type-subheadline"
              >
                {saving ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Check size={16} />
                )}
                Create group
              </button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function MemberRow({
  camera,
  checked,
  saving,
  onToggle,
}: {
  camera: CameraInfo;
  checked: boolean;
  saving: boolean;
  onToggle: () => void;
}) {
  return (
    <li>
      <label className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-surface-secondary cursor-pointer transition-colors">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={saving}
          className="h-4 w-4 accent-accent"
        />
        {/* WARP-1153: min-w-0 lets the flex item shrink so a long camera name
            truncates instead of bleeding past the sheet edge (the sheet only
            scrolls vertically). */}
        <span className="flex-1 min-w-0 type-subheadline text-label-primary truncate">
          {camera.displayName}
        </span>
        {saving && (
          <Loader2 size={14} className="text-label-tertiary animate-spin" />
        )}
        <span className="type-caption-2 text-label-tertiary capitalize">
          {camera.status}
        </span>
      </label>
    </li>
  );
}
