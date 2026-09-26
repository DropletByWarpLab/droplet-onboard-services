/**
 * WARP-3168 — list the links on company data that leave the company and were
 * created by someone who is not an owner or admin.
 *
 * WARP-3053 made the box refuse those links for members, but it could not
 * touch the ones that already existed, nor links made in Nextcloud directly.
 * This lists them for an owner/admin. It NEVER revokes: the admin decides.
 *
 * Source: Nextcloud's own share table, read-only. The OCS share API only lists
 * the caller's own shares, and the box holds a member's Nextcloud credential
 * only while their session is live, so the table is the one complete view.
 * The orchestrator reads it the way file-indexer already does (WARP-1140): the
 * same Postgres, database `nextcloud`, with the box's own role.
 *
 * "Company data" = anything inside a groupfolder (the Workspace and every
 * department/team library). Their filecache rows live under
 * `__groupfolders/<id>/...`; trash and versions (`__groupfolders/trash/...`)
 * are not live data and are skipped. "Leaves the company" is exactly
 * `exposesOutside` from share-policy.ts, so this list and the box's refusal
 * can never disagree about what counts.
 */
import { PrismaClient } from "@prisma/client";
import type { Role } from "@prisma/client";

import { config } from "../config.js";
import { exposesOutside, mayCreatePublicLink } from "./share-policy.js";

/** One share row as read from Nextcloud's table. */
export interface NcShareRow {
  id: number;
  shareType: number;
  permissions: number;
  /** oc_share.uid_initiator: the Nextcloud user who created it. */
  initiator: string;
  /** oc_filecache.path, e.g. `__groupfolders/3/Contracts/nda.pdf`. */
  cachePath: string;
  /** Unix seconds. */
  stime: number;
  expiration: Date | null;
}

export interface CompanyLinkPerson {
  userId: string | null;
  name: string;
  role: Role | null;
}

export interface CompanyLink {
  shareId: number;
  shareType: number;
  permissions: number;
  /** The library's mount name (e.g. `Household`, `Finance`). */
  library: string;
  /** Path inside the library, `/` for the library root. */
  path: string;
  createdBy: CompanyLinkPerson;
  createdAt: string;
  expiresAt: string | null;
}

export interface CompanyLinkAuditDeps {
  /** Every share on a groupfolder item that exposesOutside may flag. */
  queryShares(): Promise<NcShareRow[]>;
  /** groupfolder id -> mount name. */
  listFolders(): Promise<Array<{ id: number; mountPoint: string }>>;
  prisma: Pick<PrismaClient, "user" | "departmentShare">;
  /** The box's Nextcloud service account (mints department shares). */
  serviceUser: string;
}

const GROUPFOLDER_PATH = /^__groupfolders\/(\d+)(?:\/(.*))?$/;

export async function listMemberCompanyLinks(deps: CompanyLinkAuditDeps): Promise<CompanyLink[]> {
  // Type 2 rows are Nextcloud's per-recipient copies of a group share (1);
  // the group share itself is judged, so its copies would only duplicate it.
  const rows = (await deps.queryShares()).filter(
    (r) => r.shareType !== 2 && exposesOutside(r.shareType, r.permissions),
  );
  if (rows.length === 0) return [];

  const folders = new Map((await deps.listFolders()).map((f) => [f.id, f.mountPoint]));

  // Department links are minted by the service account on a manager's
  // behalf; the registry names the person (WARP-1269).
  const registry = await deps.prisma.departmentShare.findMany({
    where: { ncShareId: { in: rows.map((r) => r.id) } },
    select: { ncShareId: true, createdById: true },
  });
  const creatorIdByShare = new Map(registry.map((d) => [d.ncShareId, d.createdById]));

  const ncUsers = [...new Set(rows.map((r) => r.initiator))];
  const people = await deps.prisma.user.findMany({
    where: { OR: [{ nextcloudUsername: { in: ncUsers } }, { id: { in: [...creatorIdByShare.values()] } }] },
    select: { id: true, displayName: true, nextcloudUsername: true, role: true },
  });
  const byNcUser = new Map(people.filter((p) => p.nextcloudUsername).map((p) => [p.nextcloudUsername!, p]));
  const byId = new Map(people.map((p) => [p.id, p]));

  const links: CompanyLink[] = [];
  for (const r of rows) {
    const m = GROUPFOLDER_PATH.exec(r.cachePath);
    if (!m) continue; // trash/versions, or not a groupfolder item
    // An unnamed folder is still company data. Naming it by id (rather than
    // skipping it) keeps a failed folder listing from reading as "no links".
    const library = folders.get(Number(m[1])) ?? `Library #${m[1]}`;

    const creatorId = creatorIdByShare.get(r.id);
    const person = creatorId ? byId.get(creatorId) : byNcUser.get(r.initiator);
    // Owner/admin links are allowed; everything else is listed, including a
    // creator the box cannot name (fail closed: the admin sees it).
    if (person && mayCreatePublicLink(person.role, "company")) continue;

    links.push({
      shareId: r.id,
      shareType: r.shareType,
      permissions: r.permissions,
      library,
      path: `/${m[2] ?? ""}`,
      createdBy: person
        ? { userId: person.id, name: person.displayName, role: person.role }
        : {
            userId: null,
            name: r.initiator === deps.serviceUser ? "Box service account" : r.initiator,
            role: null,
          },
      createdAt: new Date(r.stime * 1000).toISOString(),
      expiresAt: r.expiration ? r.expiration.toISOString() : null,
    });
  }
  return links.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Nextcloud's database URL: NEXTCLOUD_DATABASE_URL, else the box's own URL with the db swapped (as file-indexer). */
export function nextcloudDatabaseUrl(): string {
  if (process.env.NEXTCLOUD_DATABASE_URL) return process.env.NEXTCLOUD_DATABASE_URL;
  const url = new URL(config.DATABASE_URL);
  url.pathname = "/nextcloud";
  return url.toString();
}

/**
 * Read-only query of Nextcloud's share table. A short-lived client with no
 * models: the one query is raw SQL, and only this route pays for it.
 */
export async function queryNextcloudCompanyShares(): Promise<NcShareRow[]> {
  const nc = new PrismaClient({ datasourceUrl: nextcloudDatabaseUrl() });
  try {
    const rows = await nc.$queryRaw<
      Array<{
        id: string;
        share_type: number;
        permissions: number;
        uid_initiator: string | null;
        uid_owner: string;
        path: string;
        stime: string;
        expiration: Date | null;
      }>
    >`
      SELECT s.id::text AS id, s.share_type::int AS share_type, s.permissions::int AS permissions,
             s.uid_initiator, s.uid_owner, f.path, s.stime::text AS stime, s.expiration
        FROM oc_share s
        JOIN oc_filecache f ON f.fileid = s.file_source
       WHERE substr(f.path, 1, 15) = '__groupfolders/'
         AND s.share_type <> 2
         AND (s.share_type NOT IN (0, 1) OR (s.permissions & 16) <> 0)`;
    return rows.map((r) => ({
      id: Number(r.id),
      shareType: r.share_type,
      permissions: r.permissions,
      initiator: r.uid_initiator ?? r.uid_owner,
      cachePath: r.path,
      stime: Number(r.stime),
      expiration: r.expiration,
    }));
  } finally {
    await nc.$disconnect();
  }
}
