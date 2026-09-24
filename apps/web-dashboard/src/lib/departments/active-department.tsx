"use client";

/**
 * WARP-2976 (ADR-059 §2.3) — which department the shell is showing.
 *
 * Modelled on `lib/nav-layout.tsx`: a per-person DISPLAY preference. It
 * changes how the same routes are ARRANGED and nothing about what the person
 * may reach — the nav still runs every existing gate after the department
 * filter (`department-nav.ts`).
 *
 * WHERE THE CHOICE LIVES (WARP-2981, ADR-059 P6 §6.1, DS-003). On the box —
 * `GET/PUT /api/me/active-department` — so it follows the person to every
 * device. This browser's localStorage (`droplet-active-department:<user.id>`,
 * the slug; absent means Whole business) is the first-paint cache. The key is
 * PER USER: a shared browser must not hand one person's narrowed shell to the
 * next person who signs in (review of #2285), and it is removed when that
 * user signs out. Who wins, and when:
 *
 *   1. First paint: the stored slug, exactly as P1.
 *   2. Once there is a user, the box is read, and read again on focus — so a
 *      switch made on the phone shows up here the next time this tab is
 *      looked at.
 *   3. The box's answer says explicitly whether the person has chosen:
 *      `unset` (never, on any device), `whole_business` or `department`. A
 *      CHOSEN scope is ADOPTED (state and localStorage) unless the person
 *      picked here after that read started, or a pick's PUT was still on its
 *      way when it started. A newer local pick is never clobbered by an older
 *      answer (D5).
 *   4. A pick — the switcher, or arriving at /d/<slug> — applies at once and
 *      is PUT with the department's id (null for Whole business). A failed
 *      PUT is a console.warn and nothing else: the local pick stands until
 *      the box next answers.
 *   5. An orchestrator older than the route (a 404 whose code is not
 *      DEPARTMENT_NOT_AVAILABLE) turns the sync off for the page's life,
 *      which is P1's behaviour.
 *   6. P1's local choices are not migrated (§5), and `unset` is never
 *      adopted: a department this browser kept from before P6 stands until a
 *      choice exists on the box — the first pick on any device. A Whole
 *      business chosen on the phone is `whole_business`, not `unset`, so it
 *      does reach a laptop still holding a P1 department.
 *   7. Signing out forgets this browser's copy. The row on the box stays: it
 *      is the person's choice on every device.
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
 * nothing to switch between, and a TEAM inherits its parent's profile. The box
 * checks the same set on every read and write (`isChoosableDepartment`, one
 * fixture file shared by both test suites).
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

import {
  getActiveDepartment,
  getDepartmentProfile,
  listDepartments,
  putActiveDepartment,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type {
  ActiveDepartmentResponse,
  Department,
  DepartmentProfile,
  DepartmentProfileResponse,
} from "@/lib/types";

import { slugFromPath } from "./department-nav";

export const ACTIVE_DEPARTMENT_STORAGE_KEY = "droplet-active-department";

/** The localStorage key holding `userId`'s choice. */
export function activeDepartmentStorageKey(userId: string): string {
  return `${ACTIVE_DEPARTMENT_STORAGE_KEY}:${userId}`;
}

/** Shared with `components/projects/usePm.ts#useDepartments` — same endpoint,
 *  same `{ departments }` shape, so the two reads dedupe into one request. */
export const DEPARTMENTS_KEY = "/api/departments";

/** The server choice's SWR key. Used as `[ACTIVE_DEPARTMENT_KEY, userId]`:
 *  keyed by the person too, so an account switch without a reload never reads
 *  the previous person's answer out of the cache. */
export const ACTIVE_DEPARTMENT_KEY = "/api/me/active-department";

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
  /** Pick a department by slug, or null for Whole business. Persisted, on the
   *  box and in this browser. */
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

/**
 * The box has no `/api/me/active-department` at all (an orchestrator older
 * than WARP-2981): a 404 that is not the route's own refusal. PURE.
 */
export function isMissingRoute(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown } | null;
  return !!e && e.status === 404 && e.code !== "DEPARTMENT_NOT_AVAILABLE";
}

/**
 * Whether a server answer may replace what this browser shows. PURE —
 * exported for the unit tests; the provider is its only caller.
 *
 *   · `pickedSince` — the person picked here after the read started, or a
 *     pick's PUT had not landed when it started: the answer is older than the
 *     local pick, so it must not clobber it (D5).
 *   · `scope: "unset"` — nobody has chosen, on any device: there is nothing
 *     to adopt, and a P1 choice this browser holds stands (§5).
 */
export function shouldAdoptServerChoice(input: {
  pickedSince: boolean;
  scope: ActiveDepartmentResponse["scope"];
}): boolean {
  return !input.pickedSince && input.scope !== "unset";
}

function readStored(userId: string): string | null {
  try {
    return localStorage.getItem(activeDepartmentStorageKey(userId));
  } catch {
    return null;
  }
}

function writeStored(userId: string, slug: string | null): void {
  try {
    if (slug) localStorage.setItem(activeDepartmentStorageKey(userId), slug);
    else localStorage.removeItem(activeDepartmentStorageKey(userId));
  } catch {
    // Storage unavailable (private mode, blocked) — the choice still applies
    // for this session.
  }
}

/** One read of the box, tagged with what this browser had done when it began. */
interface ServerChoiceRead {
  /** `picks.current` when the read started. */
  pickSeqAtStart: number;
  /** PUTs still on their way when the read started. */
  pendingAtStart: number;
  answer: ActiveDepartmentResponse;
}

