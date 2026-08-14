"use client";

/**
 * "Recently indexed" tab — chunked-by-day list of FileContentChunk
 * rows for the authed user. Cards show filename, source badge
 * (Nextcloud / Brain), preview snippet, file-type icon. Cursor-paginated
 * via the orchestrator's `?before=<iso>` cursor.
 *
 * Bucket boundaries match the Files page's Recents tab so the two
 * surfaces feel cohesive: Today / Yesterday / This week / This month
 * / Earlier.
 */

import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  Clock,
  Sparkles,
} from "lucide-react";
import {
  getRecentFiles,
  type KnowledgeChunkItem,
  type RecentKnowledgeResponse,
} from "@/lib/api";
import { iconForMime, mimeFromPath } from "@/lib/mime-icons";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { SourceChannelBadge } from "@/components/SourceChannelBadge";
import { translateError } from "@/lib/friendly-errors";
import { trimDisplayPath } from "./displayPath";
import {
  dedupeByDocument,
  type KnowledgeDocumentItem,
} from "./dedupeByDocument";

const PAGE_SIZE = 50;

const BUCKET_ORDER = [
  "Today",
  "Yesterday",
  "This week",
  "This month",
  "Earlier",
] as const;
type Bucket = (typeof BUCKET_ORDER)[number];

function bucketFor(item: KnowledgeChunkItem, now: Date): Bucket {
  const indexed = new Date(item.indexedAt);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86_400_000);
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
  const monthAgo = new Date(today.getTime() - 30 * 86_400_000);
  if (indexed >= today) return "Today";
  if (indexed >= yesterday) return "Yesterday";
  if (indexed >= weekAgo) return "This week";
  if (indexed >= monthAgo) return "This month";
  return "Earlier";
}

interface Props {
  source?: "nextcloud" | "brain";
}

