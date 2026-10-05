/**
 * Service desk (ADR-069 §1) — desks, the containers tickets live in.
 *
 * A desk is a `PmProject` whose `kind` is SERVICE_DESK, in the same `home`
 * workspace as every project, so ticket keys (`SUP-12`) and project keys share
 * one identifier namespace. Every query here that means "a desk" filters on
 * `kind`, and every by-id lookup that is not a desk is DESK_NOT_FOUND — a
 * project id is a 404 on the support side exactly as a desk id is a 404 on the
 * PM side.
 *
 * Authorisation (owner/admin) is the route's; this file trusts its caller.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  PM_ERRORS,
  deriveIdentifier,
  ensureHomeWorkspace,
  isPrismaCode,
} from "../pm/pm.service.js";
import { assertAssignableDepartment } from "../pm/pm-department.js";
import { DESK_INCLUDE, mapDesk } from "./support-mappers.js";
import {
  DESK_LABELS,
  DESK_STATES,
  SUPPORT_ERRORS,
  type ApiDesk,
  type DeskCreateInput,
  type DeskUpdateInput,
  type SupportViewer,
} from "./support.types.js";

export async function listDesks(
  prisma: PrismaClient,
  opts: { includeArchived?: boolean } = {},
): Promise<ApiDesk[]> {
  const rows = await prisma.pmProject.findMany({
    where: { kind: "SERVICE_DESK", ...(opts.includeArchived ? {} : { isArchived: false }) },
    include: DESK_INCLUDE,
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(mapDesk);
}

export async function getDesk(prisma: PrismaClient, deskId: string): Promise<ApiDesk> {
  const row = await prisma.pmProject.findFirst({
    where: { id: deskId, kind: "SERVICE_DESK" },
    include: DESK_INCLUDE,
  });
  if (!row) throw new Error(SUPPORT_ERRORS.DESK_NOT_FOUND);
  return mapDesk(row);
}

export async function createDesk(
  prisma: PrismaClient,
  viewer: SupportViewer,
  input: DeskCreateInput,
): Promise<ApiDesk> {
  // Same rule as createProject: refuse HOUSEHOLD and archive-intent departments,
  // and `!== undefined` so an empty string reaches the guard instead of an FK.
  if (input.departmentId !== undefined) await assertAssignableDepartment(prisma, input.departmentId);

  const workspace = await ensureHomeWorkspace(prisma);

  // Resolve the key prefix, suffixing on collision unless the caller chose one.
  const base = input.identifier ? input.identifier.toUpperCase() : deriveIdentifier(input.name);
  let identifier = base;
  for (let n = 1; ; n += 1) {
    const clash = await prisma.pmProject.findUnique({
      where: { workspaceId_identifier: { workspaceId: workspace.id, identifier } },
      select: { id: true },
    });
    if (!clash) break;
    if (input.identifier) throw new Error(PM_ERRORS.IDENTIFIER_TAKEN);
    identifier = `${base}${n}`;
  }

  // The loop above and the create are not one transaction, so two concurrent
  // creates can both pass it: the loser hits the unique index (P2002).
  try {
    const created = await prisma.pmProject.create({
      data: {
        workspaceId: workspace.id,
        kind: "SERVICE_DESK",
        name: input.name,
        identifier,
        description: input.description ?? null,
        icon: input.icon ?? null,
        color: input.color ?? null,
        departmentId: input.departmentId ?? null,
        createdById: viewer.id,
        states: {
          create: DESK_STATES.map((s) => ({
            name: s.name,
            group: s.group,
            slaClock: s.slaClock,
            color: s.color,
            sortOrder: s.sortOrder,
            isDefault: s.isDefault,
            onCustomerReply: s.onCustomerReply,
          })),
        },
        labels: { create: DESK_LABELS.map((l) => ({ name: l.name, color: l.color })) },
      },
      include: DESK_INCLUDE,
    });
    return mapDesk(created);
  } catch (err) {
    if (isPrismaCode(err, "P2002")) throw new Error(PM_ERRORS.IDENTIFIER_TAKEN);
    throw err;
  }
}

export async function updateDesk(
  prisma: PrismaClient,
  _viewer: SupportViewer,
  deskId: string,
  input: DeskUpdateInput,
): Promise<ApiDesk> {
  const existing = await prisma.pmProject.findFirst({
    where: { id: deskId, kind: "SERVICE_DESK" },
    select: { id: true },
  });
  if (!existing) throw new Error(SUPPORT_ERRORS.DESK_NOT_FOUND);

  const data: Prisma.PmProjectUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.description !== undefined) data.description = input.description;
  if (input.icon !== undefined) data.icon = input.icon;
  if (input.color !== undefined) data.color = input.color;
  if (input.departmentId !== undefined) {
    if (input.departmentId !== null) await assertAssignableDepartment(prisma, input.departmentId);
    // The checked update input exposes the relation, not its foreign key.
    data.department = input.departmentId
      ? { connect: { id: input.departmentId } }
      : { disconnect: true };
  }
  if (input.archived !== undefined) {
    // isArchived is the canonical signal (WARP-884); archivedAt is the audit
    // timestamp, written and cleared alongside it so the two never diverge.
    data.isArchived = input.archived;
    data.archivedAt = input.archived ? new Date() : null;
  }

  try {
    const updated = await prisma.pmProject.update({
      where: { id: deskId },
      data,
      include: DESK_INCLUDE,
    });
    return mapDesk(updated);
  } catch (err) {
    // Deleted between the existence check and the write.
    if (isPrismaCode(err, "P2025")) throw new Error(SUPPORT_ERRORS.DESK_NOT_FOUND);
    throw err;
  }
}
