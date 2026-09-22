"use client";

/**
 * WARP-2976 (ADR-059 §2.3) — which department the shell is showing.
 *
 * Modelled on `lib/nav-layout.tsx`: a per-person DISPLAY preference, kept in
 * this browser's localStorage (`droplet-active-department`, the slug; absent
 * means Whole business). Server-side preference arrives with the clients in
 * P6. It changes how the same routes are ARRANGED and nothing about what the
 * person may reach — the nav still runs every existing gate after the
 * department filter (`department-nav.ts`).
 *
 * Who gets which choices (§2.3, amended in review):
 *   · everyone — Whole business (their own gated nav, exactly today's) plus the
 *     departments the list endpoint returns them: every row for owner/admin,
 *     the ones they are a member of for everyone else.
 *   · Whole business is the DEFAULT for everyone. A first draft made a
 *     non-admin member's shell their department by default; the moment an
 *     owner set up a Security profile, a family member in Security would have
 *     lost Files, Email and every other destination the profile didn't list —
 *     a narrowing nobody chose. Arranging must be opt-in for the person
 *     arranged.
 *   · owner/admin additionally get the Business overview (`/d`).
 * `showSwitcher` is true with at least one department — Whole business plus
 * it makes two choices. With none, there is nothing to switch to and today's
 * nav stands. A dead control is worse than none.
 *
 * Only DEPARTMENT rows are choices. HOUSEHOLD is the one-unit home case with
 * nothing to switch between, and a TEAM inherits its parent's profile.
 *
 * Like `useNavLayout`, the hook does NOT throw outside its provider: it
 * answers "Whole business, no switcher". The Sidebar and Workspace shell tests
 * mount without the root providers, and a missing provider must mean today's
 * nav, not a crash.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname } from "next/navigation";
import useSWR from "swr";

import { getDepartmentProfile, listDepartments } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type {
  Department,
  DepartmentProfile,
  DepartmentProfileResponse,
} from "@/lib/types";

import { slugFromPath } from "./department-nav";

export const ACTIVE_DEPARTMENT_STORAGE_KEY = "droplet-active-department";

/** Shared with `components/projects/usePm.ts#useDepartments` — same endpoint,
 *  same `{ departments }` shape, so the two reads dedupe into one request. */
export const DEPARTMENTS_KEY = "/api/departments";

/** The profile read's SWR key. The department home mutates it on save, which
 *  is what makes the sidebar follow a Customize without a reload. */
export function departmentProfileKey(departmentId: string): string {
  return `/api/departments/${departmentId}/profile`;
}

export interface ActiveDepartmentValue {
  /** Departments this viewer may switch to (DEPARTMENT kind, not archived). */
  choices: Department[];
  /** The department the shell is showing, or null for Whole business. */
  active: Department | null;
  /** The active department's full profile; null while loading or not set up. */
  activeProfile: DepartmentProfile | null;
  /** Owner/admin only — the Business overview (`/d`) is theirs. */
  canSeeOverview: boolean;
  /** At least one department to switch to (Whole business is always one). */
  showSwitcher: boolean;
  /** Pick a department by slug, or null for Whole business. Persisted. */
  setActive: (slug: string | null) => void;
  /** The department list has answered (data or error) — so an empty
   *  `choices` means "none", not "not loaded yet". */
  isLoaded: boolean;
}

const DEFAULT_VALUE: ActiveDepartmentValue = {
  choices: [],
  active: null,
  activeProfile: null,
  canSeeOverview: false,
  showSwitcher: false,
  setActive: () => {},
  // Outside the provider there is nothing to wait for.
  isLoaded: true,
};

const ActiveDepartmentContext = createContext<ActiveDepartmentValue>(DEFAULT_VALUE);

