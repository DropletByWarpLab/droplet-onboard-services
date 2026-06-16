"use client";

import useSWR from "swr";
import { fetchToolCatalog } from "../api";
import type { ToolCatalogResponse } from "../types";

/**
 * WARP-555 — the read-only tool capability catalog for `/tools`.
 *
 * The catalog is effectively static (it changes only when the Droplet
 * ships a new tools-core build), so we don't poll aggressively — a long
 * refresh interval plus SWR's revalidate-on-focus keeps it fresh without
 * hammering the orchestrator. The hook surfaces the empty arrays as the
 * loading/empty default so the page never has to null-check.
 */
export function useToolCatalog() {
  const { data, error, isLoading, mutate } = useSWR<ToolCatalogResponse>(
    "/api/llm/tools/catalog",
    fetchToolCatalog,
    {
      // The capability set rarely changes; 10 min is plenty.
      refreshInterval: 600_000,
    },
  );

  return {
    tools: data?.tools ?? [],
    domains: data?.domains ?? [],
    isLoading,
    error: error as Error | undefined,
    refresh: mutate,
  };
}
