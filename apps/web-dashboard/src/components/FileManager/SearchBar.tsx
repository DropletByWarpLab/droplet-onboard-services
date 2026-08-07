"use client";

import { useState, useRef, useEffect } from "react";
import { Search, X, Loader2, Sparkles, Type } from "lucide-react";
import { useFileSearch } from "@/lib/hooks/useFileSearch";
import {
  searchFileContent,
  fetchSearchStatus,
  type SemanticSearchResult,
  type SearchReadinessStatus,
} from "@/lib/api";
import { Thumbnail } from "./Thumbnail";
import { translateError } from "@/lib/friendly-errors";
import type { FileEntryInfo } from "@/lib/types";

interface SearchBarProps {
  onPickResult: (file: FileEntryInfo) => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Persistent search input shown in the files toolbar. Results appear in a
 * floating popover anchored to the input. Clicking a result fires `onPickResult`
 * so the parent page can navigate to the file's parent directory and select it.
 *
 * Implements keyboard nav (↑↓Enter Esc) and click-outside dismissal. The fetch
 * itself is debounced inside `useFileSearch`, so typing doesn't thrash the API.
 */
/**
 * Content-search modes share one debounced API path; `filename` uses the
 * legacy Nextcloud name-match hook. WARP-880 / WS-2 surfaces the lexical
 * (`keyword`) and pgvector (`semantic`) engines that already shipped under
 * WARP-286.
 */
type SearchMode = "filename" | "keyword" | "semantic";

export function SearchBar({ onPickResult }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [mode, setMode] = useState<SearchMode>("filename");
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // `keyword` and `semantic` both hit the content-search API; `filename`
  // uses the name-match hook. The `content` flag is the union of the two
  // content modes.
  const isContentMode = mode === "keyword" || mode === "semantic";

  // Filename search (name match)
  const { items: filenameItems, isLoading: filenameLoading, error: filenameError } = useFileSearch(
    isContentMode ? "" : query  // skip filename search when in a content mode
  );

  // Content search (keyword / semantic)
  const [contentItems, setContentItems] = useState<SemanticSearchResult[]>([]);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // WARP-310: readiness probe. The traffic-light pill only renders for
  // Semantic (keyword is lexical-only and works gateway-down), but WARP-1139
  // fires the probe for BOTH content modes: its explicit indexer counts
  // (pendingCount, from FileIndexStatus) drive the honest "still indexing"
  // empty state, which applies to keyword and semantic alike.
  const [readiness, setReadiness] = useState<SearchReadinessStatus | null>(null);
  useEffect(() => {
    if (mode === "filename") {
      setReadiness(null);
      return;
    }
    let cancelled = false;
    fetchSearchStatus().then((s) => {
      if (!cancelled) setReadiness(s);
    });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  // WARP-1139: "no results" is only an honest statement when the indexer has
  // actually looked at the files. If chunks exist for none of them yet, or
  // some files are still pending, say so instead of "no match".
  const pendingCount = readiness?.pendingCount ?? 0;
  const stillIndexing =
    readiness !== null &&
    (readiness.state === "indexing" || pendingCount > 0);

  useEffect(() => {
    if (!isContentMode || query.trim().length < 2) {
      setContentItems([]);
      setContentLoading(false);
      setContentError(null);
      return;
    }
    setContentLoading(true);
    setContentError(null);
    let cancelled = false;
    if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    contentTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchFileContent(query.trim(), 20, mode);
        if (!cancelled) setContentItems(results);
      } catch (err) {
        if (!cancelled) {
          setContentError(translateError(err, "files"));
          setContentItems([]);
        }
      } finally {
        if (!cancelled) setContentLoading(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
      setContentLoading(false);
    };
  }, [query, mode, isContentMode]);

  // Unified result count for keyboard nav and popover visibility.
  // In a content mode we navigate contentItems; otherwise filenameItems.
  const items = filenameItems;
  const resultCount = isContentMode ? contentItems.length : items.length;
  const isLoading = isContentMode ? contentLoading : filenameLoading;
  const error = isContentMode ? contentError : filenameError;
  const showPopover = open && query.trim().length >= 2;

  useEffect(() => {
    setActiveIdx(0);
  }, [items, contentItems]);

  useEffect(() => {
    if (!showPopover) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showPopover]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showPopover || resultCount === 0) {
      if (e.key === "Escape") {
        setQuery("");
        setOpen(false);
        inputRef.current?.blur();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, resultCount - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (isContentMode) {
        const result = contentItems[activeIdx];
        if (result) pickContentResult(result);
      } else {
        const picked = items[activeIdx];
        if (picked) pickResult(picked);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const pickResult = (file: FileEntryInfo) => {
    onPickResult(file);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };

  const pickContentResult = (result: SemanticSearchResult) => {
    const fileName = result.path.split("/").pop() || result.path;
    onPickResult({
      name: fileName,
      path: result.path,
      isDirectory: false,
      size: 0,
      mimeType: null,
      modifiedAt: new Date().toISOString(),
    });
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div ref={containerRef} className="relative w-full max-w-md">
      {/* WARP-1785: the input and the 3-segment mode control share one row.
          Both refuse to shrink below their content (the pills carry
          `whiteSpace: nowrap`), so on a 375px phone the row demanded 516px
          inside a 343px column and pushed the page to 532px wide — the mode
          control's right edge landed 157px off-screen, clipping "Semantic"
          to "Se…". `flex-wrap` lets the pills drop to their own full-width line
          below the input, and that alone is sufficient: `.search` carries
          `min-width: 220px` (droplet-shell.css:207), which fits inside the
          343px mobile column once the row is allowed to break.

          Deliberately NOT adding `min-w-0` to the label. Measured in a browser:
          Tailwind's `.min-w-0` is specificity (0,1,0) and loses to
          `.droplet-shell .search` at (0,2,0), so the computed min-width stays
          220px and the utility is inert — it would read as load-bearing while
          doing nothing.

          Above `sm` the row still fits on one line, so desktop is unchanged. */}
      <div className="relative flex flex-wrap items-center gap-2">
        <label className="search flex-1" style={{ maxWidth: "none" }}>
          <span
            style={{ display: "flex", flexShrink: 0, color: "var(--text-muted)" }}
          >
            {isLoading ? (
              <Loader2 size={15} className="animate-spin" />
            ) : mode === "semantic" ? (
              <Sparkles size={15} />
            ) : mode === "keyword" ? (
              <Type size={15} />
            ) : (
              <Search size={15} />
            )}
          </span>
          <input
            ref={inputRef}
            type="search"
            value={query}
            placeholder="Search files…"
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
          />
          {query && (
            <button
              onClick={() => {
                setQuery("");
                setOpen(false);
                inputRef.current?.focus();
              }}
              className="icon-btn"
              style={{
                width: 26,
                height: 26,
                border: 0,
                background: "transparent",
                flexShrink: 0,
              }}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </label>

        {/* WARP-880 / WS-2 — 3-segment mode control. Filename matches by
            name; Keyword is lexical full-text (works gateway-down); Semantic
            is pgvector meaning-match. The active segment carries the indigo
            accent; the readiness pill only attaches to Semantic. */}
        <div role="radiogroup" aria-label="Search mode" className="pills">
          {(
            [
              { id: "filename", label: "Name", icon: Search, title: "Match by file name" },
              { id: "keyword", label: "Keyword", icon: Type, title: "Full-text keyword search — works without the AI gateway" },
              { id: "semantic", label: "Semantic", icon: Sparkles, title: "Meaning-based search (AI)" },
            ] as const
          ).map((seg) => {
            const Icon = seg.icon;
            const active = mode === seg.id;
            return (
              <button
                key={seg.id}
                role="radio"
                aria-checked={active}
                aria-label={seg.label}
                title={seg.title}
                onClick={() => setMode(seg.id)}
                className={active ? "active" : undefined}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  whiteSpace: "nowrap",
                }}
              >
                <Icon size={12} />
                {seg.label}
                {/* WARP-310: readiness traffic light — semantic only. ARIA-live
                    so screen readers hear the status change, since the visual
                    is just a dot. Keyword is lexical-only and never shows it. */}
                {seg.id === "semantic" && active && readiness && (
                  <span
                    data-testid="search-readiness"
                    data-state={readiness.state}
                    aria-live="polite"
                    aria-label={
                      readiness.state === "ready"
                        ? `AI search ready — ${readiness.indexedCount} indexed`
                        : readiness.state === "indexing"
                          ? "AI search initializing — no files indexed yet"
                          : "AI search unavailable — check indexer"
                    }
                    title={
                      readiness.state === "ready"
                        ? `Searching ${readiness.indexedCount} indexed chunks`
                        : readiness.state === "indexing"
                          ? "Indexer is up but hasn't processed any files yet"
                          : !readiness.gatewayHealthy
                            ? "AI gateway not reachable"
                            : !readiness.pgvectorReady
                              ? "pgvector extension missing"
                              : "AI search unavailable"
                    }
                    className={`inline-block w-1.5 h-1.5 rounded-full ${
                      readiness.state === "ready"
                        ? "bg-system-green"
                        : readiness.state === "indexing"
                          ? "bg-system-orange"
                          : "bg-system-red"
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {showPopover && (
        <div
          className="card absolute left-0 right-0 top-full mt-2 overflow-hidden z-40 max-h-96 overflow-y-auto"
          style={{
            padding: 0,
            background: "var(--glass)",
            backdropFilter: "blur(20px) saturate(150%)",
            WebkitBackdropFilter: "blur(20px) saturate(150%)",
            boxShadow: "var(--lift)",
          }}
        >
          {error && (
            <div className="px-3 py-2 type-footnote text-system-red">{error}</div>
          )}
          {!error && resultCount === 0 && !isLoading && !isContentMode && (
            <div
              className="px-3 py-6 text-center type-footnote"
              style={{ color: "var(--text-muted)" }}
            >
              No results for &ldquo;{query.trim()}&rdquo;
            </div>
          )}
          {/* Filename results (name match) */}
          {!isContentMode && items.map((file, idx) => (
            <button
              key={file.path}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => pickResult(file)}
              className="w-full flex items-center gap-3 px-3 py-2 text-left transition-colors"
              style={{
                background: idx === activeIdx ? "var(--brand-subtle)" : "transparent",
              }}
            >
              <Thumbnail file={file} size={32} />
              <div className="flex-1 min-w-0">
                <p className="type-footnote truncate" style={{ color: "var(--text)" }}>
                  {file.name}
                </p>
                <p
                  className="type-caption-2 truncate"
                  style={{ color: "var(--text-muted)" }}
                >
                  {file.path.replace(/\/[^/]*$/, "") || "/"}
                </p>
              </div>
              <span
                className="type-caption-2"
                style={{ color: "var(--text-muted)" }}
              >
                {formatSize(file.size)}
              </span>
            </button>
          ))}

          {/* Content results (keyword / semantic) — empty-state variants.
              WARP-1139: distinguish "still indexing" (indexer hasn't finished
              looking at the files) from a genuine no-match, so search never
              claims content is absent when it simply wasn't indexed yet. */}
          {isContentMode && !contentLoading && contentItems.length === 0 && !contentError && (
            <div
              data-testid="content-empty-state"
              data-variant={stillIndexing ? "still-indexing" : "no-match"}
              className="px-3 py-6 text-center type-footnote"
              style={{ color: "var(--text-muted)" }}
            >
              {mode === "keyword" ? (
                <Type size={16} className="mx-auto mb-2" style={{ color: "var(--text-faint)" }} />
              ) : (
                <Sparkles size={16} className="mx-auto mb-2" style={{ color: "var(--text-faint)" }} />
              )}
              {stillIndexing ? (
                <>
                  <p>
                    Still indexing
                    {pendingCount > 0
                      ? ` ${pendingCount} file${pendingCount === 1 ? "" : "s"}`
                      : " your files"}
                    …
                  </p>
                  <p className="mt-1 type-caption-2 text-label-quaternary">
                    &ldquo;{query.trim()}&rdquo; may match content that
                    isn&rsquo;t searchable yet — try again shortly.
                  </p>
                </>
              ) : (
                <>No content matches for &ldquo;{query.trim()}&rdquo;</>
              )}
            </div>
          )}
          {isContentMode && contentItems.map((result, idx) => {
            const fileName = result.path.split("/").pop() || result.path;
            const parentDir = result.path.replace(/\/[^/]*$/, "") || "/";
            return (
              <button
                key={`${result.path}-${idx}`}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pickContentResult(result)}
                className="w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors"
                style={{
                  background: idx === activeIdx ? "var(--brand-subtle)" : "transparent",
                }}
              >
                {mode === "keyword" ? (
                  <Type size={14} className="flex-shrink-0 mt-0.5" style={{ color: "var(--brand)" }} />
                ) : (
                  <Sparkles size={14} className="flex-shrink-0 mt-0.5" style={{ color: "var(--brand)" }} />
                )}
                <div className="flex-1 min-w-0">
                  <p className="type-footnote truncate" style={{ color: "var(--text)" }}>
                    {fileName}
                  </p>
                  <p
                    className="type-caption-2 truncate mb-1"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {parentDir}
                  </p>
                  <p
                    className="type-caption-2 line-clamp-2"
                    style={{ color: "var(--text-faint)" }}
                  >
                    {result.text.slice(0, 200)}
                  </p>
                </div>
                <span
                  className="type-caption-2 flex-shrink-0"
                  style={{ color: "var(--brand)" }}
                >
                  {Math.round(result.score * 100)}%
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
