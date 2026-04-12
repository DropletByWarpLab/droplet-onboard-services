"use client";

import { useState } from "react";
import {
  File,
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  Archive,
  Folder,
} from "lucide-react";
import { getThumbnailUrl } from "@/lib/api";
import type { FileEntryInfo } from "@/lib/types";

interface ThumbnailProps {
  file: FileEntryInfo;
  size?: number;
  className?: string;
}

/**
 * Lazy-loaded thumbnail for a file. Falls back to the appropriate Lucide mime
 * icon when Nextcloud can't produce a preview (e.g., large PDFs, text files,
 * or unsupported formats).
 *
 * Uses a skeleton background while the image is loading to avoid the flash
 * of the icon before the preview pixels arrive.
 */
export function Thumbnail({ file, size = 48, className = "" }: ThumbnailProps) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  const mime = file.mimeType ?? "";
  const supportsPreview =
    !file.isDirectory &&
    (mime.startsWith("image/") ||
      mime.startsWith("video/") ||
      mime === "application/pdf");

  if (file.isDirectory) {
    return (
      <Folder
        size={size * 0.6}
        className={`text-system-blue ${className}`}
      />
    );
  }

  if (!supportsPreview || errored) {
    return <FallbackIcon mime={mime} size={size * 0.55} className={className} />;
  }

  return (
    <div
      className={`relative overflow-hidden rounded bg-surface-secondary ${className}`}
      style={{ width: size, height: size }}
    >
      {!loaded && (
        <div className="absolute inset-0 animate-shimmer" />
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={getThumbnailUrl(file.path, size * 2, size * 2)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        onError={() => setErrored(true)}
        className={`w-full h-full object-cover transition-opacity duration-200 ${
          loaded ? "opacity-100" : "opacity-0"
        }`}
      />
    </div>
  );
}

function FallbackIcon({
  mime,
  size,
  className,
}: {
  mime: string;
  size: number;
  className: string;
}) {
  let Icon: typeof File = File;
  let color = "text-label-secondary";

  if (mime.startsWith("image/")) {
    Icon = ImageIcon;
    color = "text-system-blue";
  } else if (mime.startsWith("video/")) {
    Icon = Film;
    color = "text-system-red";
  } else if (mime.startsWith("audio/")) {
    Icon = Music;
    color = "text-system-green";
  } else if (mime.startsWith("text/") || mime === "application/pdf") {
    Icon = FileText;
    color = "text-system-orange";
  } else if (
    mime.includes("zip") ||
    mime.includes("tar") ||
    mime.includes("gzip")
  ) {
    Icon = Archive;
  }

  return <Icon size={size} className={`${color} ${className}`} />;
}
