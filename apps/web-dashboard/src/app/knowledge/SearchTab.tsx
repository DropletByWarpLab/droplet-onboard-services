"use client";

/**
 * "Search" tab — semantic search across the indexed file chunks.
 * Submits to `/api/files/knowledge/search`. Results render as a list
 * with a CitationCard for each hit so the surface stays visually
 * aligned with the chat citations and respects the per-chunk anchor
 * (WARP-287 deep-link: PDF page, audio timestamp, email part, ...).
 *
 * The 503 "search-not-yet-available" response from the orchestrator
 * (when WARP-202's file-search.service hasn't been merged yet) is
 * surfaced here as a friendly placeholder rather than an error toast.
 */

import { useEffect, useState, useTransition } from "react";
import { Search as SearchIcon } from "lucide-react";
import type { Anchor } from "@droplet/shared-types";
import {
  searchKnowledge,
  type KnowledgeSearchHit,
  type SearchKnowledgeResponse,
} from "@/lib/api";
import { CitationCard } from "@/components/citations/CitationCard";
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
            // WARP-287: project the wire-shaped hit into the canonical
            // CitationHit DTO. `fileId` falls back to `path` for legacy
            // responses that don't carry `ncFileId` yet; the FileCitation
            // fall-through still produces a working link in that case.
            const mime =
              (typeof hit.mimeType === "string" ? hit.mimeType : null) ??
              mimeFromPath(hit.path);
            const filename = hit.path.split("/").pop() || hit.path;
            const fileId = hit.ncFileId ? String(hit.ncFileId) : hit.path;
            const anchor = (hit.anchor ?? null) as Anchor | null;
            return (
              <li key={`${hit.path}-${i}`} className="dp-card p-3">
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <CitationCard
                    hit={{
                      fileId,
                      filename,
                      mimeType: mime,
                      chunkText: hit.chunkText ?? hit.snippet ?? "",
                      score: hit.score,
                      // WARP-1637: pass the producer's tag through instead of
                      // letting `relevancePct` infer. Inference reads anything
                      // in [0, 1] as a bounded similarity, so an un-normalized
                      // reranker logit of 0.0 rendered as a confident 0% —
                      // the reported defect.
                      scoreKind: hit.scoreKind,
                      anchor,
                    }}
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
