"use client";

import { useCallback, useMemo, useState } from "react";
import type { FileEntryInfo, FileViewMode } from "../types";

/**
 * Clipboard state for a cut/copy operation. Paths are remembered so a later paste
 * in a different directory can hit the bulk-move or bulk-copy endpoint.
 */
export interface Clipboard {
  mode: "cut" | "copy";
  paths: string[];
  /** The directory the items were cut/copied from — shown for cancellation UX */
  sourceDir: string;
}

/**
 * Central state machine for the file manager. Kept deliberately tiny —
 * data fetching still happens in `useFiles`/SWR; this hook is pure UI state.
 *
 * Usage:
 *   const fm = useFileManager(currentPath);
 *   fm.toggleSelection(path);           // shift/ctrl-click
 *   fm.clearSelection();
 *   fm.cut(); fm.copy(); fm.clearClipboard();
 *   fm.beginRename(path); fm.endRename();
 *   fm.setViewMode("grid");
 */
export function useFileManager(currentPath: string) {
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [viewMode, setViewMode] = useState<FileViewMode>("list");
  const [lastAnchorPath, setLastAnchorPath] = useState<string | null>(null);

  const isSelected = useCallback(
    (path: string) => selection.has(path),
    [selection]
  );

  const selectOnly = useCallback((path: string) => {
    setSelection(new Set([path]));
    setLastAnchorPath(path);
  }, []);

  const toggleSelection = useCallback(
    (path: string, mode: "replace" | "toggle" | "range" = "replace", files?: FileEntryInfo[]) => {
      setSelection((prev) => {
        if (mode === "toggle") {
          const next = new Set(prev);
          if (next.has(path)) {
            next.delete(path);
          } else {
            next.add(path);
          }
          return next;
        }
        if (mode === "range" && files && lastAnchorPath) {
          const startIdx = files.findIndex((f) => f.path === lastAnchorPath);
          const endIdx = files.findIndex((f) => f.path === path);
          if (startIdx === -1 || endIdx === -1) return new Set([path]);
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          const next = new Set<string>();
          for (let i = lo; i <= hi; i++) next.add(files[i].path);
          return next;
        }
        return new Set([path]);
      });
      if (mode !== "range") setLastAnchorPath(path);
    },
    [lastAnchorPath]
  );

  const selectAll = useCallback((files: FileEntryInfo[]) => {
    setSelection(new Set(files.map((f) => f.path)));
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(new Set());
    setLastAnchorPath(null);
  }, []);

  const cut = useCallback(() => {
    if (selection.size === 0) return;
    setClipboard({
      mode: "cut",
      paths: Array.from(selection),
      sourceDir: currentPath,
    });
  }, [selection, currentPath]);

  const copy = useCallback(() => {
    if (selection.size === 0) return;
    setClipboard({
      mode: "copy",
      paths: Array.from(selection),
      sourceDir: currentPath,
    });
  }, [selection, currentPath]);

  const clearClipboard = useCallback(() => {
    setClipboard(null);
  }, []);

  const beginRename = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const endRename = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const selectedPaths = useMemo(() => Array.from(selection), [selection]);
  const selectedCount = selection.size;

  return {
    // Selection
    selection,
    selectedPaths,
    selectedCount,
    isSelected,
    selectOnly,
    toggleSelection,
    selectAll,
    clearSelection,
    // Rename
    renamingPath,
    beginRename,
    endRename,
    // Clipboard
    clipboard,
    cut,
    copy,
    clearClipboard,
    // View
    viewMode,
    setViewMode,
  };
}

export type FileManagerState = ReturnType<typeof useFileManager>;
