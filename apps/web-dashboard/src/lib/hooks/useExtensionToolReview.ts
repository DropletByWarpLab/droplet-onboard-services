"use client";

import { useCallback } from "react";
import useSWR, { useSWRConfig } from "swr";
import { classifyExtensionTool, fetchExtensionToolClassifications } from "../api";
import type { ExtensionToolClassification, ExtensionToolDecision } from "../types";

/** Mirrors the orchestrator's EXTENSION_SERVER_PREFIX: an extension attaches as `ext-<id>`. */
export const EXTENSION_SERVER_PREFIX = "ext-";

/**
 * WARP-3205 — one extension's tools as the classification record has them,
 * and the owner's decision on one of them.
 *
 * Every verdict is the orchestrator's: who may decide (owner-only PATCH),
 * whether the arguments or description moved since they were shown (409
 * STALE_REVIEW), what dispatch then does. A refusal comes back as an
 * `ExtensionRequestError`.
 *
 * The list is read again after EVERY attempt, refused or not: a STALE_REVIEW
 * means the row now names a different tool, and that is what the owner must
 * see next. The runtime-tools list (`/tools`) is revalidated too, since
 * its chips read the same record.
 */
export function useExtensionToolReview(extensionId: string) {
  const serverId = `${EXTENSION_SERVER_PREFIX}${extensionId}`;
  const { data, error, isLoading, mutate } = useSWR<{ classifications: ExtensionToolClassification[] }>(
    `/api/admin/remote-tools/classifications?serverId=${serverId}`,
    () => fetchExtensionToolClassifications(serverId),
  );
  const { mutate: mutateKey } = useSWRConfig();

  const classify = useCallback(
    async (toolName: string, decision: ExtensionToolDecision): Promise<void> => {
      try {
        await classifyExtensionTool(serverId, toolName, decision);
      } finally {
        await Promise.all([mutate(), mutateKey("/api/llm/tools/runtime")]).catch(() => undefined);
      }
    },
    [serverId, mutate, mutateKey],
  );

  return {
    tools: data?.classifications ?? [],
    isLoading,
    error: error as Error | undefined,
    classify,
  };
}
