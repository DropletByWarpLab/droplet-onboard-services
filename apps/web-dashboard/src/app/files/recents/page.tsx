"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Clock } from "lucide-react";
import { FileListSimple } from "@/components/FileManager/FileListSimple";
import { useRecents } from "@/lib/hooks/useRecents";
import { useToast } from "@/components/Toast";
import { getDownloadUrl } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import type { FileEntryInfo } from "@/lib/types";
import { ShellPage } from "@/components/shell/ShellPage";

/**
 * Bucket recent files by Today / Yesterday / This week / Earlier.
 * Buckets share the same relative windows as OneDrive / Files.app.
 */
function bucket(file: FileEntryInfo, now: Date): string {
  const mtime = new Date(file.modifiedAt);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
  if (mtime >= today) return "Today";
  if (mtime >= yesterday) return "Yesterday";
  if (mtime >= weekAgo) return "This week";
  return "Earlier";
}

const BUCKET_ORDER = ["Today", "Yesterday", "This week", "Earlier"] as const;

export default function RecentsPage() {
  const router = useRouter();
  const { items, isLoading, error, refresh } = useRecents(50);
  const { toast } = useToast();

  const grouped = useMemo(() => {
    const now = new Date();
    const map = new Map<string, FileEntryInfo[]>();
    for (const item of items) {
      const key = bucket(item, now);
      const arr = map.get(key) ?? [];
      arr.push(item);
      map.set(key, arr);
    }
    return BUCKET_ORDER.filter((k) => map.has(k)).map((k) => ({
      label: k,
      files: map.get(k)!,
    }));
  }, [items]);

  const handleOpen = (file: FileEntryInfo) => {
    if (file.isDirectory) {
      router.push(`/files?path=${encodeURIComponent(file.path)}`);
    } else {
      const parent = file.path.replace(/\/[^/]*$/, "") || "/";
      router.push(`/files?path=${encodeURIComponent(parent)}`);
    }
  };

  const handleDownload = (file: FileEntryInfo) => {
    authFetch(getDownloadUrl(file.path))
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

  return (
    <ShellPage
      icon={<Clock size={15} />}
      label="Recents"
      title="Recents"
      sub="Files you've modified recently, grouped by time."
      actions={
        <Link href="/files" className="btn ghost" aria-label="Back to files">
          <ArrowLeft size={15} />
          Files
        </Link>
      }
    >
      {/* WARP-1555: with nothing to group, a single FileListSimple owns all
          three degenerate states — error (with retry), loading, empty — so a
          failed fetch can never masquerade as "No recent files". */}
      {items.length === 0 ? (
        <FileListSimple
          files={[]}
          isLoading={isLoading}
          error={error}
          errorTitle="We couldn't load your recent files"
          errorDescription="The box didn't answer when we asked what you'd worked on lately. Your files are untouched — try again in a moment."
          onRetry={() => refresh()}
          emptyIcon={Clock}
          emptyTitle="No recent files"
          emptyDescription="Upload or modify a file and it'll show up here."
          onOpen={handleOpen}
        />
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <section key={group.label}>
              <h2
                className="type-footnote font-medium mb-2 px-1"
                style={{ color: "var(--text-muted)" }}
              >
                {group.label}
              </h2>
              <FileListSimple
                files={group.files}
                isLoading={false}
                showLocation
                onOpen={handleOpen}
                onDownload={handleDownload}
              />
            </section>
          ))}
        </div>
      )}
    </ShellPage>
  );
}
