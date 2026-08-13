"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, CalendarSearch, Clock, X } from "lucide-react";
import { FileListSimple } from "@/components/FileManager/FileListSimple";
import { filterByDay, formatDayHeading, localDayKey } from "@/lib/recents-day-filter";
import { useRecents } from "@/lib/hooks/useRecents";
import { useSpaceAttribution } from "@/lib/hooks/useSpaces";
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
  // WARP-1549 — recents span every library the user can reach; without this
  // the whole list reads as though it were all personal.
  const attribution = useSpaceAttribution();
  const { toast } = useToast();
  // WARP-1916 — "what did I touch on July 23": a YYYY-MM-DD local day from
  // the date picker, or null for the default Today/Earlier grouping. The
  // recents list is already fully client-side (one limit-N fetch), so the
  // narrowing happens here, not on the orchestrator.
  const [filterDay, setFilterDay] = useState<string | null>(null);

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

  // WARP-1916: the chosen day's files, boundary at the user's LOCAL midnight
  // (a 23:59 save belongs to that evening, not to the next UTC day).
  const dayFiles = useMemo(
    () => (filterDay ? filterByDay(items, filterDay) : items),
    [items, filterDay]
  );

  // WARP-1549: routes with the row's resolved space, so a recently-edited
  // library file opens in its library instead of the personal space.
  const handleOpen = (file: FileEntryInfo) => {
    router.push(attribution.href(file));
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
        <>
          {/* WARP-1916: jump to a specific day. The picker mirrors the camera
              recordings day picker (same tokens); the active filter reads as
              a dismissable chip so the narrowed state is always visible and
              always one tap from the default grouping. */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <input
              type="date"
              aria-label="Jump to a day"
              value={filterDay ?? ""}
              onChange={(e) => setFilterDay(e.target.value || null)}
              max={localDayKey(new Date().toISOString())}
              className="h-9 px-3 type-subheadline outline-none focus:border-[var(--brand)]"
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            />
            {filterDay && (
              <button
                type="button"
                className="chip on"
                onClick={() => setFilterDay(null)}
                aria-label={`Clear day filter: ${formatDayHeading(filterDay)}`}
              >
                {formatDayHeading(filterDay)}
                <X size={13} />
              </button>
            )}
          </div>
          {filterDay ? (
            dayFiles.length === 0 ? (
              /* Same skeleton as FileListSimple's empty state, plus the reset
                 affordance — an empty DAY must never read as an empty LIST. */
              <div className="card" style={{ padding: 0 }}>
                <div className="empty">
                  <span className="ei">
                    <CalendarSearch size={24} />
                  </span>
                  <p className="eh">No files on {formatDayHeading(filterDay)}</p>
                  <p style={{ maxWidth: "22rem", fontSize: "13px" }}>
                    Nothing in your recent activity was modified that day. Pick
                    another day, or clear the filter to see everything recent.
                  </p>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => setFilterDay(null)}
                    style={{ marginTop: 10 }}
                  >
                    Show all recents
                  </button>
                </div>
              </div>
            ) : (
              <section>
                <h2
                  className="type-footnote font-medium mb-2 px-1"
                  style={{ color: "var(--text-muted)" }}
                >
                  {formatDayHeading(filterDay)}
                </h2>
                <FileListSimple
                  files={dayFiles}
                  isLoading={false}
                  showLocation
                  spaceLabel={(file) => attribution.label(file.path)}
                  locationLabel={(file) => attribution.location(file.path)}
                  onOpen={handleOpen}
                  onDownload={handleDownload}
                />
              </section>
            )
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
                    spaceLabel={(file) => attribution.label(file.path)}
                    locationLabel={(file) => attribution.location(file.path)}
                    onOpen={handleOpen}
                    onDownload={handleDownload}
                  />
                </section>
              ))}
            </div>
          )}
        </>
      )}
    </ShellPage>
  );
}
