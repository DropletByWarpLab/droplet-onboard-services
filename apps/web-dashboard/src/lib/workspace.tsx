"use client";

/**
 * Workspace type — Home vs Business — chosen during setup.
 *
 * Drives:
 *   • Sidebar grouping + which nav entries render
 *   • Home page variant default (A chat-first / B ops-first / C admin-first)
 *   • Whether role-aware surfaces (Roles matrix, Groups, Sessions, full People
 *     table) render at all
 *   • Copy tone in confirms ("your household" vs "your team")
 *
 * Source-of-truth lives in `localStorage["droplet-workspace-type"]`. The
 * Setup wizard (Phase 4) writes here when the user picks at first-run.
 * If unset, we default to "home" — matches the persona that ADR-002
 * authored. The Business multi-role IA is opt-in.
 *
 * NOT in the orchestrator DB yet. Phase 4 of the rehaul adds a
 * `workspace_type` column on the existing setup_progress Prisma model
 * and a /api/setup/workspace endpoint; this hook hydrates from that
 * endpoint when it exists and falls back to localStorage during
 * the transition. For Phase 1 it's localStorage-only.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "./auth";

export type WorkspaceType = "home" | "business";

/** Layout intent for the Home page hero. See ADR for variant rationale. */
export type HomeVariant = "A" | "B" | "C";

interface WorkspaceContextValue {
  /** Current workspace type. SSR-safe — defaults to "home" on the server. */
  workspaceType: WorkspaceType;
  /** Persist a new workspace type. Called by the setup wizard. */
  setWorkspaceType: (next: WorkspaceType) => void;
  /** True if `workspaceType === "home"`. Convenience for nav guards. */
  isHome: boolean;
  /** True if `workspaceType === "business"`. */
  isBusiness: boolean;
  /**
   * Which Home page variant to render for the current user. Computed
   * from workspace + role per the rules in `getHomeVariant` below.
   * - Home workspace → always "B" (ops-first, per Stefan 2026-05-18)
   * - Business workspace → role-driven default:
   *     owner  → "C" (admin overview)
   *     admin  → "C"
   *     family → "A" (chat-first — Business "Member" equivalent today)
   *     guest  → "A"
   */
  homeVariant: HomeVariant;
}

const WorkspaceContext = createContext<WorkspaceContextValue | undefined>(undefined);

const STORAGE_KEY = "droplet-workspace-type";

/** Returns a workspace type from storage, or "home" if unset/invalid/SSR. */
function readStoredWorkspace(): WorkspaceType {
  if (typeof window === "undefined") return "home";
  const raw = window.localStorage.getItem(STORAGE_KEY);
  return raw === "business" ? "business" : "home";
}

/**
 * Map (workspace, role) → Home variant. Pure — kept exported so tests
 * and the future server-rendered variant picker can share the logic.
 */
export function getHomeVariant(
  workspaceType: WorkspaceType,
  role: string | undefined,
): HomeVariant {
  if (workspaceType === "home") return "B"; // Stefan 2026-05-18: home = ops-first
  // Business workspace — role decides
  switch (role) {
    case "owner":
    case "admin":
      return "C"; // Admin-first overview
    case "family":
    case "guest":
    default:
      return "A"; // Chat-first (Member/Viewer/Guest default)
  }
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  // Lazy-init from localStorage so first paint matches stored preference.
  const [workspaceType, setWorkspaceTypeState] = useState<WorkspaceType>(
    readStoredWorkspace,
  );

  const { user } = useAuth();

  // Sync across tabs — if a setup wizard in another tab flips the type,
  // every open dashboard tab re-renders.
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      const next = e.newValue === "business" ? "business" : "home";
      setWorkspaceTypeState(next);
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  const setWorkspaceType = useCallback((next: WorkspaceType) => {
    setWorkspaceTypeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Private mode / quota — state still updates for this session.
    }
  }, []);

  const homeVariant = useMemo(
    () => getHomeVariant(workspaceType, user?.role),
    [workspaceType, user?.role],
  );

  const value = useMemo<WorkspaceContextValue>(
    () => ({
      workspaceType,
      setWorkspaceType,
      isHome: workspaceType === "home",
      isBusiness: workspaceType === "business",
      homeVariant,
    }),
    [workspaceType, setWorkspaceType, homeVariant],
  );

  return (
    <WorkspaceContext.Provider value={value}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return ctx;
}
