"use client";

import Link from "next/link";
import { ArrowLeft, Trash2 } from "lucide-react";
import { TrashView } from "@/components/FileManager/TrashView";
import { ShellPage } from "@/components/shell/ShellPage";
import { useTrash } from "@/lib/hooks/useTrash";
import { useToast } from "@/components/Toast";
import {
  restoreTrashItem,
  deleteTrashItem,
  emptyTrash,
} from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";

export default function TrashPage() {
  const { items, isLoading, error, refresh } = useTrash();
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

  return (
    <ShellPage
      icon={<Trash2 size={15} />}
      label="Trash"
      title="Trash"
      sub="Deleted files and folders are kept here until you restore them or empty the trash."
      actions={
        <Link href="/files" className="btn ghost" aria-label="Back to files">
          <ArrowLeft size={15} />
          Files
        </Link>
      }
    >
      {/* WARP-1555: `error` decides between "we couldn't load your trash"
          (retryable), "trash isn't available on this Droplet" (backend 501)
          and the genuine "Trash is empty". */}
      <TrashView
        items={items}
        isLoading={isLoading}
        error={error}
        onRetry={() => refresh()}
        onRestore={handleRestore}
        onDeleteForever={handleDeleteForever}
        onEmpty={handleEmpty}
      />
    </ShellPage>
  );
}