export function ActiveDepartmentProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const pathname = usePathname();
  const canSeeOverview = user?.role === "owner" || user?.role === "admin";

  const userId = user?.id ?? null;

  // Starts empty on server AND client and adopts the stored slug after mount,
  // for the same hydration reason `NavLayoutProvider` gives. Re-read whenever
  // the signed-in user changes, not only on mount: an account switch without
  // a reload must not carry the previous person's choice over. The slug is
  // tagged with the user it was read for, so the render between the switch
  // and this effect already answers Whole business for the new user.
  const [stored, setStored] = useState<{ userId: string; slug: string | null } | null>(null);
  const previousUserId = useRef<string | null>(null);
  useEffect(() => {
    // Signing out (a known user → none) forgets that user's choice — in this
    // browser only; the box keeps it for their other devices.
    if (!userId && previousUserId.current) {
      writeStored(previousUserId.current, null);
    }
    previousUserId.current = userId;
    setStored(userId ? { userId, slug: readStored(userId) } : null);
  }, [userId]);
  const storedSlug = stored && stored.userId === userId ? stored.slug : null;

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

  // ── the box (WARP-2981) ────────────────────────────────────────────────────
  // Every local pick bumps `picks`; `pendingPuts` counts PUTs in flight. A read
  // records both when it starts, which is how rule 3 tells an answer older
  // than a local pick from a current one.
  const picks = useRef(0);
  const pendingPuts = useRef(0);
  // Off for the page's life once the box proves it has no such route (rule 5).
  const [serverSync, setServerSync] = useState(true);

  // Keyed by the person: SWR only ever hands this hook the answer read for
  // the user signed in NOW, so an account switch without a reload cannot
  // apply the previous person's choice (their read lands in their own slot).
  const { data: serverChoice, error: serverError } = useSWR<ServerChoiceRead>(
    userId && serverSync ? [ACTIVE_DEPARTMENT_KEY, userId] : null,
    async () => {
      const pickSeqAtStart = picks.current;
      const pendingAtStart = pendingPuts.current;
      const answer = await getActiveDepartment();
      return { pickSeqAtStart, pendingAtStart, answer };
    },
    { revalidateOnFocus: true, shouldRetryOnError: false },
  );

  useEffect(() => {
    if (serverError && isMissingRoute(serverError)) setServerSync(false);
  }, [serverError]);

  useEffect(() => {
    if (!serverChoice || !userId) return;
    const { answer } = serverChoice;
    const adopt = shouldAdoptServerChoice({
      pickedSince:
        serverChoice.pickSeqAtStart !== picks.current || serverChoice.pendingAtStart !== 0,
      scope: answer.scope,
    });
    if (!adopt) return;
    const serverSlug = answer.scope === "department" ? answer.department.slug : null;
    writeStored(userId, serverSlug);
    setStored((prev) =>
      prev && prev.userId === userId && prev.slug === serverSlug ? prev : { userId, slug: serverSlug },
    );
  }, [serverChoice, userId]);

  /** A local pick: applied at once, then told to the box (rule 4). */
  const pick = useCallback(
    (slug: string | null) => {
      if (!userId) return;
      picks.current += 1;
      setStored({ userId, slug });
      writeStored(userId, slug);
      if (!serverSync) return;
      // The box takes an id. A slug that is not one of this person's choices
      // has no id to send — the local state resolves it to Whole business.
      const departmentId =
        slug === null ? null : (choices.find((d) => d.slug === slug)?.id ?? undefined);
      if (departmentId === undefined) return;
      pendingPuts.current += 1;
      putActiveDepartment(departmentId)
        .catch((err: unknown) => {
          if (isMissingRoute(err)) {
            setServerSync(false);
            return;
          }
          // A display preference: the local pick stands, nothing else.
          console.warn("Couldn't save the department choice to Droplet; this browser keeps it.", err);
        })
        .finally(() => {
          pendingPuts.current -= 1;
        });
    },
    [userId, serverSync, choices],
  );

  // Visiting /d/<slug> makes that department active — but only a slug the
  // viewer may choose; a typed URL for someone else's department must not be
  // persisted as their shell.
  //
  // Applied once per ARRIVAL at a /d/<slug> URL, not on every change of the
  // stored slug. Otherwise picking "Whole business" while standing on
  // /d/security is undone on the very next render: the stored slug becomes
  // null while the pathname still reads /d/security (the router has not moved
  // yet), and the effect would put Security straight back.
  //
  // An arrival is a pick like any other (rule 4): it is PUT, and an answer
  // from the box that was already on its way does not undo it.
  const urlSlug = slugFromPath(pathname);
  const appliedUrlSlug = useRef<string | null>(null);
  useEffect(() => {
    if (!urlSlug || !userId) {
      appliedUrlSlug.current = null;
      return;
    }
    // Keyed by user too: the next person to sign in on the same URL gets it
    // applied (and checked against THEIR choices) afresh.
    const arrival = `${userId}:${urlSlug}`;
    if (appliedUrlSlug.current === arrival) return;
    if (!choices.some((d) => d.slug === urlSlug)) return;
    appliedUrlSlug.current = arrival;
    pick(urlSlug);
  }, [urlSlug, choices, userId, pick]);

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
      setActive: pick,
      isLoaded,
    }),
    [choices, active, activeProfile, canSeeOverview, pick, isLoaded],
  );

  return (
    <ActiveDepartmentContext.Provider value={value}>{children}</ActiveDepartmentContext.Provider>
  );
}

export function useActiveDepartment(): ActiveDepartmentValue {
  return useContext(ActiveDepartmentContext);
}