/** The switchable rows, in a stable reading order. */
export function departmentChoices(rows: readonly Department[] | undefined): Department[] {
  return (rows ?? [])
    .filter(
      (d) => d.kind === "DEPARTMENT" && d.state !== "archived" && d.state !== "archiving",
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolve the active department from the stored slug. PURE — exported for the
 * unit tests.
 *
 * A slug the viewer can no longer see (removed from the department, archived,
 * renamed) is dropped, and so is no slug at all: both mean Whole business —
 * today's nav — for every role.
 */
export function resolveActive(
  choices: readonly Department[],
  storedSlug: string | null,
): Department | null {
  return (storedSlug ? choices.find((d) => d.slug === storedSlug) : undefined) ?? null;
}

/** Whole business is always a choice; each department adds one. */
export function switcherChoiceCount(choices: readonly Department[]): number {
  return choices.length + 1;
}

function readStored(): string | null {
  try {
    return localStorage.getItem(ACTIVE_DEPARTMENT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(slug: string | null): void {
  try {
    if (slug) localStorage.setItem(ACTIVE_DEPARTMENT_STORAGE_KEY, slug);
    else localStorage.removeItem(ACTIVE_DEPARTMENT_STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode, blocked) — the choice still applies
    // for this session.
  }
}

export function ActiveDepartmentProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const canSeeOverview = user?.role === "owner" || user?.role === "admin";

  // Starts empty on server AND client and adopts the stored slug after mount,
  // for the same hydration reason `NavLayoutProvider` gives.
  const [storedSlug, setStoredSlug] = useState<string | null>(null);
  useEffect(() => {
    setStoredSlug(readStored());
  }, []);

  const { data, error } = useSWR<{ departments: Department[] }>(
    user ? DEPARTMENTS_KEY : null,
    () => listDepartments(),
    {
      // Membership and profiles change when an owner edits them, not per
      // second. Focus revalidation picks up a change made in another tab.
      revalidateOnFocus: true,
      shouldRetryOnError: false,
    },
  );
  const choices = useMemo(() => departmentChoices(data?.departments), [data]);
  const isLoaded = data !== undefined || error !== undefined;

  // Visiting /d/<slug> makes that department active — but only a slug the
  // viewer may choose; a typed URL for someone else's department must not be
  // persisted as their shell.
  //
  // Applied once per ARRIVAL at a /d/<slug> URL, not on every change of the
  // stored slug. Otherwise picking "Whole business" while standing on
  // /d/security is undone on the very next render: the stored slug becomes
  // null while the pathname still reads /d/security (the router has not moved
  // yet), and the effect would put Security straight back.
  const urlSlug = slugFromPath(pathname);
  const appliedUrlSlug = useRef<string | null>(null);
  useEffect(() => {
    if (!urlSlug) {
      appliedUrlSlug.current = null;
      return;
    }
    if (appliedUrlSlug.current === urlSlug) return;
    if (!choices.some((d) => d.slug === urlSlug)) return;
    appliedUrlSlug.current = urlSlug;
    setStoredSlug(urlSlug);
    writeStored(urlSlug);
  }, [urlSlug, choices]);

  const setActive = useCallback((slug: string | null) => {
    setStoredSlug(slug);
    writeStored(slug);
  }, []);

  const active = useMemo(
    () => resolveActive(choices, storedSlug),
    [choices, storedSlug],
  );

  // The full profile (navHrefs) only exists on the profile read. Skipped when
  // the list row positively says "not set up" — an absent `profile` key (an
  // older orchestrator) still asks, and a failed read reads as not set up,
  // which leaves the nav as it is today.
  const { data: profileData } = useSWR<DepartmentProfileResponse>(
    active && active.profile !== null ? departmentProfileKey(active.id) : null,
    () => getDepartmentProfile(active!.id),
    { shouldRetryOnError: false },
  );
  const activeProfile =
    active && profileData?.profile && profileData.profile.departmentId === active.id
      ? profileData.profile
      : null;

  const value = useMemo<ActiveDepartmentValue>(
    () => ({
      choices,
      active,
      activeProfile,
      canSeeOverview,
      showSwitcher: switcherChoiceCount(choices) >= 2,
      setActive,
      isLoaded,
    }),
    [choices, active, activeProfile, canSeeOverview, setActive, isLoaded],
  );

  return (
    <ActiveDepartmentContext.Provider value={value}>{children}</ActiveDepartmentContext.Provider>
  );
}

export function useActiveDepartment(): ActiveDepartmentValue {
  return useContext(ActiveDepartmentContext);
}
