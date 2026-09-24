"use client";

import { useCallback } from "react";
import useSWR from "swr";
import {
  confirmExtensionPromotion,
  fetchExtensionProposals,
  fetchExtensions,
  prepareExtensionPromotion,
  setExtensionEnabled,
  uninstallExtension,
} from "../api";
import type {
  ExtensionListItem,
  ExtensionPromotePhase1,
  ExtensionPromoteResult,
  ExtensionProposal,
} from "../types";

/**
 * WARP-2900 (ADR-056 slice H4) — `/admin/extensions`: the installed
 * extensions, the workshop proposals that could be promoted, and the owner's
 * actions on both.
 *
 * The two lists are separate probes on purpose (the console's rule): a
 * sandbox that cannot answer for the proposals must not blank the installed
 * list, which the orchestrator answers from its own database.
 *
 * The actions are thin: every decision — who may promote, whether the bytes
 * moved since the readback, whether the sandbox is on — is the orchestrator's,
 * and a refusal comes back as an `ExtensionRequestError` with its code. Every
 * action refreshes both lists when it ends, failed or not: a refused call can
 * still have moved the row (a disable whose sandbox stop failed is already
 * `disabled`).
 */
export function useExtensions() {
  const installed = useSWR<{ extensions: ExtensionListItem[] }>("/api/extensions", fetchExtensions);
  const proposals = useSWR<{ proposals: ExtensionProposal[] }>(
    "/api/extensions/proposals",
    fetchExtensionProposals,
  );
  const mutateInstalled = installed.mutate;
  const mutateProposals = proposals.mutate;

  const refresh = useCallback(async () => {
    await Promise.all([mutateInstalled(), mutateProposals()]);
  }, [mutateInstalled, mutateProposals]);

  /** Phase 1: read back what promoting this proposal would sign. Signs nothing. */
  const preparePromotion = useCallback(
    (workspaceId: string): Promise<ExtensionPromotePhase1> => prepareExtensionPromotion(workspaceId),
    [],
  );

  /** Phase 2: sign + install exactly what was read back. */
  const confirmPromotion = useCallback(
    async (phase1: ExtensionPromotePhase1, operatorDomain: string | null): Promise<ExtensionPromoteResult> => {
      try {
        return await confirmExtensionPromotion(phase1.workspaceId, {
          confirmationToken: phase1.confirmationToken,
          manifestSha256: phase1.manifestSha256,
          ...(operatorDomain ? { operatorDomain } : {}),
        });
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const setEnabled = useCallback(
    async (slug: string, enabled: boolean) => {
      try {
        await setExtensionEnabled(slug, enabled);
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  const uninstall = useCallback(
    async (slug: string) => {
      try {
        await uninstallExtension(slug);
      } finally {
        await refresh();
      }
    },
    [refresh],
  );

  return {
    extensions: installed.data?.extensions ?? [],
    extensionsLoading: installed.isLoading,
    extensionsError: installed.error as Error | undefined,
    proposals: proposals.data?.proposals ?? [],
    proposalsLoading: proposals.isLoading,
    proposalsError: proposals.error as Error | undefined,
    refresh,
    preparePromotion,
    confirmPromotion,
    setEnabled,
    uninstall,
  };
}
