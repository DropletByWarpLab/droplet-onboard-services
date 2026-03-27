"use client";

import { useCallback, useRef, useState } from "react";
import { FolderPlus } from "lucide-react";
import { BreadcrumbNav } from "@/components/BreadcrumbNav";
import { FileListItem } from "@/components/FileListItem";
import { UploadZone, UploadButton } from "@/components/UploadZone";
import { useFiles } from "@/lib/hooks/useFiles";
import {
  uploadFiles,
  deleteFile,
  createDirectory,
  getDownloadUrl,
} from "@/lib/api";

export default function FilesPage() {
  const [currentPath, setCurrentPath] = useState("/");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { files, isLoading, refresh } = useFiles(currentPath);

  const handleUpload = useCallback(
    async (fileList: FileList) => {
      setIsUploading(true);
      setUploadError(null);
      try {
        await uploadFiles(currentPath, fileList);
        await refresh();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setIsUploading(false);
      }
    },
    [currentPath, refresh]
  );

  const handleDownload = (filePath: string) => {
    window.open(getDownloadUrl(filePath), "_blank");
  };

  const handleDelete = async (filePath: string) => {
    if (!confirm(`Delete "${filePath.split("/").pop()}"?`)) return;
    try {
      await deleteFile(filePath);
      await refresh();
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const handleCreateFolder = async () => {
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
      setUploadError(err instanceof Error ? err.message : "Failed to create folder");
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="type-large-title text-label-primary">Files</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowNewFolder(true)}
            className="dp-btn-secondary type-subheadline !py-2 !px-4 !min-h-[36px]"
          >
            <FolderPlus size={14} />
            New Folder
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
        </div>
      </div>

      {/* Breadcrumbs */}
      <div className="mb-4">
        <BreadcrumbNav path={currentPath} onNavigate={setCurrentPath} />
      </div>

      {/* New folder dialog */}
      {showNewFolder && (
        <div className="flex items-center gap-2 mb-4 p-3 dp-card">
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
          <button onClick={handleCreateFolder} className="dp-btn-primary !min-h-[38px]">
            Create
          </button>
          <button
            onClick={() => setShowNewFolder(false)}
            className="type-subheadline text-accent hover:text-accent-hover px-3 py-2 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Status messages */}
      {isUploading && (
        <div className="mb-4 p-3 bg-accent-subtle border border-accent/20 rounded type-footnote text-accent">
          Uploading files...
        </div>
      )}
      {uploadError && (
        <div className="mb-4 p-3 bg-system-red/10 border border-system-red/20 rounded type-footnote text-system-red flex items-center justify-between">
          <span>{uploadError}</span>
          <button
            onClick={() => setUploadError(null)}
            className="ml-2 text-system-red hover:opacity-70"
          >
            ✕
          </button>
        </div>
      )}

      {/* File list */}
      <UploadZone onUpload={handleUpload}>
        <div className="dp-group min-h-[300px]">
          {/* Column header */}
          <div className="flex items-center gap-3 px-4 py-2 type-caption-1 text-label-tertiary uppercase tracking-wider">
            <span className="flex-1">Name</span>
            <span className="w-20 text-right hidden sm:block">Size</span>
            <span className="w-32 text-right hidden md:block">Modified</span>
            <span className="w-16" />
          </div>

          {/* Content */}
          {isLoading ? (
            <div className="flex items-center justify-center h-48 text-label-tertiary type-subheadline">
              Loading...
            </div>
          ) : files.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-48 text-label-tertiary">
              <p className="type-subheadline">This folder is empty</p>
              <p className="type-caption-1 mt-1">
                Upload files or create a new folder to get started
              </p>
            </div>
          ) : (
            files.map((file) => (
              <FileListItem
                key={file.path}
                file={file}
                onNavigate={setCurrentPath}
                onDownload={handleDownload}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </UploadZone>
    </div>
  );
}
