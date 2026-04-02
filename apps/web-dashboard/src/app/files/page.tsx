"use client";

import { useCallback, useRef, useState } from "react";
import { FolderPlus, Link as LinkIcon, X, Copy, Check, Eye } from "lucide-react";
import { useToast } from "@/components/Toast";
import { BreadcrumbNav } from "@/components/BreadcrumbNav";
import { FileListItem } from "@/components/FileListItem";
import { UploadZone, UploadButton } from "@/components/UploadZone";
import { useFiles } from "@/lib/hooks/useFiles";
import {
  uploadFiles,
  deleteFile,
  createDirectory,
  getDownloadUrl,
  createShareLink,
} from "@/lib/api";
import { authFetch } from "@/lib/auth";
import type { FileEntryInfo } from "@/lib/types";

export default function FilesPage() {
  const [currentPath, setCurrentPath] = useState("/");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadProgress, setUploadProgress] = useState<string | null>(null);
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [selectedFile, setSelectedFile] = useState<FileEntryInfo | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewType, setPreviewType] = useState<"text" | "image" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { files, isLoading, refresh } = useFiles(currentPath);

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
        toast(err instanceof Error ? err.message : "Upload failed");
        setUploadProgress(null);
      } finally {
        setIsUploading(false);
        setUploadPercent(0);
      }
    },
    [currentPath, refresh]
  );

  const handleDownload = (filePath: string) => {
    const url = getDownloadUrl(filePath);
    // Cookie is sent automatically with same-origin credentials
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
  };

  const handleDelete = async (filePath: string) => {
    if (!confirm(`Delete "${filePath.split("/").pop()}"?`)) return;
    try {
      await deleteFile(filePath);
      if (selectedFile?.path === filePath) setSelectedFile(null);
      await refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Delete failed");
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
      toast(err instanceof Error ? err.message : "Failed to create folder");
    }
  };

  const handleShare = async (filePath: string) => {
    try {
      const share = await createShareLink(filePath);
      setShareUrl(share.url);
      setCopied(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to create share link");
    }
  };

  const handleCopyShare = () => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handlePreview = (file: FileEntryInfo) => {
    const ext = file.name.split(".").pop()?.toLowerCase();
    const imageExts = ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"];
    const textExts = ["txt", "md", "json", "yaml", "yml", "toml", "csv", "log", "xml", "html", "css", "js", "ts", "py", "sh"];

    if (imageExts.includes(ext || "")) {
      setPreviewType("image");
      setPreviewContent(getDownloadUrl(file.path));
      setSelectedFile(file);
    } else if (textExts.includes(ext || "")) {
      setPreviewType("text");
      setPreviewContent(null);
      setSelectedFile(file);

      // Fetch text content
      const url = getDownloadUrl(file.path);
      authFetch(url)
        .then((res) => res.text())
        .then((text) => setPreviewContent(text.slice(0, 10000)))
        .catch(() => setPreviewContent("Failed to load preview"));
    }
  };

  const handleFileClick = (file: FileEntryInfo) => {
    if (file.isDirectory) {
      setCurrentPath(file.path);
    } else {
      setSelectedFile(file);
      setShareUrl(null);
    }
  };

  function formatBytes(bytes: number): string {
    if (bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl">
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
          <button onClick={() => setError(null)} className="ml-2 hover:opacity-70"><X size={14} /></button>
        </div>
      )}

      <div className="flex gap-6">
        {/* File list */}
        <div className="flex-1 min-w-0">
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
                  <p className="type-subheadline mb-1">This folder is empty</p>
                  <p className="type-caption-1 text-label-quaternary">
                    Drag &amp; drop files here, or click <strong>Upload</strong> above
                  </p>
                </div>
              ) : (
                files.map((file) => (
                  <FileListItem
                    key={file.path}
                    file={file}
                    isSelected={selectedFile?.path === file.path}
                    onNavigate={setCurrentPath}
                    onSelect={() => handleFileClick(file)}
                    onDownload={handleDownload}
                    onDelete={handleDelete}
                  />
                ))
              )}
            </div>
          </UploadZone>
        </div>

        {/* Detail panel */}
        {selectedFile && !selectedFile.isDirectory && (
          <div className="hidden lg:block w-72 flex-shrink-0">
            <div className="dp-card p-4 sticky top-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="type-headline text-label-primary truncate flex-1">
                  {selectedFile.name}
                </h3>
                <button
                  onClick={() => setSelectedFile(null)}
                  className="p-1 text-label-tertiary hover:text-label-primary"
                >
                  <X size={16} />
                </button>
              </div>

              {/* File info */}
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

              {/* Actions */}
              <div className="flex flex-col gap-2 pt-2">
                <button
                  onClick={() => handlePreview(selectedFile)}
                  className="dp-btn-secondary type-footnote !min-h-[36px] !py-1.5"
                >
                  <Eye size={14} />
                  Preview
                </button>
                <button
                  onClick={() => handleShare(selectedFile.path)}
                  className="dp-btn-secondary type-footnote !min-h-[36px] !py-1.5"
                >
                  <LinkIcon size={14} />
                  Share Link
                </button>
              </div>

              {/* Share URL */}
              {shareUrl && (
                <div className="p-2 bg-surface-secondary rounded-sm">
                  <p className="type-caption-1 text-label-tertiary mb-1.5">Share link</p>
                  <div className="flex items-center gap-1.5">
                    <input
                      readOnly
                      value={shareUrl}
                      className="dp-input type-caption-1 flex-1 !py-1.5"
                    />
                    <button
                      onClick={handleCopyShare}
                      className="p-1.5 rounded-sm bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                    >
                      {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Preview modal */}
      {previewContent && previewType && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-6"
          onClick={() => { setPreviewContent(null); setPreviewType(null); }}
        >
          <div
            className="bg-surface-primary rounded-lg max-w-3xl max-h-[80vh] w-full overflow-hidden shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
              <h3 className="type-headline text-label-primary truncate">
                {selectedFile?.name}
              </h3>
              <button
                onClick={() => { setPreviewContent(null); setPreviewType(null); }}
                className="p-1 text-label-tertiary hover:text-label-primary"
              >
                <X size={18} />
              </button>
            </div>
            <div className="overflow-auto max-h-[calc(80vh-56px)] p-4">
              {previewType === "image" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewContent} alt={selectedFile?.name} className="max-w-full mx-auto" />
              ) : (
                <pre className="type-footnote text-label-primary whitespace-pre-wrap font-mono">
                  {previewContent}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
