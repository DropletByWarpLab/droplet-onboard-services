"use client";

import { useState, useRef, useEffect } from "react";
import { Search, X, Loader2, Sparkles } from "lucide-react";
import { useFileSearch } from "@/lib/hooks/useFileSearch";
import { searchFileContent, type SemanticSearchResult } from "@/lib/api";
import { Thumbnail } from "./Thumbnail";
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
export function SearchBar({ onPickResult }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [semantic, setSemantic] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filename search (non-semantic)
  const { items: filenameItems, isLoading: filenameLoading, error: filenameError } = useFileSearch(
    semantic ? "" : query  // skip filename search when in semantic mode
  );

  // Semantic content search
  const [semanticItems, setSemanticItems] = useState<SemanticSearchResult[]>([]);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const semanticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!semantic || query.trim().length < 2) {
      setSemanticItems([]);
      setSemanticLoading(false);
      setSemanticError(null);
      return;
    }
    setSemanticLoading(true);
    setSemanticError(null);
    if (semanticTimerRef.current) clearTimeout(semanticTimerRef.current);
    semanticTimerRef.current = setTimeout(async () => {
      try {
        const results = await searchFileContent(query.trim());
        setSemanticItems(results);
      } catch (err) {
        setSemanticError(err instanceof Error ? err.message : "Search failed");
        setSemanticItems([]);
      } finally {
        setSemanticLoading(false);
      }
    }, 500); // longer debounce for semantic (more expensive)
    return () => {
      if (semanticTimerRef.current) clearTimeout(semanticTimerRef.current);
    };
  }, [query, semantic]);

  // Unified result count for keyboard nav and popover visibility.
  // In semantic mode we navigate semanticItems; otherwise filenameItems.
  const items = filenameItems;
  const resultCount = semantic ? semanticItems.length : items.length;
  const isLoading = semantic ? semanticLoading : filenameLoading;
  const error = semantic ? semanticError : filenameError;
  const showPopover = open && query.trim().length >= 2;

  useEffect(() => {
    setActiveIdx(0);
  }, [items, semanticItems]);

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
      if (semantic) {
        const result = semanticItems[activeIdx];
        if (result) pickSemanticResult(result);
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

  const pickSemanticResult = (result: SemanticSearchResult) => {
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
            ) : semantic ? (
              <Sparkles size={14} />
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

        {/* Semantic toggle */}
        <button
          onClick={() => setSemantic((prev) => !prev)}
          title={semantic ? "Switch to filename search" : "Switch to semantic (AI) search"}
          className={`flex items-center gap-1.5 px-2.5 py-2 rounded-sm type-caption-1 whitespace-nowrap transition-colors ${
            semantic
              ? "bg-accent-subtle text-accent font-medium"
              : "bg-surface-secondary text-label-tertiary hover:text-label-primary"
          }`}
        >
          <Sparkles size={12} />
          {semantic ? "Semantic" : "AI"}
        </button>
      </div>

      {showPopover && (
        <div className="absolute left-0 right-0 top-full mt-2 dp-card dp-material overflow-hidden z-40 max-h-96 overflow-y-auto">
          {error && (
            <div className="px-3 py-2 type-footnote text-system-red">{error}</div>
          )}
          {!error && resultCount === 0 && !isLoading && !semantic && (
            <div className="px-3 py-6 text-center type-footnote text-label-tertiary">
              No results for &ldquo;{query.trim()}&rdquo;
            </div>
          )}
          {/* Filename results (non-semantic) */}
          {!semantic && items.map((file, idx) => (
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

          {/* Semantic results */}
          {semantic && !semanticLoading && semanticItems.length === 0 && !semanticError && (
            <div className="px-3 py-6 text-center type-footnote text-label-tertiary">
              <Sparkles size={16} className="mx-auto mb-2 text-label-quaternary" />
              No content matches for &ldquo;{query.trim()}&rdquo;
            </div>
          )}
          {semantic && semanticItems.map((result, idx) => {
            const fileName = result.path.split("/").pop() || result.path;
            const parentDir = result.path.replace(/\/[^/]*$/, "") || "/";
            return (
              <button
                key={`${result.path}-${idx}`}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => pickSemanticResult(result)}
                className={`w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors ${
                  idx === activeIdx
                    ? "bg-accent-subtle"
                    : "hover:bg-surface-secondary"
                }`}
              >
                <Sparkles size={14} className="text-accent flex-shrink-0 mt-0.5" />
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
