"use client";

import { TrashView } from "@/components/FileManager/TrashView";
import { useTrash } from "@/lib/hooks/useTrash";
import { useSpaceAttribution } from "@/lib/hooks/useSpaces";
import { useToast } from "@/components/Toast";
import {
  restoreTrashItem,
  deleteTrashItem,
  emptyTrash,
} from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";

export default function TrashPage() {
  const { items, isLoading, error, refresh } = useTrash();
  // WARP-1549 — a deleted item's "Original location" is a home-relative
  // folder, which says nothing about which library it came out of. The
  // resolver reads that off the same space list the browser uses.
  const attribution = useSpaceAttribution();
  const { toast } = useToast();

  const handleRestore = async (name: string) => {
    try {
      await restoreTrashItem(name);
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
    }
  };

  const handleDeleteForever = async (name: string) => {
    try {
      await deleteTrashItem(name);
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
    }
  };

  const handleEmpty = async () => {
    try {
      await emptyTrash();
      await refresh();
    } catch (err) {
      toast(translateError(err, "files"));
    }
  };

  // WARP-1555: `error` decides between "we couldn't load your trash"
  // (retryable), "trash isn't available on this Droplet" (backend 501) and the
  // genuine "Trash is empty".
  return (
    <TrashView
      items={items}
      isLoading={isLoading}
      error={error}
      onRetry={() => refresh()}
      spaceLabel={(item) => attribution.label(item.originalLocation)}
      locationLabel={(item) => attribution.folderLocation(item.originalLocation)}
      onRestore={handleRestore}
      onDeleteForever={handleDeleteForever}
      onEmpty={handleEmpty}
    />
  );
}
