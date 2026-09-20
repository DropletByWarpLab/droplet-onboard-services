/**
 * WARP-1996 — seed the `daily-report` ToolSpec.
 *
 * Without this the Reports narrative tile has nothing to run: `POST
 * /api/tools/daily-report/runs` 404s on a box where the spec was never
 * created, and the tile's "Write report" button fails with nothing the user
 * can do about it.
 *
 * Idempotent, and deliberately NON-DESTRUCTIVE on re-run: if the spec already
 * exists it is left exactly as it is. An operator who edited the steps — or
 * a future version that shipped different ones — must not have that
 * overwritten by a re-seed. Same posture as `seedWorkspaceSettings`.
 */

import type { PrismaClient } from "@prisma/client";

export const DAILY_REPORT_SLUG = "daily-report";

/**
 * The composed steps, in run order. Every tool here is registered in
 * `@droplet/tools-core`; a name that isn't would fail the §3 pre-flight at
 * run time rather than at seed time, so keep this list honest.
 *
 * Read-only by construction — nothing here writes, which is what lets the
 * spec run unattended on any box without a confirmation step.
 */
/**
 * Every read is `optional: true`. The runner halts a run on the first failed
 * step by default (its C1 contract), which for a report meant one source a
 * box does not have — no cameras, no ERP — killed the narrative outright
 * and the tile showed "Couldn't write the report". Optional steps are still
 * recorded as failed in the trace and reach the summarizer as
 * "COULD NOT BE READ"; sources that are simply not connected are omitted
 * from the prose (see the summarizer's rules), so only the sources the
 * person actually has appear in the report.
 */
const read = (tool: string, args: Record<string, unknown> = {}) =>
  ({ kind: "call", args: { tool, args, optional: true } }) as const;

const STEPS: Array<{ kind: "call" | "summarize"; args: Record<string, unknown> }> = [
  read("get_system_health"),
  read("list_recent_files"),
  read("network_summary"),
  read("get_camera_health"),
  // Per-user sources — these are `ctx.userId`-gated in tools-core and only
  // work because the run-now route forwards the caller's identity.
  read("list_events", { limit: 10 }),
  // The ERP reads answer ERP_NOT_CONNECTED on a box with no connector; that
  // is a not-connected source and the narrative leaves it out.
  read("erp_get_ar_summary"),
  read("erp_get_schedule_today"),
  { kind: "summarize", args: {} },
];

export interface SeedResult {
  created: boolean;
  slug: string;
}

export async function seedDailyReportSpec(prisma: PrismaClient): Promise<SeedResult> {
  const existing = await prisma.toolSpec.findUnique({
    where: { slug: DAILY_REPORT_SLUG },
    select: { id: true },
  });
  if (existing) return { created: false, slug: DAILY_REPORT_SLUG };

  await prisma.toolSpec.create({
    data: {
      slug: DAILY_REPORT_SLUG,
      name: "Daily report",
      category: "reports",
      description:
        "Gathers the day's system, file, network, camera and billing facts and writes them up as a short briefing.",
      // Live so the Reports tile can run it immediately; a draft would need
      // an operator to publish it before the surface worked at all.
      status: "live",
      safety: 1,
      writes: false,
      reversible: true,
      steps: {
        create: STEPS.map((s, idx) => ({ idx, kind: s.kind, args: s.args as never })),
      },
    },
  });

  return { created: true, slug: DAILY_REPORT_SLUG };
}
