import type { PrismaClient } from "@prisma/client";
import { isCalendarYmd } from "../../lib/zoned-time.js";
import { SUPPORT_ERRORS } from "./support.types.js";
/** SLA outcomes for the stated ticket creation cohort; full Support insights belong to WS-15. */
export async function getSlaReport(prisma: PrismaClient, deskId: string, range: { from: string; to: string }) {
  if (!isCalendarYmd(range.from) || !isCalendarYmd(range.to)) throw new Error("invalid_report_range");
  const from = new Date(`${range.from}T00:00:00.000Z`);
  const through = new Date(`${range.to}T00:00:00.000Z`);
  if (from > through || through.getTime() - from.getTime() > 365 * 86400000) throw new Error("invalid_report_range");
  if (!await prisma.pmProject.findFirst({ where: { id: deskId, kind: "SERVICE_DESK" }, select: { id: true } })) throw new Error(SUPPORT_ERRORS.DESK_NOT_FOUND);
  const rows = await prisma.pmTicket.groupBy({ by: ["slaStatus"], where: {
    workItem: { projectId: deskId, project: { kind: "SERVICE_DESK" }, isArchived: false, createdAt: { gte: from, lt: new Date(through.getTime() + 86400000) } },
  }, _count: { workItemId: true } });
  const statusCounts = Object.fromEntries(rows.map((r) => [r.slaStatus, r._count.workItemId]));
  const completed = await prisma.pmTicket.groupBy({ by: ["slaStatus"], where: {
    solvedAt: { not: null }, slaStatus: { in: ["MET", "BREACHED"] },
    workItem: { projectId: deskId, project: { kind: "SERVICE_DESK" }, isArchived: false, createdAt: { gte: from, lt: new Date(through.getTime() + 86400000) } },
  }, _count: { workItemId: true } });
  const completedCounts = Object.fromEntries(completed.map((r) => [r.slaStatus, r._count.workItemId]));
  const met = completedCounts.MET ?? 0;
  const breached = completedCounts.BREACHED ?? 0;
  return { from: range.from, to: range.to, statusCounts, total: rows.reduce((n, r) => n + r._count.workItemId, 0), met, breached,
    attainmentPercent: met + breached ? Math.round(10000 * met / (met + breached)) / 100 : null };
}
