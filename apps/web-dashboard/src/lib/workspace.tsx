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
  // This is the SSR-safe + offline-friendly baseline; the orchestrator
  // GET below is the source of truth once it answers.
  const [workspaceType, setWorkspaceTypeState] = useState<WorkspaceType>(
    readStoredWorkspace,
  );

  const { user, isLoading: authLoading } = useAuth();

  // Hydrate from the orchestrator once auth is settled. Per ADR-009
  // §workspace, GET /api/settings/workspace returns the singleton
  // Workspace row's type, or the HOME default if the wizard hasn't
  // run yet. 404 (Phase 4a not deployed) is a no-op — we keep the
  // localStorage value. Any error other than 404/network is silently
  // tolerated; the dashboard already painted with the localStorage
  // best guess.
  useEffect(() => {
    if (authLoading || !user) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/settings/workspace", {
          credentials: "same-origin",
        });
        if (!res.ok) return;
        const body = (await res.json()) as { workspaceType?: string };
        const next = body.workspaceType === "business" ? "business" : "home";
        if (!cancelled && next !== workspaceType) {
          setWorkspaceTypeState(next);
          try {
            window.localStorage.setItem(STORAGE_KEY, next);
          } catch {
            /* private mode — fine */
          }
        }
      } catch {
        // Network down, orchestrator slow, etc — keep cached value.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user?.id]);

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
    // Best-effort push to the orchestrator so the new value is durable
    // + visible to other clients. POST is owner-only on the server side;
    // 403 is fine — the local state still updated for this session.
    if (typeof window !== "undefined") {
      fetch("/api/settings/workspace", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceType: next }),
      }).catch(() => {
        /* offline / orchestrator down — localStorage is the fallback */
      });
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
