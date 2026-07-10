"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pencil, Plus, Trash2, X, Check } from "lucide-react";
import { getCameraSnapshotUrl } from "@/lib/api";
import type { CameraZone } from "@/lib/types";
import { Dialog } from "@/components/Dialog";

interface Props {
  cameraName: string;
  zones: CameraZone[];
  /** Object labels available for per-zone restriction. Empty list =
   *  "any tracked label is fine." */
  trackedLabels: string[];
  onChange: (next: CameraZone[]) => void;
}

type Mode =
  | { kind: "idle" }
  | { kind: "drawing"; points: number[] }
  | { kind: "editing"; zoneIndex: number };

const ZONE_PALETTE = [
  "#ff6b6b", // red
  "#4ecdc4", // teal
  "#feca57", // yellow
  "#a29bfe", // purple
  "#5f27cd", // dark purple
  "#48dbfb", // light blue
  "#1dd1a1", // green
  "#ff9ff3", // pink
];

const colorFor = (i: number) => ZONE_PALETTE[i % ZONE_PALETTE.length];

/**
 * Polygon editor for camera zones. The SVG overlays the camera
 * snapshot at native size; mouse coordinates are translated into
 * normalised [0, 1] image space (Frigate's coordinate convention)
 * via the SVG bounding rect.
 *
 * Interaction model:
 *   - "+ New zone" enters drawing mode. Each click drops a vertex.
 *     "Finish" (or Enter) commits, prompting for a name. Esc cancels.
 *   - Click an existing zone (or its row in the side list) to enter
 *     editing mode for that zone. Vertices show as draggable handles.
 *     Drag a vertex to move it.
 *   - Shift-click a vertex deletes it (min 3 remain).
 *   - "Delete zone" removes the whole polygon.
 *
 * The component is uncontrolled-internal-state-with-controlled-prop:
 * we mutate a local copy via gestures, then `onChange` upstream so
 * the parent's dirty-state detector sees the diff. Reverts /
 * external sets re-sync via the `zones` prop.
 */
