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
import { ShellPage } from "@/components/shell/ShellPage";

export default function FavoritesPage() {
  const router = useRouter();
  const { items, isLoading, error, refresh } = useFavorites();
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
    <ShellPage
      icon={<Star size={15} />}
      label="Favorites"
      title="Favorites"
      sub="Files and folders you've marked as favorites for quick access."
      actions={
        <Link href="/files" className="btn ghost" aria-label="Back to files">
          <ArrowLeft size={15} />
          Files
        </Link>
      }
    >
      {/* WARP-1555: `error` is forwarded so a failed fetch renders as a
          failure with a retry — never as "No favorites yet", which would
          tell the user they had un-starred everything. */}
      <FileListSimple
        files={items}
        isLoading={isLoading}
        error={error}
        errorTitle="We couldn't load your favorites"
        errorDescription="The box didn't answer when we asked for your starred files. Your favorites are still saved — try again in a moment."
        onRetry={() => refresh()}
        emptyIcon={Star}
        emptyTitle="No favorites yet"
        emptyDescription="Click the star icon next to any file to add it here."
        showLocation
        onOpen={handleOpen}
        onDownload={handleDownload}
        onRemove={handleUnfavorite}
        removeTooltip="Remove from favorites"
      />
    </ShellPage>
  );
}
