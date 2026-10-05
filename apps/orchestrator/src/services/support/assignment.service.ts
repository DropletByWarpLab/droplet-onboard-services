import type { Prisma, PrismaClient } from "@prisma/client";
import { listAgents, type SupportDeps } from "./requester.service.js";
import { OPEN_GROUPS } from "./ticket-query.js";
import { assignmentSchema } from "./sla-schemas.js";

export async function assignNewTicket(
  tx: Prisma.TransactionClient, deskId: string, departmentId: string | null, deps: SupportDeps = {},
): Promise<string[]> {
  // Read AFTER acquiring the cursor row: concurrent creates see the last committed choice.
  await tx.$queryRaw`SELECT "id" FROM "PmAssignmentRule" WHERE "projectId" = ${deskId} FOR UPDATE`;
  const stored = await tx.pmAssignmentRule.findUnique({ where: { projectId: deskId } });
  if (!stored || stored.mode === "MANUAL" || (stored.departmentId && stored.departmentId !== departmentId)) return [];
  const rule = assignmentSchema.parse({ mode: stored.mode, departmentId: stored.departmentId, memberIds: stored.memberIds });
  const agents = new Set((await listAgents(tx as unknown as PrismaClient, deps)).map((u) => u.id));
  const members = rule.memberIds.filter((id) => agents.has(id));
  if (!members.length) return [];
  // Rotate configured order BEFORE choosing the least-open tie, so ties are fair.
  const last = members.indexOf(stored.lastAssignedUserId ?? "");
  const rotation = [...members.slice(last + 1), ...members.slice(0, last + 1)];
  let selected = rotation[0]!;
  if (rule.mode === "LEAST_OPEN") {
    const counts = await tx.pmWorkItemAssignee.groupBy({
      by: ["userId"], where: { userId: { in: members }, workItem: {
        projectId: deskId, isArchived: false, state: { group: { in: [...OPEN_GROUPS] } },
      } }, _count: { workItemId: true },
    });
    const byUser = new Map(counts.map((c) => [c.userId, c._count.workItemId]));
    selected = rotation.reduce((best, id) => (byUser.get(id) ?? 0) < (byUser.get(best) ?? 0) ? id : best, selected);
  }
  await tx.pmAssignmentRule.update({ where: { id: stored.id }, data: { lastAssignedUserId: selected } });
  return [selected];
}