export function ZoneEditor({
  cameraName,
  zones,
  trackedLabels,
  onChange,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [namePromptOpen, setNamePromptOpen] = useState(false);
  const [pendingName, setPendingName] = useState("");
  const namePromptHeadingId = useId();

  // ---------- SVG → normalised coordinate mapping ----------

  const svgPointFromEvent = useCallback((e: React.PointerEvent | PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Clamp into the unit square so a stray drag past the snapshot
    // edge doesn't store invalid coords.
    return [
      Math.max(0, Math.min(1, x)),
      Math.max(0, Math.min(1, y)),
    ] as [number, number];
  }, []);

  // ---------- Drawing mode ----------

  const handleSvgClick = (e: React.PointerEvent<SVGSVGElement>) => {
    if (mode.kind !== "drawing") return;
    // Don't add a point if the click was on an existing handle —
    // drawing-mode clicks should only land in empty space.
    const target = e.target as Element;
    if (target.classList.contains("zone-handle")) return;
    const p = svgPointFromEvent(e);
    if (!p) return;
    setMode({ kind: "drawing", points: [...mode.points, p[0], p[1]] });
  };

  const finishDrawing = () => {
    if (mode.kind !== "drawing") return;
    if (mode.points.length < 6) {
      // Need at least 3 (x, y) points.
      return;
    }
    setNamePromptOpen(true);
  };

  const cancelDrawing = () => {
    setMode({ kind: "idle" });
  };

  // Esc cancels in-progress draw or clears editing.
  useEffect(() => {
    if (mode.kind === "idle") return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMode({ kind: "idle" });
      if (ev.key === "Enter" && mode.kind === "drawing") {
        finishDrawing();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const commitNewZone = () => {
    if (mode.kind !== "drawing") return;
    const trimmed = pendingName.trim();
    if (!trimmed || !/^[a-zA-Z0-9_-]{1,40}$/.test(trimmed)) return;
    if (zones.some((z) => z.name === trimmed)) return; // duplicate
    onChange([
      ...zones,
      {
        name: trimmed,
        coordinates: [...mode.points],
        objects: [],
        inertia: 3,
      },
    ]);
    setPendingName("");
    setNamePromptOpen(false);
    setMode({ kind: "editing", zoneIndex: zones.length });
  };

  // ---------- Vertex drag ----------

  const draggingRef = useRef<{
    zoneIndex: number;
    vertexIndex: number;
    pointerId: number;
  } | null>(null);

  const startVertexDrag = (
    zoneIndex: number,
    vertexIndex: number,
    e: React.PointerEvent<SVGCircleElement>,
  ) => {
    if (e.shiftKey) {
      // Shift-click deletes the vertex (min 3 remain).
      const z = zones[zoneIndex];
      if (z.coordinates.length / 2 <= 3) return;
      const next = z.coordinates.slice();
      next.splice(vertexIndex * 2, 2);
      const updated = zones.slice();
      updated[zoneIndex] = { ...z, coordinates: next };
      onChange(updated);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = { zoneIndex, vertexIndex, pointerId: e.pointerId };
  };

  const handleVertexMove = (e: React.PointerEvent<SVGCircleElement>) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const p = svgPointFromEvent(e);
    if (!p) return;
    const z = zones[drag.zoneIndex];
    if (!z) return;
    const next = z.coordinates.slice();
    next[drag.vertexIndex * 2] = p[0];
    next[drag.vertexIndex * 2 + 1] = p[1];
    const updated = zones.slice();
    updated[drag.zoneIndex] = { ...z, coordinates: next };
    onChange(updated);
  };

  const endVertexDrag = (e: React.PointerEvent<SVGCircleElement>) => {
    const drag = draggingRef.current;
    if (!drag) return;
    e.currentTarget.releasePointerCapture(drag.pointerId);
    draggingRef.current = null;
  };

  // ---------- Zone-level operations ----------

  const startEditing = (zoneIndex: number) =>
    setMode({ kind: "editing", zoneIndex });
  const startDrawing = () =>
    setMode({ kind: "drawing", points: [] });

  const deleteZone = (zoneIndex: number) => {
    onChange(zones.filter((_, i) => i !== zoneIndex));
    setMode({ kind: "idle" });
  };

  const renameZone = (zoneIndex: number, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || !/^[a-zA-Z0-9_-]{1,40}$/.test(trimmed)) return;
    if (zones.some((z, i) => i !== zoneIndex && z.name === trimmed)) return;
    const updated = zones.slice();
    updated[zoneIndex] = { ...updated[zoneIndex], name: trimmed };
    onChange(updated);
  };

  const toggleZoneObject = (zoneIndex: number, label: string) => {
    const z = zones[zoneIndex];
    const next = new Set(z.objects);
    next.has(label) ? next.delete(label) : next.add(label);
    const updated = zones.slice();
    updated[zoneIndex] = { ...z, objects: Array.from(next) };
    onChange(updated);
  };

  const setZoneInertia = (zoneIndex: number, inertia: number) => {
    if (!Number.isFinite(inertia) || inertia < 1 || inertia > 50) return;
    const updated = zones.slice();
    updated[zoneIndex] = { ...updated[zoneIndex], inertia };
    onChange(updated);
  };

  // ---------- Render helpers ----------

  /** Convert a flat coordinate array into an SVG `points` string. */
  const pointsString = (coords: number[]) =>
    coords
      .map((c, i) => (i % 2 === 0 ? `${c},` : `${c}`))
      .join(" ")
      .replace(/, /g, ",");

  const snapshotUrl = useMemo(
    () => `${getCameraSnapshotUrl(cameraName)}?h=720`,
    [cameraName],
  );

  const editingZone =
    mode.kind === "editing" && zones[mode.zoneIndex]
      ? { zone: zones[mode.zoneIndex], index: mode.zoneIndex }
      : null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3">
        {/* Snapshot + SVG overlay */}
        <div className="relative rounded-xl overflow-hidden bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={snapshotUrl}
            alt={`${cameraName} snapshot`}
            className="block w-full h-auto select-none"
            draggable={false}
          />
          <svg
            ref={svgRef}
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            className={`absolute inset-0 w-full h-full ${
              mode.kind === "drawing" ? "cursor-crosshair" : ""
            }`}
            onClick={handleSvgClick}
          >
            {/* Existing zones */}
            {zones.map((z, i) => {
              const isEditing = editingZone?.index === i;
              return (
                <g key={`${z.name}-${i}`}>
                  <polygon
                    points={pointsString(z.coordinates)}
                    fill={colorFor(i)}
                    fillOpacity={isEditing ? 0.25 : 0.15}
                    stroke={colorFor(i)}
                    strokeWidth={isEditing ? 0.005 : 0.003}
                    vectorEffect="non-scaling-stroke"
                    style={{ cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      startEditing(i);
                    }}
                  />
                  {/* Vertex handles, only while editing this zone */}
                  {isEditing &&
                    Array.from({ length: z.coordinates.length / 2 }).map(
                      (_, vi) => {
                        const x = z.coordinates[vi * 2];
                        const y = z.coordinates[vi * 2 + 1];
                        return (
                          <circle
                            key={vi}
                            className="zone-handle"
                            cx={x}
                            cy={y}
                            r={0.012}
                            fill="white"
                            stroke={colorFor(i)}
                            strokeWidth={0.004}
                            vectorEffect="non-scaling-stroke"
                            style={{ cursor: "grab" }}
                            onPointerDown={(e) => startVertexDrag(i, vi, e)}
                            onPointerMove={handleVertexMove}
                            onPointerUp={endVertexDrag}
                          />
                        );
                      },
                    )}
                  {/* Zone label */}
                  {z.coordinates.length >= 2 && (
                    <text
                      x={z.coordinates[0]}
                      y={z.coordinates[1] - 0.01}
                      fill={colorFor(i)}
                      fontSize="0.025"
                      fontWeight={600}
                      style={{ pointerEvents: "none", userSelect: "none" }}
                    >
                      {z.name}
                    </text>
                  )}
                </g>
              );
            })}

            {/* In-progress draft polygon */}
            {mode.kind === "drawing" && mode.points.length > 0 && (
              <>
                <polygon
                  points={pointsString(mode.points)}
                  fill="white"
                  fillOpacity={0.15}
                  stroke="white"
                  strokeWidth={0.005}
                  strokeDasharray="0.01 0.01"
                  vectorEffect="non-scaling-stroke"
                />
                {Array.from({ length: mode.points.length / 2 }).map((_, vi) => (
                  <circle
                    key={`draft-${vi}`}
                    cx={mode.points[vi * 2]}
                    cy={mode.points[vi * 2 + 1]}
                    r={0.01}
                    fill="white"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
              </>
            )}
          </svg>
        </div>

        {/* Side rail — zone list + editing controls */}
        <div className="space-y-3">
          <button
            type="button"
            onClick={mode.kind === "drawing" ? finishDrawing : startDrawing}
            className="dp-btn-primary w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg type-subheadline"
            disabled={mode.kind === "drawing" && mode.points.length < 6}
          >
            {mode.kind === "drawing" ? (
              <>
                <Check size={14} />
                Finish zone ({mode.points.length / 2} pts)
              </>
            ) : (
              <>
                <Plus size={14} />
                New zone
              </>
            )}
          </button>
          {mode.kind === "drawing" && (
            <button
              type="button"
              onClick={cancelDrawing}
              className="dp-btn-secondary w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg type-caption-1"
            >
              <X size={12} />
              Cancel (Esc)
            </button>
          )}

          {zones.length === 0 && mode.kind !== "drawing" && (
            <p className="type-caption-1 text-label-tertiary">
              No zones yet. Click <strong>New zone</strong> and tap points on the
              snapshot to outline an area Frigate should care about.
            </p>
          )}

          {zones.map((z, i) => {
            const isEditing = editingZone?.index === i;
            return (
              <div
                key={`${z.name}-${i}`}
                className={`rounded-lg border ${
                  isEditing ? "border-accent" : "border-separator"
                } p-2 space-y-2`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-3 h-3 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: colorFor(i) }}
                  />
                  <input
                    type="text"
                    value={z.name}
                    onChange={(e) => renameZone(i, e.target.value)}
                    maxLength={40}
                    className="flex-1 type-subheadline text-label-primary bg-transparent focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => startEditing(i)}
                    className={`p-1 rounded ${
                      isEditing ? "text-accent" : "text-label-tertiary hover:text-label-primary"
                    }`}
                    title="Edit polygon"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteZone(i)}
                    className="p-1 rounded text-label-tertiary hover:text-system-red"
                    title="Delete zone"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>

                {/* Per-zone object filter */}
                {trackedLabels.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {trackedLabels.map((label) => {
                      const active = z.objects.includes(label);
                      return (
                        <button
                          key={label}
                          type="button"
                          onClick={() => toggleZoneObject(i, label)}
                          className={`px-1.5 py-0.5 rounded-full type-caption-2 capitalize ${
                            active
                              ? "bg-accent text-white"
                              : "bg-surface-secondary text-label-secondary hover:bg-surface-tertiary"
                          }`}
                        >
                          {label}
                        </button>
                      );
                    })}
                    {z.objects.length === 0 && (
                      <span className="type-caption-2 text-label-tertiary self-center">
                        (any tracked object)
                      </span>
                    )}
                  </div>
                )}

                {/* Inertia slider */}
                <div className="flex items-center gap-2">
                  <span className="type-caption-2 text-label-tertiary w-16">Inertia</span>
                  <input
                    type="range"
                    min={1}
                    max={20}
                    step={1}
                    value={z.inertia}
                    onChange={(e) => setZoneInertia(i, Number(e.target.value))}
                    className="flex-1 accent-accent"
                  />
                  <span className="type-caption-2 text-label-secondary font-mono w-6 text-right">
                    {z.inertia}
                  </span>
                </div>
              </div>
            );
          })}

          <p className="type-caption-2 text-label-tertiary">
            Drag a vertex to move it. Shift-click a vertex to delete it (min 3
            remain). Click a polygon to edit it.
          </p>
        </div>
      </div>

      {/* Name prompt for the new zone — WARP-289: ARIA via shared Dialog. */}
      <Dialog
        open={namePromptOpen}
        onClose={() => setNamePromptOpen(false)}
        labelledBy={namePromptHeadingId}
        maxWidth="sm"
      >
        {/* Body padding comes from the <Dialog> primitive (WARP-1153). */}
        <div>
          <h3
            id={namePromptHeadingId}
            className="type-title-3 text-label-primary mb-2"
          >
            Name this zone
          </h3>
          <p className="type-caption-1 text-label-tertiary mb-3">
            Letters, numbers, hyphens, underscores. Up to 40 characters.
          </p>
          <input
            type="text"
            value={pendingName}
            onChange={(e) => setPendingName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitNewZone();
              // Escape is handled by Dialog itself; no need to dupe here.
            }}
            autoFocus
            maxLength={40}
            placeholder="front_yard"
            aria-label="Zone name"
            className="w-full h-10 px-3 rounded-lg border border-separator bg-surface-secondary type-subheadline text-label-primary focus:border-accent focus:outline-none"
          />
          <div className="flex justify-end gap-2 mt-3">
            <button
              type="button"
              onClick={() => setNamePromptOpen(false)}
              className="dp-btn-secondary px-3 py-2 rounded-lg type-subheadline"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commitNewZone}
              disabled={
                !pendingName.trim() ||
                !/^[a-zA-Z0-9_-]{1,40}$/.test(pendingName.trim()) ||
                zones.some((z) => z.name === pendingName.trim())
              }
              className="dp-btn-primary px-3 py-2 rounded-lg type-subheadline disabled:opacity-50"
            >
              Create
            </button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
