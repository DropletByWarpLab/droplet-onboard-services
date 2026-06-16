"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  RefreshCw,
  Trash2,
  User,
  X,
} from "lucide-react";
import {
  deleteFaceImage,
  deleteKnownFace,
  fetchKnownFaces,
} from "@/lib/api";
import type { KnownFace } from "@/lib/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { ShellPage } from "@/components/shell/ShellPage";

/**
 * Known-faces management (Phase 7.5).
 *
 * Lists every person Frigate's face recogniser has training images
 * for. Each card shows the count of training images, with an
 * expand-to-see-thumbnails section. Per-image and per-person delete.
 *
 * Adding a new face is intentionally NOT done here — the operator
 * tags an event from the events page (PR follows) which uploads
 * that snapshot as the first training image. This keeps the page
 * focused on management of the known-set.
 *
 * Frigate's face_recognition feature must be enabled in config.yml.
 * Without it, /api/cameras/faces returns an empty list — we surface
 * that as a clear "feature not enabled" hint rather than a blank
 * page.
 */
export default function PeoplePage() {
  const router = useRouter();
  const [faces, setFaces] = useState<KnownFace[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleteFaceTarget, setDeleteFaceTarget] = useState<KnownFace | null>(null);
  const [deleteImageTarget, setDeleteImageTarget] = useState<
    { face: KnownFace; imageName: string } | null
  >(null);
  const { toast } = useToast();

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setFaces(await fetchKnownFaces());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load faces");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const handleDeleteFace = (face: KnownFace) => {
    setDeleteFaceTarget(face);
  };

  const performDeleteFace = async () => {
    const face = deleteFaceTarget;
    if (!face) return;
    setBusy(face.name);
    try {
      await deleteKnownFace(face.name);
      setDeleteFaceTarget(null);
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteImage = async (face: KnownFace, imageName: string) => {
    if (face.images.length <= 1) {
      // Last training image — confirm via ConfirmDialog. Otherwise fire
      // directly (per-image deletes don't need a separate confirm step;
      // the operator is on a focused per-person panel).
      setDeleteImageTarget({ face, imageName });
      return;
    }
    await performDeleteImageInternal(face, imageName);
  };

  const performDeleteImageInternal = async (face: KnownFace, imageName: string) => {
    const key = `${face.name}/${imageName}`;
    setBusy(key);
    try {
      await deleteFaceImage(face.name, imageName);
      await refresh();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Delete failed", "error");
      throw e;
    } finally {
      setBusy(null);
    }
  };

  const performDeleteImageConfirm = async () => {
    const target = deleteImageTarget;
    if (!target) return;
    await performDeleteImageInternal(target.face, target.imageName);
    setDeleteImageTarget(null);
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
      icon={<User size={15} />}
      label="People"
      title="People"
      sub="Faces this Droplet has been trained to recognise. Add new ones from the Events page by tagging a person."
      actions={actions}
    >
      {error && (
        <div className="card" style={{ display: "flex", alignItems: "center", gap: 8, color: "#ef4444" }}>
          <AlertTriangle size={14} />
          <span>{error}</span>
        </div>
      )}

      {loading && !faces ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card h-40 animate-pulse" style={{ background: "var(--surface-2)" }} />
          ))}
        </div>
      ) : !faces || faces.length === 0 ? (
        <div className="card">
          <div className="empty">
            <span className="ei"><User size={24} /></span>
            <span className="eh">No known faces</span>
            <span style={{ maxWidth: "44ch" }}>
              Face recognition isn&apos;t enabled, or no one has been tagged
              yet. Tag someone from an event on the Events page to start.
            </span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {faces.map((face) => {
            const isExpanded = expanded.has(face.name);
            const cover = face.images[0];
            const deleting = busy === face.name;
            return (
              <div key={face.name} className="card" style={{ padding: 0, overflow: "hidden" }}>
                <div className="relative aspect-square bg-surface-secondary">
                  {cover ? (
                    <img
                      src={cover.imageUrl}
                      alt={face.name}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <User size={32} className="text-label-quaternary" />
                    </div>
                  )}
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-full bg-black/70 text-white type-caption-2">
                    {face.images.length} image{face.images.length === 1 ? "" : "s"}
                  </div>
                  <button
                    onClick={() => handleDeleteFace(face)}
                    disabled={deleting}
                    className="absolute top-2 right-2 p-1.5 rounded-full bg-black/70 text-white hover:text-system-red"
                    title="Delete person"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="p-3">
                  <h3 className="type-subheadline text-label-primary capitalize truncate">
                    {face.name}
                  </h3>
                  <button
                    onClick={() =>
                      setExpanded((s) => {
                        const next = new Set(s);
                        next.has(face.name)
                          ? next.delete(face.name)
                          : next.add(face.name);
                        return next;
                      })
                    }
                    className="type-caption-2 text-accent mt-1"
                  >
                    {isExpanded ? "Hide" : "Show"} training images
                  </button>
                  {isExpanded && (
                    <ul className="grid grid-cols-3 gap-1 mt-2">
                      {face.images.map((img) => {
                        const imgBusy = busy === `${face.name}/${img.name}`;
                        return (
                          <li key={img.name} className="relative aspect-square">
                            <img
                              src={img.imageUrl}
                              alt={img.name}
                              className="w-full h-full object-cover rounded"
                              loading="lazy"
                            />
                            <button
                              onClick={() => handleDeleteImage(face, img.name)}
                              disabled={imgBusy}
                              className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/70 text-white hover:text-system-red"
                              title="Remove training image"
                            >
                              <X size={10} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={deleteFaceTarget !== null}
        onConfirm={performDeleteFace}
        onCancel={() => setDeleteFaceTarget(null)}
        title={
          deleteFaceTarget
            ? `Remove "${deleteFaceTarget.name}" from face recognition?`
            : "Remove person?"
        }
        description={
          deleteFaceTarget
            ? `This drops all ${deleteFaceTarget.images.length} training image${deleteFaceTarget.images.length === 1 ? "" : "s"}. The system will stop recognising them.`
            : "Drops all training images for this person."
        }
        confirmLabel="Remove"
        variant="destructive"
      />

      <ConfirmDialog
        open={deleteImageTarget !== null}
        onConfirm={performDeleteImageConfirm}
        onCancel={() => setDeleteImageTarget(null)}
        title={
          deleteImageTarget
            ? `Remove the last training image for "${deleteImageTarget.face.name}"?`
            : "Remove last image?"
        }
        description="This is the last image — removing it deletes the person entirely from face recognition."
        confirmLabel="Remove person"
        variant="destructive"
      />
    </ShellPage>
  );
}
