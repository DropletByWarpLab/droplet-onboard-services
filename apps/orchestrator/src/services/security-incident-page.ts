/**
 * WARP-2978 review R1 — route 16's page for a viewer who cannot see every
 * camera, ordered and paged by THEIR last activity.
 *
 * The stored `lastActivityAt` moves whenever any member camera is active, so
 * ordering a camera-limited viewer's list by it lets a camera they cannot see
 * reorder their list and move their page boundary (an incident skipped, or
 * shown twice). Here the order key is the viewer's projected last activity,
 * computed in SQL from `spanByCamera` over the entries they can see — the
 * exact rule of `projectedLastActivity` in security-incident-view.ts:
 *
 *   · an entry is seen when its camera is visible, or — the `""` entry of a
 *     camera-less event — when the incident is site-scoped;
 *   · none seen, or every entry seen → the stored `lastActivityAt`;
 *   · otherwise → the latest `last` among the seen entries.
 *
 * The WHERE is `incidentListWhere` (security-incident-view.ts) written for a
 * camera-limited viewer — visibility, the state and severity filters over
 * VISIBLE codes, the area. The cursor is `(projectedLast, id)`, the key the
 * rows are ordered by. Viewers who see every camera never come here: their
 * projection is the stored column, and the Prisma query keeps its index.
 *
 * The pg lane pins this query to the reference (Prisma's `incidentListWhere`
 * + `projectedLastActivity`) for generated incidents × viewers × every filter
 * (security-incident-list.pg.test.ts); the mocked lanes substitute that
 * reference for it.
 *
 * Timestamps: no time is converted in SQL (WARP-2980's static pin for every
 * Security service). The columns are `timestamp(3)` holding the UTC wall
 * clock, and the span strings and the cursor are `toISOString()` values —
 * always UTC, always ending `Z`. Cast `::timestamp`, Postgres reads such a
 * string's wall clock and ignores the zone mark, so the result is the UTC
 * wall clock whatever the session TimeZone (a `::timestamptz` cast would go
 * through it). The pg lane pins this under a +05:30 session.
 */
import { Prisma, type PrismaClient } from "@prisma/client";
import type { IncidentListFilters, IncidentViewer } from "./security-incident-view.js";

/** A page row: the incident and the key it was ordered by. */
export interface ProjectedIncidentKey {
  id: string;
  projectedLast: Date;
}

/** A viewer with a camera list (not `"all"`). */
export type CameraLimitedViewer = IncidentViewer & { visibleCameras: ReadonlySet<string> };

export async function projectedIncidentPage(
  prisma: PrismaClient,
  v: CameraLimitedViewer,
  f: IncidentListFilters,
  take: number,
): Promise<ProjectedIncidentKey[]> {
  const vis = [...v.visibleCameras];
  // visibleReasonWhere: a visible camera's code, or a camera-less one: site-wide
  // evidence (CHECK SecurityIncidentReason_site_evidence) that §6.2 groups only
  // into a site scope, where `reasonVisible` shows it too.
  // WARP-2979 — `reasonVisibleTo`'s related-camera and related-lock clauses (never NULL: relatedLock is NOT NULL,
  // and the camera clause is guarded by IS NULL).
  const visReason = Prisma.sql`((r."evidenceCamera" = ANY(${vis}::text[]) OR r."evidenceCamera" IS NULL) AND (r."relatedCamera" IS NULL OR r."relatedCamera" = ANY(${vis}::text[])) AND r."relatedLock" = false)`;
  const reasons = (extra: Prisma.Sql) =>
    Prisma.sql`EXISTS (SELECT 1 FROM "SecurityIncidentReason" r WHERE r."incidentId" = i."id" AND ${visReason}${extra})`;
  const someVisible = reasons(Prisma.empty);
  const visibleAlert = reasons(Prisma.sql` AND r."severity" = 'alert'`);
  const visibleNotice = reasons(Prisma.sql` AND r."severity" = 'notice'`);
  // PARTIAL — `projectIncident`'s rule (review b7e1): a reason AT THE
  // INCIDENT'S OWN (top) SEVERITY whose evidence the viewer cannot see. Per
  // reason, not per code (the same code on a hidden camera counts), and at
  // every top severity (a hidden notice under a notice-level incident too).
  const topHidden = Prisma.sql`EXISTS (SELECT 1 FROM "SecurityIncidentReason" r WHERE r."incidentId" = i."id" AND r."severity" = i."severity" AND NOT ${visReason})`;
  // Not partial: every reason at the top severity is visible.
  const full = Prisma.sql`(NOT ${topHidden})`;

  // incidentVisibilityWhere for a camera list.
  const where: Prisma.Sql[] = [
    v.mayReadThreats
      ? Prisma.sql`((i."scope" IN ('area', 'camera') AND i."cameras" && ${vis}::text[]) OR i."scope" IN ('site_camera_system', 'site_threat'))`
      : Prisma.sql`((i."scope" IN ('area', 'camera') AND i."cameras" && ${vis}::text[]) OR i."scope" = 'site_camera_system')`,
  ];
  switch (f.state) {
    case "attention":
    case "open":
      where.push(
        Prisma.sql`(${someVisible} AND ((i."state" = 'open' AND ${full}) OR (i."state" IN ('open', 'acknowledged') AND ${topHidden})))`,
      );
      break;
    case "acknowledged":
      where.push(Prisma.sql`(i."state" = 'acknowledged' AND ${someVisible} AND ${full})`);
      break;
    case "resolved":
      where.push(Prisma.sql`(i."state" = 'resolved' AND ${someVisible})`);
      break;
    case "activity":
      where.push(Prisma.sql`(i."state" = 'no_action' OR NOT ${someVisible})`);
      break;
    case "all":
      break;
  }
  if (f.severity === "alert") where.push(visibleAlert);
  if (f.severity === "notice") where.push(Prisma.sql`(${visibleNotice} AND NOT ${visibleAlert})`);
  if (f.zoneId) where.push(Prisma.sql`i."zoneId" = ${f.zoneId}`);

  const seen = Prisma.sql`((e.key = '' AND i."scope" IN ('site_threat', 'site_camera_system')) OR (e.key <> '' AND e.key = ANY(${vis}::text[])))`;
  const after = f.cursor
    ? Prisma.sql`WHERE (p."projectedLast", p."id") < (${f.cursor.at.toISOString()}::timestamp, ${f.cursor.id})`
    : Prisma.empty;

  return prisma.$queryRaw<ProjectedIncidentKey[]>`
    SELECT p."id", p."projectedLast" FROM (
      SELECT i."id",
             CASE WHEN s."shown" = 0 OR s."shown" = s."total" THEN i."lastActivityAt" ELSE s."shownLast" END AS "projectedLast"
      FROM "SecurityIncident" i
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS "total",
               (count(*) FILTER (WHERE ${seen}))::int AS "shown",
               max((e.value ->> 'last')::timestamp) FILTER (WHERE ${seen}) AS "shownLast"
        FROM jsonb_each(i."spanByCamera") AS e
      ) s
      WHERE ${Prisma.join(where, " AND ")}
    ) p
    ${after}
    ORDER BY p."projectedLast" DESC, p."id" DESC
    LIMIT ${take}::int`;
}
