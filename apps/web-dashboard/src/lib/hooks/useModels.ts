"use client";

import { useCallback } from "react";
import useSWR, { useSWRConfig } from "swr";
import { fetchModels } from "../api";
import type { ModelsResponse } from "../types";

/** WARP-3048 — the one SWR key every chat-model consumer shares (/chat,
 *  Home, the composer's ModelSelector). */
export const LLM_MODELS_KEY = "/api/llm/models";

export function useModels() {
  const { data, error, isLoading, mutate } = useSWR<ModelsResponse>(
    LLM_MODELS_KEY,
    fetchModels,
    {
      refreshInterval: 30000,
      revalidateOnFocus: false,
    }
  );

  return {
    models: data?.models ?? [],
    // WARP-1112 — the box's active local model (set from /models). The chat
    // page defaults its picker to this instead of "the first model listed".
    defaultModel: data?.defaultModel ?? null,
    // WARP-1284 — the list is known to be INCOMPLETE: the gateway was
    // unreachable, or the box's own runtime failed to answer (a model swap
    // can do that). A model missing from a degraded list has not left it.
    degraded: data?.degraded === true,
    error,
    isLoading,
    refresh: mutate,
  };
}

/**
 * WARP-3048 — refill the shared `/api/llm/models` cache after something
 * changed its answer: a PATCH /models/active, or a finished download.
 *
 * A bare `mutate(key)` is not enough. In SWR 2.5 it only revalidates hooks
 * that are MOUNTED, and on /models neither /chat nor Home is — so the next
 * client-side visit to /chat was served the OLD defaultModel from cache and
 * opened on the model the owner had just switched away from. Writing a
 * freshly fetched payload into the cache works whether or not anyone is
 * listening. If that refetch fails, the entry is evicted instead, so the
 * next mount fetches rather than trusting the stale answer.
 */
export function useRefreshLlmModels(): () => Promise<void> {
  const { mutate } = useSWRConfig();
  return useCallback(async () => {
    try {
      await mutate(LLM_MODELS_KEY, fetchModels(), { revalidate: false });
    } catch {
      await mutate(LLM_MODELS_KEY, undefined, { revalidate: false });
    }
  }, [mutate]);
}
