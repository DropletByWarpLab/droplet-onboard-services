/**
 * WARP-3168 — the owner/admin list of links on company data made by people
 * who are not owner/admin (before WARP-3053, or in Nextcloud directly).
 */
import { describe, it, expect } from "vitest";

import { listMemberCompanyLinks, type NcShareRow } from "./company-link-audit.service.js";

const people = [
  { id: "u-owner", displayName: "Olivia Owner", nextcloudUsername: "olivia", role: "owner" },
  { id: "u-admin", displayName: "Adam Admin", nextcloudUsername: "adam", role: "admin" },
  { id: "u-mem", displayName: "Mia Member", nextcloudUsername: "mia", role: "family" },
  { id: "u-guest", displayName: "Gus Guest", nextcloudUsername: "gus", role: "guest" },
];

function row(over: Partial<NcShareRow>): NcShareRow {
  return {
    id: 1,
    shareType: 3,
    permissions: 1,
    initiator: "mia",
    cachePath: "__groupfolders/1/Contracts/nda.pdf",
    stime: 1_758_000_000,
    expiration: null,
    ...over,
  };
}

function run(rows: NcShareRow[], opts: { registry?: Array<{ ncShareId: number; createdById: string }>; folders?: Array<{ id: number; mountPoint: string }> } = {}) {
  return listMemberCompanyLinks({
    queryShares: async () => rows,
    listFolders: async () => opts.folders ?? [{ id: 1, mountPoint: "Household" }, { id: 2, mountPoint: "Finance" }],
    serviceUser: "droplet-svc",
    prisma: {
      departmentShare: { findMany: async () => opts.registry ?? [] },
      user: {
        findMany: async (args: { where: { OR: [{ nextcloudUsername: { in: string[] } }, { id: { in: string[] } }] } }) => {
          const [{ nextcloudUsername }, { id }] = args.where.OR;
          return people.filter((p) => nextcloudUsername.in.includes(p.nextcloudUsername) || id.in.includes(p.id));
        },
      },
    } as never,
  });
}

describe("listMemberCompanyLinks (WARP-3168)", () => {
  it("lists a member's public link on the Workspace with library, path and person", async () => {
    const links = await run([row({})]);
    expect(links).toEqual([
      {
        shareId: 1,
        shareType: 3,
        permissions: 1,
        library: "Household",
        path: "/Contracts/nda.pdf",
        createdBy: { userId: "u-mem", name: "Mia Member", role: "family" },
        createdAt: new Date(1_758_000_000 * 1000).toISOString(),
        expiresAt: null,
      },
    ]);
  });

  it("skips owner and admin links, which the rule allows", async () => {
    const links = await run([row({ id: 1, initiator: "olivia" }), row({ id: 2, initiator: "adam" })]);
    expect(links).toEqual([]);
  });

  it("lists email links, re-share grants and guests, but not a plain internal share", async () => {
    const links = await run([
      row({ id: 1, shareType: 4 }),
      row({ id: 2, shareType: 0, permissions: 1 | 16 }),
      row({ id: 3, shareType: 3, initiator: "gus" }),
      row({ id: 4, shareType: 0, permissions: 15 }),
      row({ id: 5, shareType: 2, permissions: 31 }), // group-share child copy
    ]);
    expect(links.map((l) => l.shareId).sort()).toEqual([1, 2, 3]);
  });

  it("names the manager behind a department link minted by the service account", async () => {
    const links = await run(
      [row({ id: 7, initiator: "droplet-svc", cachePath: "__groupfolders/2/Budget.xlsx" })],
      { registry: [{ ncShareId: 7, createdById: "u-mem" }] },
    );
    expect(links[0]).toMatchObject({ library: "Finance", path: "/Budget.xlsx", createdBy: { userId: "u-mem" } });
  });

  it("an admin's department link through the service account is not listed", async () => {
    const links = await run(
      [row({ id: 7, initiator: "droplet-svc", cachePath: "__groupfolders/2/Budget.xlsx" })],
      { registry: [{ ncShareId: 7, createdById: "u-admin" }] },
    );
    expect(links).toEqual([]);
  });

  it("fails closed: a creator the box cannot name is listed", async () => {
    const links = await run([row({ initiator: "stranger" }), row({ id: 2, initiator: "droplet-svc" })]);
    expect(links.map((l) => l.createdBy)).toEqual([
      { userId: null, name: "stranger", role: null },
      { userId: null, name: "Box service account", role: null },
    ]);
  });

  it("an unknown folder id still lists the link (a failed folder listing never reads as none)", async () => {
    const links = await run([row({ cachePath: "__groupfolders/9/x.txt" })], { folders: [] });
    expect(links[0]).toMatchObject({ library: "Library #9", path: "/x.txt" });
  });

  it("skips trash and versions, and names a link on a library root '/'", async () => {
    const links = await run([
      row({ id: 1, cachePath: "__groupfolders/trash/1/old.pdf.d123" }),
      row({ id: 2, cachePath: "__groupfolders/versions/1/5" }),
      row({ id: 3, cachePath: "__groupfolders/1" }),
    ]);
    expect(links.map((l) => [l.shareId, l.path])).toEqual([[3, "/"]]);
  });
});
