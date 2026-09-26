/**
 * WARP-2981 (ADR-059 §6.1, DS-003) — the department a person's shell is
 * arranged around, kept on the server so it follows them to every device.
 *
 * One row per person (`ActiveDepartmentChoice`, keyed by userId), and the row
 * IS their choice: `scope` is Whole business or a department. No row means
 * they have never chosen — its own answer, `unset`, not a second meaning of
 * Whole business: the box shows Whole business (DS-014) either way, but only
 * a chosen scope may replace a choice a browser kept from before P6. It
 * SHOWS, never grants — the nav still runs every gate after the department
 * filter.
 *
 * Choosability is checked on WRITE and again on READ. A person removed from
 * the department, or a department archived since, reads as Whole business.
 * A read never writes: the stale row stays until the person's next choice
 * replaces it, so a department restored from the archive comes back as it was.
 *
 * Every function here is keyed by the CALLER's id. Nothing accepts another
 * person's id, so no route built on this can read or move anyone else's
 * choice. Service principals are refused by the route before this is reached.
 *
 * Last write wins across devices, and nothing is audited: it is a display
 * preference, like CameraPin (spec §3, D4).
 */
import type { PrismaClient } from "@prisma/client";

/** The facts about a department that decide whether it can be chosen. */
export interface ChoosableFacts {
  kind: string;
  state: string;
}

/** Who is choosing. `role` is the JWT role; `id` the local User.id. */
export interface ChoiceViewer {
  id: string;
  role: string;
}

/** A chosen department in an answer — the switcher's label and nothing more. */
export interface ActiveDepartmentView {
  id: string;
  slug: string;
  name: string;
  /** `null` is a real state: the department is not set up yet. */
  profile: { template: string; icon: string } | null;
}

/**
 * What GET and PUT answer. `scope` is always explicit:
 *   · `unset` — no choice on the box yet (no row);
 *   · `whole_business` — chosen, or a department chosen that the person may no
 *     longer choose (the row is kept; see readActiveDepartment);
 *   · `department` — `department` is the view, and only then non-null.
 */
export type ActiveDepartmentAnswer =
  | { scope: "unset"; department: null }
  | { scope: "whole_business"; department: null }
  | { scope: "department"; department: ActiveDepartmentView };

const UNSET: ActiveDepartmentAnswer = { scope: "unset", department: null };
const WHOLE_BUSINESS: ActiveDepartmentAnswer = { scope: "whole_business", department: null };

/** States in which a department is on its way out, or gone. */
const NOT_CHOOSABLE_STATES: ReadonlySet<string> = new Set(["archived", "archiving"]);

/**
 * Exactly the set the web switcher offers: `departmentChoices`
 * (lib/departments/active-department.tsx) over GET /api/departments' scoping
 * (owner/admin see every row; everyone else sees the rows they hold a
 * membership in). Pinned against the web by department-choice.fixtures.json.
 *
 *   · a DEPARTMENT — a TEAM reads its parent's profile and the HOUSEHOLD is
 *     the one-unit home case (DS-012), so neither is a choice;
 *   · not archived or archiving;
 *   · the viewer is owner/admin, or holds a membership row in THIS department.
 */
export function isChoosableDepartment(
  dept: ChoosableFacts,
  viewer: { role: string },
  hasMembership: boolean,
): boolean {
  if (dept.kind !== "DEPARTMENT") return false;
  if (NOT_CHOOSABLE_STATES.has(dept.state)) return false;
  return viewer.role === "owner" || viewer.role === "admin" || hasMembership;
}

const DEPARTMENT_SELECT = {
  id: true,
  slug: true,
  name: true,
  kind: true,
  state: true,
  profile: { select: { template: true, icon: true } },
} as const;

/**
 * The department as the viewer may see it, or null when it is missing or not
 * theirs to choose. Every "no" is the same null, so no caller can tell a
 * department that does not exist from one that is someone else's.
 */
async function loadChoosable(
  prisma: PrismaClient,
  viewer: ChoiceViewer,
  departmentId: string,
): Promise<ActiveDepartmentView | null> {
  const [dept, membership] = await Promise.all([
    prisma.department.findUnique({ where: { id: departmentId }, select: DEPARTMENT_SELECT }),
    prisma.departmentMembership.findUnique({
      where: { departmentId_userId: { departmentId, userId: viewer.id } },
      select: { id: true },
    }),
  ]);
  if (!dept || !isChoosableDepartment(dept, viewer, membership !== null)) return null;
  return {
    id: dept.id,
    slug: dept.slug,
    name: dept.name,
    profile: dept.profile ? { template: dept.profile.template, icon: dept.profile.icon } : null,
  };
}

/**
 * The caller's choice, re-checked now. Reads the row, then (for a department)
 * the department and the viewer's membership. Never writes: a department the
 * viewer may no longer choose reads as Whole business and the row waits for
 * their next choice, so a department restored from the archive comes back.
 */
export async function readActiveDepartment(
  prisma: PrismaClient,
  viewer: ChoiceViewer,
): Promise<ActiveDepartmentAnswer> {
  const row = await prisma.activeDepartmentChoice.findUnique({
    where: { userId: viewer.id },
    select: { scope: true, departmentId: true },
  });
  if (!row) return UNSET;
  if (row.scope === "whole_business") return WHOLE_BUSINESS;
  // A department choice always names one: ActiveDepartmentChoice_scope_shape.
  const view = await loadChoosable(prisma, viewer, row.departmentId!);
  return view ? { scope: "department", department: view } : WHOLE_BUSINESS;
}

export type ChooseResult =
  | { ok: true; answer: ActiveDepartmentAnswer }
  | { ok: false; reason: "not_available" };

/** Postgres FK violation, as Prisma reports it. */
function isForeignKeyViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2003";
}

/**
 * Set the caller's department, or Whole business with `null`. Either way the
 * row records the choice (upsert keyed by userId — the primary key, so two
 * devices racing can never leave two rows; the later write wins).
 *
 *   · null → a `whole_business` row, with no department;
 *   · a department the caller may not choose, or one that does not exist →
 *     `not_available`, with nothing written;
 *   · otherwise a `department` row naming it.
 *
 * A department removed between the check and the write fails its FK and is
 * the same `not_available`.
 */
export async function chooseActiveDepartment(
  prisma: PrismaClient,
  viewer: ChoiceViewer,
  departmentId: string | null,
): Promise<ChooseResult> {
  if (departmentId === null) {
    const whole = { scope: "whole_business", departmentId: null } as const;
    await prisma.activeDepartmentChoice.upsert({
      where: { userId: viewer.id },
      create: { userId: viewer.id, ...whole },
      update: whole,
    });
    return { ok: true, answer: WHOLE_BUSINESS };
  }
  const view = await loadChoosable(prisma, viewer, departmentId);
  if (!view) return { ok: false, reason: "not_available" };
  const chosen = { scope: "department", departmentId } as const;
  try {
    await prisma.activeDepartmentChoice.upsert({
      where: { userId: viewer.id },
      create: { userId: viewer.id, ...chosen },
      update: chosen,
    });
  } catch (err) {
    if (isForeignKeyViolation(err)) return { ok: false, reason: "not_available" };
    throw err;
  }
  return { ok: true, answer: { scope: "department", department: view } };
}
