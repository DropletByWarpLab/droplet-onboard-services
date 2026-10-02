"use client";

import useSWR from "swr";
import { fetchRuntimeTools } from "../api";
import type { RuntimeToolsResponse } from "../types";

/**
 * WARP-2900 (ADR-056 slice H4) — the runtime half of the tool universe for
 * `/tools`: promoted extensions and connected servers. Read-only; every row
 * is a name, where it came from, and what dispatch does with a call.
 *
 * Changes when an owner promotes, disables or reviews something, which is
 * rare — the same slow refresh as the compiled catalog is plenty.
 */
export function useRuntimeTools() {
  const { data, error, isLoading } = useSWR<RuntimeToolsResponse>(
    "/api/llm/tools/runtime",
    fetchRuntimeTools,
    { refreshInterval: 600_000 },
  );
  return {
    tools: data?.tools ?? [],
    isLoading,
    error: error as Error | undefined,
  };
}
