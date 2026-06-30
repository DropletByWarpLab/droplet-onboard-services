"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  X,
  Folder,
  ChevronRight,
  ChevronDown,
  Home,
  FolderPlus,
} from "lucide-react";
import { fetchFiles, createDirectory } from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";
import type { FileEntryInfo } from "@/lib/types";

interface MoveCopyDialogProps {
  mode: "move" | "copy";
  /** Human-readable labels for the current selection so we can preview it in the header */
  selectionLabels: string[];
  /** Current directory — used as the default highlight + to disable no-op targets */
  currentDir: string;
  /** Disallowed destinations (e.g. the items themselves + their subtrees) */
  forbiddenPrefixes?: string[];
  onCancel: () => void;
  onConfirm: (targetDir: string) => void | Promise<void>;
}

interface TreeNode {
  path: string;
  name: string;
  children?: TreeNode[];
  loading?: boolean;
  expanded?: boolean;
}

/**
 * Modal dialog for picking a destination folder for a Move or Copy operation.
 * Uses a lazy-loading tree that starts at root and calls `/api/files` per branch.
 */
export function MoveCopyDialog({
  mode,
  selectionLabels,
  currentDir,
  forbiddenPrefixes = [],
  onCancel,
  onConfirm,
}: MoveCopyDialogProps) {
  const [tree, setTree] = useState<TreeNode>({
    path: "/",
    name: "Home",
    children: undefined,
    expanded: true,
  });
  const [selectedPath, setSelectedPath] = useState<string>(currentDir);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // WARP-938 — inline "New folder" creation at the selected target.
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderSubmitting, setFolderSubmitting] = useState(false);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // Load root on mount
  useEffect(() => {
    loadChildren("/");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadChildren = useCallback(async (dirPath: string) => {
    setTree((prev) => updateNode(prev, dirPath, (node) => ({ ...node, loading: true })));
    try {
      const files = await fetchFiles(dirPath);
      const children: TreeNode[] = files
        .filter((f: FileEntryInfo) => f.isDirectory)
        .map((f) => ({ path: f.path, name: f.name, children: undefined }));
      setTree((prev) =>
        updateNode(prev, dirPath, (node) => ({
          ...node,
          children,
          loading: false,
          expanded: true,
        }))
      );
    } catch (err) {
      setError(translateError(err, "files"));
      setTree((prev) =>
        updateNode(prev, dirPath, (node) => ({ ...node, loading: false }))
      );
    }
  }, []);

  const toggleNode = useCallback(
    (node: TreeNode) => {
      if (node.children === undefined) {
        void loadChildren(node.path);
      } else {
        setTree((prev) =>
          updateNode(prev, node.path, (n) => ({ ...n, expanded: !n.expanded }))
        );
      }
    },
    [loadChildren]
  );

  const isForbidden = useCallback(
    (path: string) => {
      return forbiddenPrefixes.some(
        (prefix) => path === prefix || path.startsWith(prefix + "/")
      );
    },
    [forbiddenPrefixes]
  );

  const handleConfirm = useCallback(async () => {
    if (!selectedPath) return;
    if (isForbidden(selectedPath)) return;
    setSubmitting(true);
    setError(null);
    try {
      await onConfirm(selectedPath);
    } catch (err) {
      setError(translateError(err, "files"));
      setSubmitting(false);
    }
  }, [selectedPath, isForbidden, onConfirm]);

  // WARP-938 — open the inline new-folder form and focus its input.
  const openNewFolder = useCallback(() => {
    setError(null);
    setNewFolderName("");
    setCreatingFolder(true);
    // Focus on the next paint, once the input is mounted.
    requestAnimationFrame(() => newFolderInputRef.current?.focus());
  }, []);

  const cancelNewFolder = useCallback(() => {
    setCreatingFolder(false);
    setNewFolderName("");
  }, []);

  // Create a folder at the currently-selected target and select it, all without
  // leaving the dialog. Reuses createDirectory() → POST /api/files/mkdir, the
  // same endpoint the Files page uses for "New folder".
  const handleCreateFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    const parent = selectedPath || "/";
    const folderPath = parent === "/" ? `/${name}` : `${parent}/${name}`;
    setFolderSubmitting(true);
    setError(null);
    try {
      await createDirectory(folderPath);
      // Optimistically insert the new folder under its parent so it appears in
      // the tree immediately, then make it the active target.
      setTree((prev) =>
        updateNode(prev, parent, (node) => {
          const existing = node.children ?? [];
          if (existing.some((c) => c.path === folderPath)) return node;
          const child: TreeNode = { path: folderPath, name, children: undefined };
          return {
            ...node,
            expanded: true,
            children: [...existing, child].sort((a, b) =>
              a.name.localeCompare(b.name),
            ),
          };
        }),
      );
      setSelectedPath(folderPath);
      setCreatingFolder(false);
      setNewFolderName("");
    } catch (err) {
      setError(translateError(err, "files"));
    } finally {
      setFolderSubmitting(false);
    }
  }, [newFolderName, selectedPath]);

  const title = mode === "move" ? "Move to…" : "Copy to…";
  const ctaLabel =
    mode === "move" ? "Move here" : "Copy here";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
      onClick={onCancel}
    >
      <div
        className="bg-surface-primary rounded-lg max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
          <div>
            <h3 className="type-headline text-label-primary">{title}</h3>
            <p className="type-caption-1 text-label-tertiary mt-0.5 truncate">
              {selectionLabels.length === 1
                ? selectionLabels[0]
                : `${selectionLabels.length} items`}
            </p>
          </div>
          <button
            onClick={onCancel}
            className="p-1 text-label-tertiary hover:text-label-primary"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tree */}
        <div className="flex-1 overflow-auto p-2">
          <TreeNodeView
            node={tree}
            depth={0}
            selectedPath={selectedPath}
            isForbidden={isForbidden}
            onSelect={setSelectedPath}
            onToggle={toggleNode}
          />
        </div>

        {/* New folder — create a destination at the selected target inline. */}
        <div className="px-3 py-2 border-t border-separator">
          {creatingFolder ? (
            <div className="flex items-center gap-2">
              <FolderPlus
                size={14}
                className="text-label-tertiary shrink-0"
                aria-hidden="true"
              />
              <input
                ref={newFolderInputRef}
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleCreateFolder();
                  if (e.key === "Escape") cancelNewFolder();
                }}
                placeholder="Folder name…"
                aria-label="New folder name"
                disabled={folderSubmitting}
                className="flex-1 min-w-0 bg-surface-secondary rounded-sm px-2 py-1 type-footnote text-label-primary placeholder:text-label-quaternary outline-none focus:ring-1 focus:ring-accent"
              />
              <button
                type="button"
                onClick={() => void handleCreateFolder()}
                disabled={folderSubmitting || !newFolderName.trim()}
                className="type-caption-1 text-accent hover:text-accent-hover disabled:text-label-quaternary px-2 py-1 transition-colors"
              >
                {folderSubmitting ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={cancelNewFolder}
                disabled={folderSubmitting}
                className="type-caption-1 text-label-tertiary hover:text-label-primary px-1 py-1 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={openNewFolder}
              className="flex items-center gap-1.5 type-footnote text-accent hover:text-accent-hover px-1 py-1 transition-colors"
            >
              <FolderPlus size={14} aria-hidden="true" />
              New folder
            </button>
          )}
        </div>

        {/* Error */}
        {error && (
          <div className="px-4 py-2 type-footnote text-system-red bg-system-red/10 border-t border-system-red/20">
            {error}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-separator">
          <div className="type-caption-1 text-label-tertiary truncate flex-1 min-w-0">
            Target: <span className="text-label-primary">{selectedPath}</span>
          </div>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="type-subheadline text-accent hover:text-accent-hover px-3 py-2 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting || isForbidden(selectedPath)}
            className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5"
          >
            {submitting ? "Working…" : ctaLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Recursive tree view ──

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  selectedPath: string;
  isForbidden: (path: string) => boolean;
  onSelect: (path: string) => void;
  onToggle: (node: TreeNode) => void;
}

function TreeNodeView({
  node,
  depth,
  selectedPath,
  isForbidden,
  onSelect,
  onToggle,
}: TreeNodeViewProps) {
  const selected = selectedPath === node.path;
  const forbidden = isForbidden(node.path);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const Chevron = node.expanded ? ChevronDown : ChevronRight;

  return (
    <div>
      <div
        onClick={() => {
          if (forbidden) return;
          onSelect(node.path);
        }}
        className={`flex items-center gap-1 py-1.5 pl-1 pr-2 rounded-sm cursor-pointer transition-colors
          ${
            forbidden
              ? "text-label-quaternary cursor-not-allowed"
              : selected
              ? "bg-accent-subtle text-accent"
              : "hover:bg-surface-secondary text-label-primary"
          }`}
        style={{ paddingLeft: depth * 16 + 4 }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node);
          }}
          className="p-0.5 text-label-tertiary hover:text-label-primary"
        >
          <Chevron size={12} />
        </button>
        {depth === 0 ? (
          <Home size={14} className={selected ? "text-accent" : "text-label-secondary"} />
        ) : (
          <Folder size={14} className={selected ? "text-accent" : "text-system-blue"} />
        )}
        <span className="type-footnote truncate flex-1">{node.name}</span>
        {node.loading && (
          <span className="type-caption-2 text-label-tertiary">…</span>
        )}
      </div>

      {node.expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <TreeNodeView
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              isForbidden={isForbidden}
              onSelect={onSelect}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Tree update helper ──

function updateNode(
  node: TreeNode,
  targetPath: string,
  updater: (n: TreeNode) => TreeNode
): TreeNode {
  if (node.path === targetPath) {
    return updater(node);
  }
  if (!node.children) return node;
  return {
    ...node,
    children: node.children.map((c) => updateNode(c, targetPath, updater)),
  };
}
