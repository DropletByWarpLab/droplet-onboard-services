"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, Plus, Trash2, X } from "lucide-react";
import { getCameraSnapshotUrl } from "@/lib/api";
import type { MotionMaskPolygon } from "@/lib/types";

interface Props {
  cameraName: string;
  masks: MotionMaskPolygon[];
  onChange: (next: MotionMaskPolygon[]) => void;
}

type Mode =
  | { kind: "idle" }
  | { kind: "drawing"; points: number[] }
  | { kind: "editing"; index: number };

/**
 * Polygon editor for motion masks — areas Frigate should ignore for
 * motion (a tree branch in the wind, the corner the cat sleeps in).
 *
 * Mechanically the same as `ZoneEditor` (SVG over a snapshot in the
 * unit square) but with less metadata: masks have no name, no
 * per-mask object filter, no inertia. Multiple polygons live in a
 * single list and Frigate ANDs them together.
 *
 * The visual choice is deliberate: red overlay with diagonal stripes,
 * which looks visually "cut out of the active area" — operators read
 * it as "Frigate is blind here" without needing a legend.
 */
export function MotionMaskEditor({ cameraName, masks, onChange }: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });

  const pointFromEvent = useCallback(
    (e: React.PointerEvent | PointerEvent): [number, number] | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return [
        Math.max(0, Math.min(1, x)),
        Math.max(0, Math.min(1, y)),
      ];
    },
    [],
  );

  const handleSvgClick = (e: React.PointerEvent<SVGSVGElement>) => {
    if (mode.kind !== "drawing") return;
    const target = e.target as Element;
    if (target.classList.contains("mask-handle")) return;
    const p = pointFromEvent(e);
    if (!p) return;
    setMode({ kind: "drawing", points: [...mode.points, p[0], p[1]] });
  };

  const finishDrawing = () => {
    if (mode.kind !== "drawing") return;
    if (mode.points.length < 6) return;
    onChange([...masks, { coordinates: [...mode.points] }]);
    // Auto-switch to editing the just-created mask.
    setMode({ kind: "editing", index: masks.length });
  };

  const cancelDrawing = () => setMode({ kind: "idle" });

  // Esc / Enter shortcuts.
  useEffect(() => {
    if (mode.kind === "idle") return;
    function onKey(ev: KeyboardEvent) {
      if (ev.key === "Escape") setMode({ kind: "idle" });
      if (ev.key === "Enter" && mode.kind === "drawing") finishDrawing();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Vertex drag (same pointer-capture pattern as ZoneEditor).
  const draggingRef = useRef<{
    maskIndex: number;
    vertexIndex: number;
    pointerId: number;
  } | null>(null);

  const startVertexDrag = (
    maskIndex: number,
    vertexIndex: number,
    e: React.PointerEvent<SVGCircleElement>,
  ) => {
    if (e.shiftKey) {
      const m = masks[maskIndex];
      if (m.coordinates.length / 2 <= 3) return;
      const next = m.coordinates.slice();
      next.splice(vertexIndex * 2, 2);
      const updated = masks.slice();
      updated[maskIndex] = { coordinates: next };
      onChange(updated);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = { maskIndex, vertexIndex, pointerId: e.pointerId };
  };

  const handleVertexMove = (e: React.PointerEvent<SVGCircleElement>) => {
    const drag = draggingRef.current;
    if (!drag) return;
    const p = pointFromEvent(e);
    if (!p) return;
    const m = masks[drag.maskIndex];
    if (!m) return;
    const next = m.coordinates.slice();
    next[drag.vertexIndex * 2] = p[0];
    next[drag.vertexIndex * 2 + 1] = p[1];
    const updated = masks.slice();
    updated[drag.maskIndex] = { coordinates: next };
    onChange(updated);
  };

  const endVertexDrag = (e: React.PointerEvent<SVGCircleElement>) => {
    const drag = draggingRef.current;
    if (!drag) return;
    e.currentTarget.releasePointerCapture(drag.pointerId);
    draggingRef.current = null;
  };

  const deleteMask = (idx: number) => {
    onChange(masks.filter((_, i) => i !== idx));
    setMode({ kind: "idle" });
  };

  const pointsString = (coords: number[]) =>
    coords.map((c, i) => (i % 2 === 0 ? `${c},` : `${c}`)).join(" ").replace(/, /g, ",");

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3">
        <div className="relative rounded-xl overflow-hidden bg-black">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`${getCameraSnapshotUrl(cameraName)}?h=720`}
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
            {/* Diagonal-stripes pattern so masks read as "blocked area"
                visually without needing a legend. */}
            <defs>
              <pattern
                id="mask-stripes"
                width="0.02"
                height="0.02"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <line
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="0.02"
                  stroke="rgb(220, 38, 38)"
                  strokeWidth="0.008"
                  vectorEffect="non-scaling-stroke"
                />
              </pattern>
            </defs>

            {masks.map((m, i) => {
              const isEditing = mode.kind === "editing" && mode.index === i;
              return (
                <g key={i}>
                  <polygon
                    points={pointsString(m.coordinates)}
                    fill="url(#mask-stripes)"
                    stroke="rgb(220, 38, 38)"
                    strokeWidth={isEditing ? 0.005 : 0.003}
                    vectorEffect="non-scaling-stroke"
                    style={{ cursor: "pointer" }}
                    onClick={(e) => {
                      e.stopPropagation();
                      setMode({ kind: "editing", index: i });
                    }}
                  />
                  {isEditing &&
                    Array.from({ length: m.coordinates.length / 2 }).map(
                      (_, vi) => (
                        <circle
                          key={vi}
                          className="mask-handle"
                          cx={m.coordinates[vi * 2]}
                          cy={m.coordinates[vi * 2 + 1]}
                          r={0.012}
                          fill="white"
                          stroke="rgb(220, 38, 38)"
                          strokeWidth={0.004}
                          vectorEffect="non-scaling-stroke"
                          style={{ cursor: "grab" }}
                          onPointerDown={(e) => startVertexDrag(i, vi, e)}
                          onPointerMove={handleVertexMove}
                          onPointerUp={endVertexDrag}
                        />
                      ),
                    )}
                </g>
              );
            })}

            {/* In-progress draft polygon */}
            {mode.kind === "drawing" && mode.points.length > 0 && (
              <>
                <polygon
                  points={pointsString(mode.points)}
                  fill="rgb(220, 38, 38)"
                  fillOpacity={0.2}
                  stroke="rgb(220, 38, 38)"
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

        {/* Side rail */}
        <div className="space-y-3">
          <button
            type="button"
            onClick={mode.kind === "drawing" ? finishDrawing : () => setMode({ kind: "drawing", points: [] })}
            disabled={mode.kind === "drawing" && mode.points.length < 6}
            className="dp-btn-primary w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg type-subheadline disabled:opacity-50"
          >
            {mode.kind === "drawing" ? (
              <>
                <Check size={14} />
                Finish mask ({mode.points.length / 2} pts)
              </>
            ) : (
              <>
                <Plus size={14} />
                New mask
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

          {masks.length === 0 && mode.kind !== "drawing" && (
            <p className="type-caption-1 text-label-tertiary">
              No motion masks yet. Draw polygons over areas Frigate should
              <strong> ignore</strong> for motion — moving foliage, glare, the
              corner where your dog sleeps.
            </p>
          )}

          {masks.map((m, i) => (
            <div
              key={i}
              className={`rounded-lg border ${
                mode.kind === "editing" && mode.index === i
                  ? "border-system-red"
                  : "border-separator"
              } p-2 flex items-center gap-2`}
            >
              <span className="w-3 h-3 rounded-sm bg-system-red flex-shrink-0" />
              <span className="flex-1 type-subheadline text-label-primary">
                Mask {i + 1}
              </span>
              <span className="type-caption-2 text-label-tertiary">
                {m.coordinates.length / 2} pts
              </span>
              <button
                type="button"
                onClick={() => setMode({ kind: "editing", index: i })}
                className="px-2 py-0.5 rounded type-caption-2 bg-surface-secondary text-label-secondary hover:bg-surface-tertiary"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => deleteMask(i)}
                className="p-1 rounded text-label-tertiary hover:text-system-red"
                title="Delete mask"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}

          <p className="type-caption-2 text-label-tertiary">
            Drag a vertex to move it. Shift-click a vertex to delete it.
          </p>
        </div>
      </div>
    </div>
  );
}
