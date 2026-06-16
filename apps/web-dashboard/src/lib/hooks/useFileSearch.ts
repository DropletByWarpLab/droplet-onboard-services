"use client";

import { useEffect, useRef, useState } from "react";
import { searchFiles } from "../api";
import { translateError } from "../friendly-errors";
import type { FileEntryInfo } from "../types";

/**
 * Debounced search hook. Consumers pass the live query string and receive
 * the latest results with loading/error state. Queries shorter than 2 chars
 * are treated as empty.
 */
export function useFileSearch(query: string, debounceMs = 300) {
  const [items, setItems] = useState<FileEntryInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setItems([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;

    const handle = setTimeout(async () => {
      try {
        const results = await searchFiles(trimmed);
        if (!ctrl.signal.aborted) {
          setItems(results);
          setIsLoading(false);
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setError(translateError(err, "files"));
          setItems([]);
          setIsLoading(false);
        }
      }
    }, debounceMs);

    return () => {
      clearTimeout(handle);
      ctrl.abort();
    };
  }, [query, debounceMs]);

  return { items, isLoading, error };
}
