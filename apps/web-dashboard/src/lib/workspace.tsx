"use client";

/**
 * Workspace context — business-only build (WARP-1341).
 *
 * Historically the dashboard supported a dual Home / Business IA chosen at
 * setup (ADR-007/ADR-009): the provider hydrated the type from
 * `/api/settings/workspace` with a localStorage fallback, and nav/copy
 * branched on it. This build ships business-only — the orchestrator only
 * accepts and reports "business" (see settings-workspace.ts), so the
 * provider collapses to a static value. The context shape survives so
 * consumers keep reading `useWorkspace()` rather than hard-coding.
 */

import { createContext, useContext, type ReactNode } from "react";

export type WorkspaceType = "business";

interface WorkspaceContextValue {
  /** Always "business" — this build has no other mode. */
  workspaceType: WorkspaceType;
  /** True — kept so nav guards read declaratively. */
  isBusiness: true;
}

const BUSINESS_WORKSPACE: WorkspaceContextValue = {
  workspaceType: "business",
  isBusiness: true,
};

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(
  undefined,
);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  return (
    <WorkspaceContext.Provider value={BUSINESS_WORKSPACE}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
