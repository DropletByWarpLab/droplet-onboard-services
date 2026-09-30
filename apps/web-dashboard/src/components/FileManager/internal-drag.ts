import { useCallback, useRef, useState } from "react";

/**
 * Drag-to-move inside the Files page. An INTERNAL drag carries this custom
 * type so it can be told apart from an external file drop (which the
 * `UploadZone` turns into an upload): both arrive as `drop` events on the same
 * elements, and only the dataTransfer type says which one this is.
 */
export const INTERNAL_DRAG_TYPE = "application/x-droplet-files";

type DT = Pick<DataTransfer, "types">;

export function isInternalDrag(dt: DT | null | undefined): boolean {
  return !!dt && Array.from(dt.types ?? []).includes(INTERNAL_DRAG_TYPE);
}

/** Entry paths (home-relative, as listings carry them) being dragged. */
export function writeDragPaths(dt: DataTransfer, paths: string[]): void {
  dt.setData(INTERNAL_DRAG_TYPE, JSON.stringify(paths));
  dt.effectAllowed = "move";
}

export function readDragPaths(dt: DataTransfer): string[] {
  try {
    const parsed: unknown = JSON.parse(dt.getData(INTERNAL_DRAG_TYPE));
    return Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    return [];
  }
}

const parentOf = (p: string) => p.replace(/\/[^/]*$/, "") || "/";

/**
 * The subset of `paths` that dropping onto folder `target` would actually
 * change. Excluded: the target itself, anything already directly inside it
 * (a same-folder drop is a no-op, not a "name already exists" error), and a
 * folder dropped into its own descendant. Dropping a selection onto one of its
 * own members moves nothing at all. All paths are in ONE path space (callers
 * pass home-relative entry paths).
 */
export function movablePaths(target: string, paths: string[]): string[] {
  const t = target.replace(/\/+$/, "") || "/";
  if (paths.includes(t)) return [];
  return paths.filter((p) => {
    if (p === t) return false;
    if (t.startsWith(p + "/")) return false;
    if (parentOf(p) === t) return false;
    return true;
  });
}

/**
 * Drop-target wiring for one element (folder row, folder tile, breadcrumb).
 * Only INTERNAL drags are handled: an external file drag is left to bubble to
 * the page's `UploadZone` untouched. `canDrop` runs during dragover, where the
 * payload is unreadable by design, so callers judge from what they are
 * tracking (see the page's dragged-paths ref).
 */
export function useDropTarget({
  enabled,
  canDrop,
  onDrop,
}: {
  enabled: boolean;
  canDrop: () => boolean;
  onDrop: (paths: string[]) => void;
}) {
  const [isOver, setIsOver] = useState(false);
  // dragenter/leave fire for every child crossed; a counter keeps the
  // highlight steady instead of flickering.
  const depth = useRef(0);

  const reset = useCallback(() => {
    depth.current = 0;
    setIsOver(false);
  }, []);

  const handlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!enabled || !isInternalDrag(e.dataTransfer) || !canDrop()) return;
      e.preventDefault();
      e.stopPropagation();
      depth.current++;
      setIsOver(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!enabled || !isInternalDrag(e.dataTransfer) || !canDrop()) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!enabled || !isInternalDrag(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setIsOver(false);
    },
    onDrop: (e: React.DragEvent) => {
      if (!enabled || !isInternalDrag(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      reset();
      const paths = readDragPaths(e.dataTransfer);
      if (paths.length > 0) onDrop(paths);
    },
  };

  return { isOver, handlers };
}
