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
  /**
   * True once this node's children have actually been fetched from the server.
   * Distinct from `children !== undefined`: an optimistic insert (e.g. the new
   * folder created inline) seeds `children` without a real fetch, so we must
   * track "loaded" separately or the lazy-load in `toggleNode` would skip the
   * real listing and hide every server-side sibling. (WARP-938 review.)
   */
  loaded?: boolean;
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

  // WARP-1262 (T10): this tree still only ever browses/creates in the
  // PERSONAL space (`fetchFiles`/`createDirectory` below take no `space`
  // arg) — a space-aware picker is T15's job ("full UI"). Callers must NOT
  // pass a non-personal `space` down to this dialog's `onConfirm` handler
  // without also treating `targetDir` (and the moved/copied paths) as
  // personal-relative; see the Files page's `handleMoveCopyConfirm`.
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
          loaded: true,
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
      // Fetch the real listing the first time a branch is opened. Gated on
      // `loaded` (not `children === undefined`) so an optimistically-inserted
      // child folder doesn't suppress the server fetch. (WARP-938 review.)
      if (!node.loaded) {
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

  // WARP-938 — open the inline new-folder form. Focus is handled by the effect
  // below, which runs after the input is committed to the DOM (a bare
  // requestAnimationFrame can fire before commit under React 18 concurrency).
  const openNewFolder = useCallback(() => {
    setError(null);
    setNewFolderName("");
    setCreatingFolder(true);
  }, []);

  // Focus the name input once it's actually mounted.
  useEffect(() => {
    if (creatingFolder) newFolderInputRef.current?.focus();
  }, [creatingFolder]);

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
    // Reject path separators and `..` segments client-side. Without this a name
    // like `../secret` or `foo/bar` would be joined into the destination path
    // and the server's WebDAV layer would resolve it to a sibling of the target
    // — letting an authenticated user create directories anywhere in their
    // storage. A folder name is a single path segment, never a path. (WARP-938.)
    if (!isValidFolderName(name)) {
      setError("Folder names can't contain “/”, “\\”, or “..”.");
      return;
    }
    const parent = selectedPath || "/";
    // Don't allow creating inside a forbidden destination (same rule the
    // confirm button enforces) — otherwise a user could seed a folder under a
    // prefix they're not allowed to move/copy into. (WARP-938 review.)
    if (isForbidden(parent)) return;
    const folderPath = parent === "/" ? `/${name}` : `${parent}/${name}`;
    const parentWasLoaded = findNode(tree, parent)?.loaded ?? false;
    setFolderSubmitting(true);
    setError(null);
    try {
      await createDirectory(folderPath);
      if (parentWasLoaded) {
        // Parent's listing is already in the tree — optimistically insert the
        // new folder so it appears immediately without a refetch. The new child
        // is `loaded: false` (empty, but a later fetch is harmless).
        setTree((prev) =>
          updateNode(prev, parent, (node) => {
            const existing = node.children ?? [];
            if (existing.some((c) => c.path === folderPath)) return node;
            const child: TreeNode = {
              path: folderPath,
              name,
              children: undefined,
              loaded: false,
            };
            return {
              ...node,
              expanded: true,
              children: [...existing, child].sort((a, b) =>
                a.name.localeCompare(b.name),
              ),
            };
          }),
        );
      } else {
        // Parent was never expanded/fetched. Pull its real listing now (the
        // server already has the new folder) so existing server-side siblings
        // stay visible AND the parent is correctly marked loaded — an
        // optimistic insert here would hide those siblings this session.
        await loadChildren(parent);
      }
      setSelectedPath(folderPath);
      setCreatingFolder(false);
      setNewFolderName("");
    } catch (err) {
      setError(translateError(err, "files"));
    } finally {
      setFolderSubmitting(false);
    }
  }, [newFolderName, selectedPath, isForbidden, tree, loadChildren]);

  const title = mode === "move" ? "Move to…" : "Copy to…";
  const ctaLabel =
    mode === "move" ? "Move here" : "Copy here";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm p-6"
      style={{ background: "var(--scrim)" }}
      onClick={onCancel}
    >
      <div
        className="max-w-lg w-full max-h-[80vh] flex flex-col overflow-hidden"
        style={{
          background: "var(--card-bg)",
          border: "1px solid var(--card-bd)",
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--lift)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3"
          style={{ borderBottom: "1px solid var(--card-bd)" }}
        >
          <div>
            <h3 className="type-headline" style={{ color: "var(--text)" }}>
              {title}
            </h3>
            <p
              className="type-caption-1 mt-0.5 truncate"
              style={{ color: "var(--text-muted)" }}
            >
              {selectionLabels.length === 1
                ? selectionLabels[0]
                : `${selectionLabels.length} items`}
            </p>
          </div>
          <button
            onClick={onCancel}
            className="icon-btn"
            aria-label="Close"
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
        <div
          className="px-3 py-2"
          style={{ borderTop: "1px solid var(--card-bd)" }}
        >
          {creatingFolder ? (
            <div className="flex items-center gap-2">
              <FolderPlus
                size={14}
                className="shrink-0"
                style={{ color: "var(--text-muted)" }}
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
                className="flex-1 min-w-0 px-2 py-1 type-footnote outline-none focus:border-[var(--brand)]"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
              />
              <button
                type="button"
                onClick={() => void handleCreateFolder()}
                disabled={folderSubmitting || !newFolderName.trim()}
                className="type-caption-1 px-2 py-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ color: "var(--brand)" }}
              >
                {folderSubmitting ? "Creating…" : "Create"}
              </button>
              <button
                type="button"
                onClick={cancelNewFolder}
                disabled={folderSubmitting}
                className="type-caption-1 px-1 py-1 transition-colors"
                style={{ color: "var(--text-muted)" }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={openNewFolder}
              className="flex items-center gap-1.5 type-footnote px-1 py-1 transition-colors"
              style={{ color: "var(--brand)" }}
            >
              <FolderPlus size={14} aria-hidden="true" />
              New folder
            </button>
          )}
        </div>

        {/* Error */}
        {error && (
          <div
            className="px-4 py-2 type-footnote"
            style={{
              color: "#ef4444",
              background: "rgba(239,68,68,0.1)",
              borderTop: "1px solid rgba(239,68,68,0.2)",
            }}
          >
            {error}
          </div>
        )}

        {/* Footer */}
        <div
          className="flex items-center justify-between gap-2 px-4 py-3"
          style={{ borderTop: "1px solid var(--card-bd)" }}
        >
          <div
            className="type-caption-1 truncate flex-1 min-w-0"
            style={{ color: "var(--text-muted)" }}
          >
            Target: <span style={{ color: "var(--text)" }}>{selectedPath}</span>
          </div>
          <button
            onClick={onCancel}
            disabled={submitting}
            className="btn ghost"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={submitting || folderSubmitting || isForbidden(selectedPath)}
            className="btn primary"
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
        className={`flex items-center gap-1 py-1.5 pl-1 pr-2 cursor-pointer transition-colors
          ${
            forbidden
              ? "cursor-not-allowed"
              : selected
              ? ""
              : "hover:bg-[var(--hover)]"
          }`}
        style={{
          paddingLeft: depth * 16 + 4,
          borderRadius: "var(--radius-input)",
          ...(forbidden
            ? { color: "var(--text-faint)" }
            : selected
            ? { background: "var(--brand-subtle)", color: "var(--brand)" }
            : { color: "var(--text)" }),
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node);
          }}
          className="p-0.5 transition-colors"
          style={{ color: "var(--text-muted)" }}
        >
          <Chevron size={12} />
        </button>
        {depth === 0 ? (
          <Home
            size={14}
            style={{ color: selected ? "var(--brand)" : "var(--text-muted)" }}
          />
        ) : (
          <Folder size={14} style={{ color: "var(--brand)" }} />
        )}
        {/* WARP-1153: min-w-0 lets the flex item shrink so long folder names
            truncate instead of growing a horizontal scrollbar in the tree. */}
        <span className="type-footnote truncate flex-1 min-w-0">{node.name}</span>
        {node.loading && (
          <span className="type-caption-2" style={{ color: "var(--text-muted)" }}>
            …
          </span>
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

// ── Folder-name validation ──

/**
 * A folder name must be a single path segment. Reject anything containing a
 * forward/back slash or that is exactly "." / ".." (which would either escape
 * the target via WebDAV path resolution or be a no-op). Embedded dots in an
 * otherwise-normal name (e.g. "report.v2") are fine. (WARP-938 security review.)
 */
function isValidFolderName(name: string): boolean {
  if (name.includes("/") || name.includes("\\")) return false;
  if (name === "." || name === "..") return false;
  return true;
}

// ── Tree lookup helper ──

function findNode(node: TreeNode, targetPath: string): TreeNode | undefined {
  if (node.path === targetPath) return node;
  if (!node.children) return undefined;
  for (const child of node.children) {
    const found = findNode(child, targetPath);
    if (found) return found;
  }
  return undefined;
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
