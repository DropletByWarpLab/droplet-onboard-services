"use client";

/**
 * "Search" tab — semantic search across the indexed file chunks.
 * Submits to `/api/files/knowledge/search`. Results render as a list
 * with a CitationChip for each hit so the surface stays visually
 * aligned with the chat citations.
 *
 * The 503 "search-not-yet-available" response from the orchestrator
 * (when WARP-202's file-search.service hasn't been merged yet) is
 * surfaced here as a friendly placeholder rather than an error toast.
 */

import { useEffect, useState, useTransition } from "react";
import { Search as SearchIcon } from "lucide-react";
import {
  searchKnowledge,
  type KnowledgeSearchHit,
  type SearchKnowledgeResponse,
} from "@/lib/api";
import { CitationChip } from "@/components/CitationChip";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { SourceChannelBadge } from "@/components/SourceChannelBadge";
import { mimeFromPath } from "@/lib/mime-icons";

interface Props {
  initialQuery?: string;
  initialSource?: "nextcloud" | "brain";
  initialSince?: string;
  /** Called whenever the query changes — page wires this to the URL params. */
  onQueryChange?: (q: string) => void;
}

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; hits: KnowledgeSearchHit[] }
  | { kind: "unavailable"; retryAfterSeconds?: number }
  | { kind: "error"; message: string };

export function SearchTab({
  initialQuery = "",
  initialSource,
  initialSince,
  onQueryChange,
}: Props) {
  const [q, setQ] = useState(initialQuery);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [, startTransition] = useTransition();

  // If the URL already carries ?q=..., kick off the initial search on mount
  // so a shared link lands the user on results immediately.
  useEffect(() => {
    if (initialQuery && initialQuery.length >= 2) {
      runSearch(initialQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runSearch(query: string) {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setStatus({ kind: "idle" });
      return;
    }
    setStatus({ kind: "loading" });
    try {
      const result = await searchKnowledge({
        q: trimmed,
        source: initialSource,
        since: initialSince,
      });
      if ("unavailable" in result && result.unavailable) {
        setStatus({
          kind: "unavailable",
          retryAfterSeconds: result.retryAfterSeconds,
        });
        return;
      }
      const ready = result as SearchKnowledgeResponse;
      setStatus({ kind: "ready", hits: ready.hits ?? [] });
    } catch (err) {
      setStatus({ kind: "error", message: (err as Error).message });
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onQueryChange?.(q);
    startTransition(() => runSearch(q));
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="dp-card p-3 flex items-center gap-2">
        <SearchIcon size={16} className="text-label-tertiary flex-shrink-0" />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search across your indexed files…"
          className="
            flex-1 bg-transparent type-subheadline text-label-primary
            placeholder:text-label-tertiary outline-none
          "
          data-testid="knowledge-search-input"
        />
        <button
          type="submit"
          disabled={q.trim().length < 2}
          className="
            type-footnote text-accent px-3 py-1 rounded-md
            hover:bg-accent-subtle disabled:opacity-40 disabled:hover:bg-transparent
          "
        >
          Search
        </button>
      </form>

      {status.kind === "idle" && q.trim().length < 2 && (
        <p className="type-footnote text-label-tertiary px-1">
          Type at least 2 characters to search.
        </p>
      )}

      {status.kind === "loading" && (
        <div className="dp-card p-6 type-footnote text-label-tertiary">
          Searching…
        </div>
      )}

      {status.kind === "unavailable" && (
        <div
          className="dp-card p-6"
          role="status"
          data-testid="knowledge-search-unavailable"
        >
          <p className="type-subheadline text-label-primary">
            Search will be online soon.
          </p>
          <p className="type-footnote text-label-tertiary mt-1">
            The semantic search service hasn&apos;t finished setup yet. We&apos;ll
            light it up automatically — try again in a minute.
          </p>
        </div>
      )}

      {status.kind === "error" && (
        <div role="alert" className="dp-card p-4 type-footnote text-system-red">
          {status.message}
        </div>
      )}

      {status.kind === "ready" && status.hits.length === 0 && (
        <div className="dp-card p-6 text-center" data-testid="knowledge-search-empty">
          <p className="type-subheadline text-label-primary">No matches.</p>
          <p className="type-footnote text-label-tertiary mt-1">
            Try a different query, or check that the file is finished
            indexing.
          </p>
        </div>
      )}

      {status.kind === "ready" && status.hits.length > 0 && (
        <ul className="space-y-2" data-testid="knowledge-search-results">
          {status.hits.map((hit, i) => {
            // WARP-214: feed the chip a derived MIME so the icon matches
            // the file's true type instead of the source-based fallback.
            const mime = mimeFromPath(hit.path);
            return (
              <li key={`${hit.path}-${i}`} className="dp-card p-3">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <CitationChip
                    source={hit.source}
                    path={hit.path}
                    pageNumber={hit.pageNumber}
                    score={hit.score}
                    brainItemId={hit.brainItemId}
                    snippet={hit.snippet}
                    mimeType={mime}
                  />
                  <SourceChannelBadge
                    subtitleSource={hit.metadata?.subtitle_source ?? null}
                    warnings={[]}
                  />
                </div>
                {/* WARP-214: chevron-joined recursion lineage if the hit
                    came from a recursive carrier (zip → email → pdf). */}
                <Breadcrumbs chain={hit.metadata?.chain} />
                <p className="type-caption-1 text-label-secondary line-clamp-3">
                  {hit.snippet}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
