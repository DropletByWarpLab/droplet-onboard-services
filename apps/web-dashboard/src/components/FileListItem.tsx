import {
  Folder,
  File,
  FileText,
  Image,
  Film,
  Music,
  Archive,
  Download,
  Trash2,
} from "lucide-react";
import type { FileEntryInfo } from "@/lib/types";

interface FileListItemProps {
  file: FileEntryInfo;
  onNavigate: (path: string) => void;
  onDownload: (path: string) => void;
  onDelete: (path: string) => void;
}

function getFileIcon(file: FileEntryInfo) {
  if (file.isDirectory) return Folder;
  const mime = file.mimeType ?? "";
  if (mime.startsWith("image/")) return Image;
  if (mime.startsWith("video/")) return Film;
  if (mime.startsWith("audio/")) return Music;
  if (mime.startsWith("text/")) return FileText;
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("gzip"))
    return Archive;
  return File;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function FileListItem({
  file,
  onNavigate,
  onDownload,
  onDelete,
}: FileListItemProps) {
  const Icon = getFileIcon(file);
  const iconColor = file.isDirectory ? "text-system-blue" : "text-label-secondary";

  const handleClick = () => {
    if (file.isDirectory) onNavigate(file.path);
  };

  return (
    <div
      className={`dp-row group hover:bg-surface-secondary/60 transition-colors duration-200 ease-smooth
        ${file.isDirectory ? "cursor-pointer" : ""}`}
      onClick={handleClick}
    >
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <Icon size={18} className={iconColor} />
        <span className="type-callout text-label-primary truncate">
          {file.name}
        </span>
      </div>

      <span className="type-caption-1 text-label-tertiary w-20 text-right hidden sm:block flex-shrink-0">
        {file.isDirectory ? "" : formatSize(file.size)}
      </span>

      <span className="type-caption-1 text-label-tertiary w-32 text-right hidden md:block flex-shrink-0">
        {formatDate(file.modifiedAt)}
      </span>

      <div className="flex items-center gap-0.5 w-16 justify-end flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        {!file.isDirectory && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDownload(file.path);
            }}
            className="p-1.5 rounded-full text-label-tertiary hover:text-accent hover:bg-accent-subtle transition-colors"
            aria-label="Download"
          >
            <Download size={14} />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(file.path);
          }}
          className="p-1.5 rounded-full text-label-tertiary hover:text-system-red hover:bg-system-red/10 transition-colors"
          aria-label="Delete"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