export function RecentlyIndexedTab({ source }: Props) {
  const [items, setItems] = useState<KnowledgeChunkItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset + reload whenever the source filter flips.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setItems([]);
    setNextBefore(null);
    getRecentFiles({ limit: PAGE_SIZE, source })
      .then((data: RecentKnowledgeResponse) => {
        if (cancelled) return;
        setItems(data.items);
        setNextBefore(data.nextBefore);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // WARP-294: never surface err.message to the user — the
        // orchestrator can emit terse strings like "Failed to fetch
        // recent: 503".
        setError(translateError(err, "knowledge"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  async function loadMore() {
    if (!nextBefore || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await getRecentFiles({
        limit: PAGE_SIZE,
        before: nextBefore,
        source,
      });
      setItems((prev) => [...prev, ...data.items]);
      setNextBefore(data.nextBefore);
    } catch (err) {
      // WARP-294: same translation idiom on the pagination path.
      setError(translateError(err, "knowledge"));
    } finally {
      setLoadingMore(false);
    }
  }

  const grouped = useMemo(() => {
    if (items.length === 0) return [];
    // WARP-1790: the endpoint is chunk-level, so one file that chunked into N
    // pieces used to render as N near-identical cards. Collapse to documents
    // BEFORE bucketing, otherwise a document whose chunks straddle a day
    // boundary would still appear twice — once per bucket.
    const docs = dedupeByDocument(items);
    const now = new Date();
    const map = new Map<Bucket, KnowledgeDocumentItem[]>();
    for (const doc of docs) {
      const key = bucketFor(doc.item, now);
      const arr = map.get(key) ?? [];
      arr.push(doc);
      map.set(key, arr);
    }
    return BUCKET_ORDER.filter((k) => map.has(k)).map((k) => ({
      label: k,
      items: map.get(k)!,
    }));
  }, [items]);

  if (error) {
    // WARP-294: `error` is already a translated string from
    // translateError(., "knowledge"); render it directly. No more
    // raw orchestrator strings get spliced in.
    return (
      <div
        role="alert"
        className="dp-card p-4 type-footnote text-system-red bg-system-red/10"
      >
        {error}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="dp-card p-6 type-footnote text-label-tertiary">
        Loading…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <EmptyKnowledgeState />
    );
  }

  return (
    <div className="space-y-6">
      {grouped.map((group) => (
        <section key={group.label}>
          <h2 className="type-footnote text-label-secondary font-medium mb-2 px-1">
            {group.label}
          </h2>
          <ul className="space-y-2">
            {group.items.map(({ item, chunkCount, duplicateChunkIdx }) => {
              // WARP-214: object-icon set keyed off MIME (Headphones for
              // audio, Film for video, Mail for email, FileArchive for
              // archives, etc.). Falls back to FileText for unknown types.
              const mime = mimeFromPath(item.path);
              const Icon = iconForMime(mime);
              const fileName = item.path.split("/").pop() || item.path;
              const SourceIcon =
                item.source === "brain" ? Sparkles : BookOpen;
              return (
                <li
                  key={item.id}
                  className="dp-card p-3 flex items-start gap-3"
                  data-testid="knowledge-recent-item"
                >
                  <div className="w-8 h-8 rounded-md bg-surface-secondary flex items-center justify-center flex-shrink-0">
                    <Icon size={16} className="text-label-secondary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="type-subheadline text-label-primary truncate">
                        {fileName}
                      </p>
                      <span
                        className={`
                          inline-flex items-center gap-1 px-1.5 py-0.5 rounded
                          type-caption-2 border flex-shrink-0
                          ${
                            item.source === "brain"
                              ? "text-accent border-accent/20 bg-accent-subtle"
                              : "text-label-tertiary border-separator"
                          }
                        `}
                      >
                        <SourceIcon size={10} />
                        {item.source === "brain" ? "Brain" : "Nextcloud"}
                      </span>
                    </div>
                    <p
                      className="type-caption-1 text-label-tertiary truncate"
                      // WARP-294: don't title-attribute the raw server
                      // path either — keep internal Nextcloud layout
                      // (`/admin/files/private/…`) entirely off-screen.
                    >
                      {trimDisplayPath(item.path)}
                    </p>
                    {/* WARP-214: chevron-joined recursion lineage. Renders
                        only when the chunk's metadata.chain is non-empty
                        (~5% of items). */}
                    <Breadcrumbs chain={item.metadata?.chain} />
                    {item.snippet && (
                      <p className="type-caption-1 text-label-secondary mt-1 line-clamp-2">
                        {item.snippet}
                      </p>
                    )}
                    {/* WARP-1790: the chunk count is the information the
                        collapse would otherwise throw away — and it reframes
                        the repeats honestly, as one document the Droplet split
                        for search rather than one it indexed over and over.
                        `duplicateChunkIdx` means the same chunk index arrived
                        twice, which a single indexing pass cannot produce, so
                        that IS real duplicate ingestion and says so. */}
                    {chunkCount > 1 && (
                      <p
                        className="type-caption-2 text-label-tertiary mt-1"
                        data-testid="knowledge-recent-sections"
                      >
                        {duplicateChunkIdx
                          ? `${chunkCount} entries · indexed more than once`
                          : `${chunkCount} sections indexed`}
                      </p>
                    )}
                    {/* WARP-214: source-channel pill — only shows when
                        the channel is "lossy" enough to matter (ASR,
                        OCR, embedded subtitles). */}
                    <div className="mt-1">
                      <SourceChannelBadge
                        subtitleSource={item.metadata?.subtitle_source ?? null}
                        warnings={[]}
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {nextBefore && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={loadMore}
            disabled={loadingMore}
            className="
              type-footnote text-label-secondary px-4 py-2 rounded-lg
              bg-surface-secondary hover:bg-surface-tertiary
              hover:text-label-primary transition-colors disabled:opacity-50
            "
          >
            {loadingMore ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function EmptyKnowledgeState() {
  return (
    <div className="dp-card p-8 text-center" data-testid="knowledge-empty">
      <Clock size={28} className="text-label-quaternary mx-auto mb-3" />
      <p className="type-subheadline text-label-primary">No files indexed yet.</p>
      <p className="type-footnote text-label-tertiary mt-1">
        Drop a file in chat or upload to your Droplet&apos;s Nextcloud at{" "}
        <a href="/files" className="text-accent hover:underline">
          /files
        </a>
        .
      </p>
    </div>
  );
}
