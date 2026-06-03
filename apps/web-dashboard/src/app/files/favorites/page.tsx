"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Star } from "lucide-react";
import { FileListSimple } from "@/components/FileManager/FileListSimple";
import { useFavorites } from "@/lib/hooks/useFavorites";
import { useToast } from "@/components/Toast";
import { getDownloadUrl, toggleFavorite } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";
import type { FileEntryInfo } from "@/lib/types";

export default function FavoritesPage() {
  const router = useRouter();
  const { items, isLoading, refresh } = useFavorites();
  const { toast } = useToast();

  const handleOpen = (file: FileEntryInfo) => {
    // For directories, navigate into them. For files, jump to the parent dir.
    // In a deeper Phase 3 pass we'd open a preview modal here.
    if (file.isDirectory) {
      router.push(`/files?path=${encodeURIComponent(file.path)}`);
    } else {
      const parent = file.path.replace(/\/[^/]*$/, "") || "/";
      router.push(`/files?path=${encodeURIComponent(parent)}`);
    }
  };

  const handleDownload = (file: FileEntryInfo) => {
    const url = getDownloadUrl(file.path);
    authFetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = file.name;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => toast("Download failed"));
  };

  const handleUnfavorite = async (file: FileEntryInfo) => {
    try {
      await toggleFavorite(file.path, false);
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
    }
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/files"
          className="p-1.5 rounded-full text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
          aria-label="Back to files"
        >
          <ArrowLeft size={18} />
        </Link>
        <h1 className="type-large-title text-label-primary">Favorites</h1>
      </div>

      <p className="type-footnote text-label-tertiary mb-4">
        Files and folders you&apos;ve marked as favorites for quick access.
      </p>

      <FileListSimple
        files={items}
        isLoading={isLoading}
        emptyIcon={Star}
        emptyTitle="No favorites yet"
        emptyDescription="Click the star icon next to any file to add it here."
        showLocation
        onOpen={handleOpen}
        onDownload={handleDownload}
        onRemove={handleUnfavorite}
        removeTooltip="Remove from favorites"
      />
    </div>
  );
}
