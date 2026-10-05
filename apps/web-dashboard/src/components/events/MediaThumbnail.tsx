"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";

export function MediaThumbnail(props: {
  src: string;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!props.src || failedSrc === props.src) {
    return (
      <div className="flex h-full min-h-32 w-full flex-col items-center justify-center gap-2 text-[color:var(--text-muted)]" role="img" aria-label={`${props.alt}: thumbnail unavailable`}>
        <ImageOff size={24} aria-hidden="true" />
        <span className="type-caption-1">Thumbnail unavailable</span>
      </div>
    );
  }
  return <img {...props} onError={() => setFailedSrc(props.src)} />;
}
