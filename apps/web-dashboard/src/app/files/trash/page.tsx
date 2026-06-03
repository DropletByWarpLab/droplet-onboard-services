"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { TrashView } from "@/components/FileManager/TrashView";
import { useTrash } from "@/lib/hooks/useTrash";
import { useToast } from "@/components/Toast";
import {
  restoreTrashItem,
  deleteTrashItem,
  emptyTrash,
} from "@/lib/api";
import { translateError } from "@/lib/friendly-errors";

export default function TrashPage() {
  const { items, isLoading, refresh } = useTrash();
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
    <div className="p-6 lg:p-8 max-w-5xl">
      <div className="flex items-center gap-3 mb-6">
        <Link
          href="/files"
          className="p-1.5 rounded-full text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
          aria-label="Back to files"
        >
          <ArrowLeft size={18} />
        </Link>
        <h1 className="type-large-title text-label-primary">Trash</h1>
      </div>

      <p className="type-footnote text-label-tertiary mb-4">
        Deleted files and folders are kept here until you restore them or empty the trash.
      </p>

      <TrashView
        items={items}
        isLoading={isLoading}
        onRestore={handleRestore}
        onDeleteForever={handleDeleteForever}
        onEmpty={handleEmpty}
      />
    </div>
  );
}
