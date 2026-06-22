"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Folder, FolderPlus, Link as LinkIcon, X, Eye, Star } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { useToast } from "@/components/Toast";
import { BreadcrumbNav } from "@/components/BreadcrumbNav";
import { UploadZone, UploadButton } from "@/components/UploadZone";
import { FileRow } from "@/components/FileManager/FileRow";
import {
  ContextMenu,
  contextMenuIcons,
  type ContextMenuItem,
} from "@/components/FileManager/ContextMenu";
import { SelectionToolbar } from "@/components/FileManager/SelectionToolbar";
import { MoveCopyDialog } from "@/components/FileManager/MoveCopyDialog";
import { VersionHistoryPanel } from "@/components/FileManager/VersionHistoryPanel";
import { SearchBar } from "@/components/FileManager/SearchBar";
import { PreviewPane } from "@/components/FileManager/PreviewPane";
import { DocEditorPanel } from "@/components/FileManager/DocEditorPanel";
import { ShareDialog } from "@/components/FileManager/ShareDialog";
import { StarButton } from "@/components/FileManager/StarButton";
import { Thumbnail } from "@/components/FileManager/Thumbnail";
import { VolumesPanel } from "@/components/FileManager/VolumesPanel";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useFiles } from "@/lib/hooks/useFiles";
import { useFileManager } from "@/lib/hooks/useFileManager";
import { useFavorites } from "@/lib/hooks/useFavorites";
import { useFileRealtime } from "@/lib/hooks/useFileRealtime";
import {
  uploadFiles,
  deleteFile,
  createDirectory,
  getDownloadUrl,
  renameFile,
  bulkDeleteFiles,
  bulkMoveFiles,
  bulkCopyFiles,
} from "@/lib/api";
import { authFetch } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";
import type { FileEntryInfo } from "@/lib/types";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function FilesPage() {
  const searchParams = useSearchParams();
  const initialPath = searchParams?.get("path") ?? "/";
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedFile, setSelectedFile] = useState<FileEntryInfo | null>(null);
  const [previewFile, setPreviewFile] = useState<FileEntryInfo | null>(null);
  // WARP-882: the file currently open in the in-browser editor.
  const [editorFile, setEditorFile] = useState<FileEntryInfo | null>(null);
  const [shareFile, setShareFile] = useState<FileEntryInfo | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: FileEntryInfo;
  } | null>(null);
  const [moveDialog, setMoveDialog] = useState<{
    mode: "move" | "copy";
    paths: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // React to ?path= changes after mount (e.g. Recents page deep-links back in)
  useEffect(() => {
    const p = searchParams?.get("path");
    if (p && p !== currentPath) {
      setCurrentPath(p);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Subscribe to live file events so uploads/renames/etc. from other tabs,
  // the CLI, or native clients show up immediately — no polling.
  useFileRealtime();

  const { files, isLoading, refresh } = useFiles(currentPath);
  const fm = useFileManager(currentPath);
  const { items: favoriteItems, refresh: refreshFavorites } = useFavorites();
  const favoritedPaths = useMemo(
    () => new Set(favoriteItems.map((f) => f.path)),
    [favoriteItems]
  );

  // ── Upload ──
  const handleUpload = useCallback(
    async (fileList: FileList) => {
      setIsUploading(true);
      setError(null);
      setUploadPercent(0);
      const count = fileList.length;
      setUploadProgress(`Uploading ${count} file${count > 1 ? "s" : ""}...`);
      try {
        await uploadFiles(currentPath, fileList, (percent) => {
          setUploadPercent(percent);
        });
        await refresh();
        setUploadProgress(null);
      } catch (err) {
        toast(translateError(err, "files"));
        setUploadProgress(null);
      } finally {
        setIsUploading(false);
        setUploadPercent(0);
      }
    },
    [currentPath, refresh, toast]
  );

  // ── Download ──
  const handleDownload = useCallback(
    (filePath: string) => {
      const url = getDownloadUrl(filePath);
      authFetch(url)
        .then((res) => res.blob())
        .then((blob) => {
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = filePath.split("/").pop() || "download";
          a.click();
          URL.revokeObjectURL(a.href);
        })
        .catch(() => toast("Download failed"));
    },
    [toast]
  );

  const handleBulkDownload = useCallback(() => {
    for (const p of fm.selectedPaths) {
      const file = files.find((f) => f.path === p);
      if (file && !file.isDirectory) handleDownload(p);
    }
  }, [fm.selectedPaths, files, handleDownload]);

  // ── Delete / bulk delete ──
  //
  // Both flows route through <ConfirmDialog>. Single-file delete stores
  // the path string in pendingDeletePath; bulk delete just stores `true`
  // (the paths are already in `fm.selectedPaths`).
  const [pendingDeletePath, setPendingDeletePath] = useState<string | null>(null);
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false);

  const handleDelete = useCallback((filePath: string) => {
    setPendingDeletePath(filePath);
  }, []);

  const performDelete = useCallback(async () => {
    const filePath = pendingDeletePath;
    if (!filePath) return;
    try {
      await deleteFile(filePath);
      if (selectedFile?.path === filePath) setSelectedFile(null);
      fm.clearSelection();
      setPendingDeletePath(null);
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
      throw err;
    }
  }, [pendingDeletePath, selectedFile, refresh, toast, fm]);

  const handleBulkDelete = useCallback(() => {
    if (fm.selectedCount === 0) return;
    setPendingBulkDelete(true);
  }, [fm.selectedCount]);

  const performBulkDelete = useCallback(async () => {
    try {
      const results = await bulkDeleteFiles(fm.selectedPaths);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        toast(`${failed.length} item(s) failed to delete`);
      }
      fm.clearSelection();
      setSelectedFile(null);
      setPendingBulkDelete(false);
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
      throw err;
    }
  }, [fm, refresh, toast]);

  // ── New folder ──
  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;
    const folderPath =
      currentPath === "/"
        ? `/${newFolderName.trim()}`
        : `${currentPath}/${newFolderName.trim()}`;
    try {
      await createDirectory(folderPath);
      setNewFolderName("");
      setShowNewFolder(false);
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
    }
  }, [currentPath, newFolderName, refresh, toast]);

  // ── Share (opens full dialog) ──
  const handleShare = useCallback((file: FileEntryInfo) => {
    setShareFile(file);
  }, []);

  // ── Preview (opens rich preview modal) ──
  const handlePreview = useCallback((file: FileEntryInfo) => {
    if (file.isDirectory) return;
    setPreviewFile(file);
  }, []);

  // ── Rename ──
  const handleRenameCommit = useCallback(
    async (file: FileEntryInfo, newName: string) => {
      try {
        await renameFile(file.path, newName);
        fm.endRename();
        if (selectedFile?.path === file.path) setSelectedFile(null);
        await refresh();
      } catch (err) {
        toast(translateError(err, "files"));
        fm.endRename();
      }
    },
    [fm, selectedFile, refresh, toast]
  );

  // ── Move / copy (bulk via dialog) ──
  const handleMoveCopyConfirm = useCallback(
    async (targetDir: string) => {
      if (!moveDialog) return;
      try {
        if (moveDialog.mode === "move") {
          const results = await bulkMoveFiles(moveDialog.paths, targetDir);
          const failed = results.filter((r) => !r.ok);
          if (failed.length > 0) toast(`${failed.length} move(s) failed`);
        } else {
          const results = await bulkCopyFiles(moveDialog.paths, targetDir);
          const failed = results.filter((r) => !r.ok);
          if (failed.length > 0) toast(`${failed.length} copy(s) failed`);
        }
        fm.clearSelection();
        setMoveDialog(null);
        await refresh();
      } catch (err) {
        toast(translateError(err, "files"));
      }
    },
    [moveDialog, fm, refresh, toast]
  );

  const handlePasteClipboard = useCallback(async () => {
    if (!fm.clipboard) return;
    try {
      if (fm.clipboard.mode === "cut") {
        const results = await bulkMoveFiles(fm.clipboard.paths, currentPath);
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) toast(`${failed.length} move(s) failed`);
      } else {
        const results = await bulkCopyFiles(fm.clipboard.paths, currentPath);
        const failed = results.filter((r) => !r.ok);
        if (failed.length > 0) toast(`${failed.length} copy(s) failed`);
      }
      fm.clearClipboard();
      fm.clearSelection();
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
    }
  }, [fm, currentPath, refresh, toast]);

  // ── Row click / open ──
  const handleRowSelect = useCallback(
    (file: FileEntryInfo, e: React.MouseEvent) => {
      const isCtrlOrMeta = e.ctrlKey || e.metaKey;
      const isShift = e.shiftKey;
      const mode = isShift ? "range" : isCtrlOrMeta ? "toggle" : "replace";
      fm.toggleSelection(file.path, mode, files);

      if (!isCtrlOrMeta && !isShift && !file.isDirectory) {
        setSelectedFile(file);
      }
    },
    [fm, files]
  );

  const handleRowOpen = useCallback((file: FileEntryInfo) => {
    if (file.isDirectory) {
      setCurrentPath(file.path);
      fm.clearSelection();
    } else {
      setSelectedFile(file);
    }
  }, [fm]);

  // ── Context menu ──
  const handleRowContextMenu = useCallback(
    (file: FileEntryInfo, x: number, y: number) => {
      // If the row isn't already part of selection, make it the only selected item
      if (!fm.isSelected(file.path)) {
        fm.selectOnly(file.path);
      }
      setContextMenu({ x, y, file });
    },
    [fm]
  );

  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    const file = contextMenu.file;
    const selectedCount = Math.max(fm.selectedCount, 1);
    const isSingle = selectedCount === 1;

    return [
      {
        label: file.isDirectory ? "Open" : "Preview",
        icon: contextMenuIcons.Open,
        disabled: !isSingle,
        onClick: () => (file.isDirectory ? handleRowOpen(file) : handlePreview(file)),
      },
      {
        label: "Download",
        icon: contextMenuIcons.Download,
        disabled: file.isDirectory,
        onClick: () => handleDownload(file.path),
      },
      { separator: true },
      {
        label: "Rename",
        icon: contextMenuIcons.Rename,
        disabled: !isSingle,
        onClick: () => fm.beginRename(file.path),
      },
      {
        label: `Cut${isSingle ? "" : ` (${selectedCount})`}`,
        icon: contextMenuIcons.Cut,
        onClick: () => fm.cut(),
      },
      {
        label: `Copy${isSingle ? "" : ` (${selectedCount})`}`,
        icon: contextMenuIcons.Copy,
        onClick: () => fm.copy(),
      },
      {
        label: `Move to…`,
        icon: contextMenuIcons.Cut,
        onClick: () =>
          setMoveDialog({
            mode: "move",
            paths: fm.selectedCount > 0 ? fm.selectedPaths : [file.path],
          }),
      },
      {
        label: `Copy to…`,
        icon: contextMenuIcons.Copy,
        onClick: () =>
          setMoveDialog({
            mode: "copy",
            paths: fm.selectedCount > 0 ? fm.selectedPaths : [file.path],
          }),
      },
      { separator: true },
      {
        label: "Share link",
        icon: contextMenuIcons.Share,
        disabled: !isSingle,
        onClick: () => handleShare(file),
      },
      {
        label: "Delete",
        icon: contextMenuIcons.Delete,
        destructive: true,
        onClick: () => {
          if (fm.selectedCount > 1) {
            void handleBulkDelete();
          } else {
            void handleDelete(file.path);
          }
        },
      },
    ];
  }, [
    contextMenu,
    fm,
    handleRowOpen,
    handlePreview,
    handleDownload,
    handleShare,
    handleDelete,
    handleBulkDelete,
  ]);

  // ── Selection toolbar actions ──
  const forbiddenPrefixes = useMemo(
    () => (moveDialog ? moveDialog.paths : []),
    [moveDialog]
  );

  const selectionLabels = useMemo(() => {
    if (!moveDialog) return [];
    return moveDialog.paths.map((p) => p.split("/").pop() || p);
  }, [moveDialog]);

  // ShellPage header action slot: New Folder + Upload. The file-system
  // BreadcrumbNav stays BELOW the header — it's intra-page navigation
  // (path within Files), distinct from the page-level "Files" header.
  const filesActions = (
    <>
      <button
        onClick={() => setShowNewFolder(true)}
        className="btn ghost"
        type="button"
      >
        <FolderPlus size={14} />
        <span className="hidden sm:inline">New folder</span>
      </button>
      <UploadButton onClick={() => fileInputRef.current?.click()} />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) handleUpload(e.target.files);
          e.target.value = "";
        }}
      />
    </>
  );

  return (
    <ShellPage
      icon={<Folder size={15} />}
      label="Files"
      title="Files"
      actions={filesActions}
    >
      {/* Search bar */}
      <div className="mb-4">
        <SearchBar
          onPickResult={(file) => {
            if (file.isDirectory) {
              setCurrentPath(file.path);
            } else {
              // Jump to parent dir and mark the file selected
              const parent = file.path.replace(/\/[^/]*$/, "") || "/";
              setCurrentPath(parent);
              setSelectedFile(file);
            }
          }}
        />
      </div>

      {/* Breadcrumbs */}
      <div className="mb-4">
        <BreadcrumbNav path={currentPath} onNavigate={setCurrentPath} />
      </div>

      {/* Volumes — only on root so it doesn't dominate deep folder views */}
      {currentPath === "/" && <VolumesPanel />}

      {/* New folder dialog */}
      {showNewFolder && (
        <div className="card flex items-center gap-2 mb-4" style={{ padding: 12 }}>
          <input
            autoFocus
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreateFolder();
              if (e.key === "Escape") setShowNewFolder(false);
            }}
            placeholder="Folder name..."
            className="dp-input flex-1"
          />
          <button onClick={handleCreateFolder} className="btn primary" type="button">
            Create
          </button>
          <button
            onClick={() => setShowNewFolder(false)}
            className="btn ghost"
            type="button"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Selection toolbar */}
      <SelectionToolbar
        count={fm.selectedCount}
        canRename={fm.selectedCount === 1}
        hasClipboard={!!fm.clipboard}
        onClear={fm.clearSelection}
        onRename={() => {
          const first = fm.selectedPaths[0];
          if (first) fm.beginRename(first);
        }}
        onCut={fm.cut}
        onCopy={fm.copy}
        onPaste={handlePasteClipboard}
        onMove={() => setMoveDialog({ mode: "move", paths: fm.selectedPaths })}
        onCopyTo={() => setMoveDialog({ mode: "copy", paths: fm.selectedPaths })}
        onDelete={handleBulkDelete}
        onDownload={handleBulkDownload}
      />

      {/* Status messages */}
      {uploadProgress && (
        <div className="mb-4 p-3 bg-accent-subtle border border-accent/20 rounded type-footnote text-accent">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-4 h-4 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            {uploadProgress} {uploadPercent > 0 && `${uploadPercent}%`}
          </div>
          <div className="h-1.5 bg-accent/15 rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-all duration-300 ease-out"
              style={{ width: `${uploadPercent}%` }}
            />
          </div>
        </div>
      )}
      {error && (
        <div className="mb-4 p-3 bg-system-red/10 border border-system-red/20 rounded type-footnote text-system-red flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 hover:opacity-70">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="flex gap-6">
        {/* File list */}
        <div className="flex-1 min-w-0">
          <UploadZone onUpload={handleUpload}>
            <div className="dp-group min-h-[300px]">
              <div className="flex items-center gap-3 px-4 py-2 type-caption-1 text-label-tertiary uppercase tracking-wider">
                <span className="flex-1">Name</span>
                <span className="w-20 text-right hidden sm:block">Size</span>
                <span className="w-32 text-right hidden md:block">Modified</span>
                <span className="w-16" />
              </div>

              {isLoading ? (
                <div className="flex items-center justify-center h-48 text-label-tertiary type-subheadline">
                  Loading...
                </div>
              ) : files.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 text-label-tertiary">
                  <p className="type-subheadline mb-1">This folder is empty</p>
                  <p className="type-caption-1 text-label-quaternary">
                    Drag &amp; drop files here, or click <strong>Upload</strong> above
                  </p>
                </div>
              ) : (
                files.map((file) => (
                  <FileRow
                    key={file.path}
                    file={file}
                    isSelected={fm.isSelected(file.path)}
                    isRenaming={fm.renamingPath === file.path}
                    favoritedPaths={favoritedPaths}
                    onSelect={(e) => handleRowSelect(file, e)}
                    onOpen={() => handleRowOpen(file)}
                    onDownload={() => handleDownload(file.path)}
                    onDelete={() => handleDelete(file.path)}
                    onRename={(name) => handleRenameCommit(file, name)}
                    onCancelRename={fm.endRename}
                    onContextMenu={(x, y) => handleRowContextMenu(file, x, y)}
                    onFavoriteChanged={refreshFavorites}
                  />
                ))
              )}
            </div>
          </UploadZone>
        </div>

        {/* Detail panel */}
        {selectedFile && !selectedFile.isDirectory && (
          <div className="hidden lg:block w-72 flex-shrink-0">
            <div className="card sticky top-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="type-headline text-label-primary truncate flex-1">
                  {selectedFile.name}
                </h3>
                <StarButton
                  path={selectedFile.path}
                  favorited={favoritedPaths.has(selectedFile.path)}
                  onToggle={() => {
                    void refreshFavorites();
                  }}
                  size={16}
                />
                <button
                  onClick={() => setSelectedFile(null)}
                  className="p-1 text-label-tertiary hover:text-label-primary"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Thumbnail preview (if previewable) */}
              <div className="flex justify-center">
                <Thumbnail file={selectedFile} size={140} />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between type-footnote">
                  <span className="text-label-tertiary">Size</span>
                  <span className="text-label-primary">{formatBytes(selectedFile.size)}</span>
                </div>
                <div className="flex justify-between type-footnote">
                  <span className="text-label-tertiary">Type</span>
                  <span className="text-label-primary">{selectedFile.mimeType || "Unknown"}</span>
                </div>
                <div className="flex justify-between type-footnote">
                  <span className="text-label-tertiary">Modified</span>
                  <span className="text-label-primary">
                    {new Date(selectedFile.modifiedAt).toLocaleDateString()}
                  </span>
                </div>
              </div>

              <div className="flex flex-col gap-2 pt-2">
                <button
                  onClick={() => handlePreview(selectedFile)}
                  className="btn ghost sm"
                  type="button"
                >
                  <Eye size={14} />
                  Preview
                </button>
                <button
                  onClick={() => handleShare(selectedFile)}
                  className="btn ghost sm"
                  type="button"
                >
                  <LinkIcon size={14} />
                  Share…
                </button>
              </div>

              {/* Version history */}
              <VersionHistoryPanel
                filePath={selectedFile.path}
                onRestored={() => refresh()}
              />
            </div>
          </div>
        )}
      </div>

      {/* Rich preview modal */}
      {previewFile && (
        <PreviewPane
          file={previewFile}
          onClose={() => setPreviewFile(null)}
          onDownload={() => handleDownload(previewFile.path)}
          onEdit={() => {
            // WARP-882: hand off from preview to the in-browser editor.
            setEditorFile(previewFile);
            setPreviewFile(null);
          }}
        />
      )}

      {/* WARP-882: in-browser editor (OnlyOffice via the docserver engine) */}
      {editorFile && (
        <DocEditorPanel file={editorFile} onClose={() => setEditorFile(null)} />
      )}

      {/* Share dialog */}
      {shareFile && (
        <ShareDialog
          filePath={shareFile.path}
          fileName={shareFile.name}
          onClose={() => setShareFile(null)}
        />
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Move / Copy dialog */}
      {moveDialog && (
        <MoveCopyDialog
          mode={moveDialog.mode}
          selectionLabels={selectionLabels}
          currentDir={currentPath}
          forbiddenPrefixes={forbiddenPrefixes}
          onCancel={() => setMoveDialog(null)}
          onConfirm={handleMoveCopyConfirm}
        />
      )}

      <ConfirmDialog
        open={pendingDeletePath !== null}
        onConfirm={performDelete}
        onCancel={() => setPendingDeletePath(null)}
        title={
          pendingDeletePath
            ? `Delete "${pendingDeletePath.split("/").pop()}"?`
            : "Delete file?"
        }
        description="The file moves to Trash. You can restore it from there until Trash is emptied."
        confirmLabel="Delete"
        variant="destructive"
      />

      <ConfirmDialog
        open={pendingBulkDelete}
        onConfirm={performBulkDelete}
        onCancel={() => setPendingBulkDelete(false)}
        title={`Move ${fm.selectedCount} item${fm.selectedCount > 1 ? "s" : ""} to Trash?`}
        description="The items move to Trash. You can restore them from there until Trash is emptied."
        confirmLabel="Move to Trash"
        variant="destructive"
      />
    </ShellPage>
  );
}
