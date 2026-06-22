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

  // WARP-310: readiness probe. Semantic needs the AI gateway, so the
  // green/yellow/red signal only applies there. Keyword is lexical-only and
  // works gateway-down — it never fires the probe or shows the pill.
  const [readiness, setReadiness] = useState<SearchReadinessStatus | null>(null);
  useEffect(() => {
    if (mode !== "semantic") {
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
      <div className="relative flex items-center gap-1">
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-label-tertiary">
            {isLoading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : mode === "semantic" ? (
              <Sparkles size={14} />
            ) : mode === "keyword" ? (
              <Type size={14} />
            ) : (
              <Search size={14} />
            )}
          </div>
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
          className="dp-input type-subheadline !pl-9 !pr-9 !py-2 !min-h-[36px]"
        />
          {query && (
            <button
              onClick={() => {
                setQuery("");
                setOpen(false);
                inputRef.current?.focus();
              }}
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-label-tertiary hover:text-label-primary"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>

        {/* WARP-880 / WS-2 — 3-segment mode control. Filename matches by
            name; Keyword is lexical full-text (works gateway-down); Semantic
            is pgvector meaning-match. The active segment carries the indigo
            accent; the readiness pill only attaches to Semantic. */}
        <div
          role="radiogroup"
          aria-label="Search mode"
          className="flex items-center gap-0.5 p-0.5 rounded-sm bg-surface-secondary"
        >
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
                className={`flex items-center gap-1 px-2 py-1.5 rounded-sm type-caption-1 whitespace-nowrap transition-colors duration-200 ${
                  active
                    ? "bg-accent-subtle text-accent font-medium"
                    : "text-label-tertiary hover:text-label-primary"
                }`}
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
        <div className="absolute left-0 right-0 top-full mt-2 dp-card dp-material overflow-hidden z-40 max-h-96 overflow-y-auto">
          {error && (
            <div className="px-3 py-2 type-footnote text-system-red">{error}</div>
          )}
          {!error && resultCount === 0 && !isLoading && !isContentMode && (
            <div className="px-3 py-6 text-center type-footnote text-label-tertiary">
              No results for &ldquo;{query.trim()}&rdquo;
            </div>
          )}
          {/* Filename results (name match) */}
          {!isContentMode && items.map((file, idx) => (
            <button
              key={file.path}
              onMouseEnter={() => setActiveIdx(idx)}
              onClick={() => pickResult(file)}
              className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                idx === activeIdx
                  ? "bg-accent-subtle"
                  : "hover:bg-surface-secondary"
              }`}
            >
              <Thumbnail file={file} size={32} />
              <div className="flex-1 min-w-0">
                <p className="type-footnote text-label-primary truncate">
                  {file.name}
                </p>
                <p className="type-caption-2 text-label-tertiary truncate">
                  {file.path.replace(/\/[^/]*$/, "") || "/"}
                </p>
              </div>
              <span className="type-caption-2 text-label-tertiary">
                {formatSize(file.size)}
              </span>
            </button>
          ))}

          {/* Content results (keyword / semantic) */}
          {isContentMode && !contentLoading && contentItems.length === 0 && !contentError && (
            <div className="px-3 py-6 text-center type-footnote text-label-tertiary">
              {mode === "keyword" ? (
                <Type size={16} className="mx-auto mb-2 text-label-quaternary" />
              ) : (
                <Sparkles size={16} className="mx-auto mb-2 text-label-quaternary" />
              )}
              No content matches for &ldquo;{query.trim()}&rdquo;
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
                className={`w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                  idx === activeIdx
                    ? "bg-accent-subtle"
                    : "hover:bg-surface-secondary"
                }`}
              >
                {mode === "keyword" ? (
                  <Type size={14} className="text-accent flex-shrink-0 mt-0.5" />
                ) : (
                  <Sparkles size={14} className="text-accent flex-shrink-0 mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="type-footnote text-label-primary truncate">
                    {fileName}
                  </p>
                  <p className="type-caption-2 text-label-tertiary truncate mb-1">
                    {parentDir}
                  </p>
                  <p className="type-caption-2 text-label-quaternary line-clamp-2">
                    {result.text.slice(0, 200)}
                  </p>
                </div>
                <span className="type-caption-2 text-accent flex-shrink-0">
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
