"use client";

import { useMemo } from "react";
import type { DashboardPage } from "@droplet/shared-types";

import { assistantPages } from "@/lib/assistant-pages";
import { useNavGates } from "@/lib/hooks/useNavGates";

/**
 * WARP-3116 — the pages the assistant may link to or open for the signed-in
 * viewer, gated exactly as the sidebar is. Feed it to `useChat`'s
 * `dashboardPages`.
 */
export function useAssistantPages(): DashboardPage[] {
  const { role, capabilities, isModuleOn } = useNavGates();
  const { claudeActivity, ragEval, medicalConnector } = capabilities;
  // `capabilities` is a fresh object every render; key on its three flags so
  // the list (and the ref useChat keeps) only changes when a gate does.
  return useMemo(
    () => assistantPages(role, { claudeActivity, ragEval, medicalConnector }, isModuleOn),
    [role, claudeActivity, ragEval, medicalConnector, isModuleOn],
  );
}
