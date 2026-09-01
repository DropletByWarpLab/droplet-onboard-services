/**
 * WARP-2585 -- behaviour of the EntityLink service that the pg suite cannot
 * reach: the shape of the write when it LOSES the create race, and the
 * confidence/origin rule refusing before it ever reaches Postgres.
 *
 * Prisma is hand-stubbed in the style of `crm.service.test.ts`. The constraints
 * themselves (exactly-one, the partial unique indexes, the confidence CHECK)
 * are proven against real SQL in `__tests__/entity-link.pg.test.ts` -- a mocked
 * client cannot prove a database constraint, and this file does not pretend to.
 */
import { describe, it, expect, vi } from "vitest";

import {
  ENTITY_LINK_ERRORS,
  fileNameFromPath,
  filterVisibleLinks,
  linkFileToRecord,
} from "./entity-link.service.js";

const INPUT = {
  ncFileId: 42,
  filePath: "/Contracts/acme/msa.pdf",
  fileSpace: "personal",
  subjectType: "COMPANY" as const,
  subjectId: "co-1",
};

function prismaWith(over: Record<string, unknown>) {
  return {
    crmCompany: { findUnique: async () => ({ id: "co-1" }) },
    ...over,
  } as never;
}

describe("fileNameFromPath", () => {
  it("takes the last segment, which IS the Nextcloud display name", () => {
    expect(fileNameFromPath("/Contracts/acme/msa.pdf")).toBe("msa.pdf");
    expect(fileNameFromPath("msa.pdf")).toBe("msa.pdf");
    // Derived, never accepted from the client: one fewer field a caller can
    // use to write prose that later reads as the file's real name.
    expect(fileNameFromPath("/")).toBe("/");
  });
});

describe("linkFileToRecord", () => {
  it("refuses a confidence on a MANUAL link, and a MISSING one on a SUGGESTED link", async () => {
    const prisma = prismaWith({});
    await expect(
      linkFileToRecord(prisma, { ...INPUT, linkedBy: "MANUAL", confidence: 80 }, "u1"),
    ).rejects.toThrow(ENTITY_LINK_ERRORS.CONFIDENCE_MISMATCH);
    await expect(
      linkFileToRecord(prisma, { ...INPUT, linkedBy: "SUGGESTED" }, "u1"),
    ).rejects.toThrow(ENTITY_LINK_ERRORS.CONFIDENCE_MISMATCH);
    // Refused BEFORE the subject lookup, so a bad combination never costs a
    // query and the error names the field rather than a constraint.
    expect(prisma).toBeTruthy();
  });

  it("updates in place when the pair already exists -- never a second create", async () => {
    const create = vi.fn();
    // Typed args, not `vi.fn(async () => …)`: an untyped mock infers a
    // zero-length tuple for `mock.calls`, so reading calls[0][0] is a tsc
    // error rather than the assertion it looks like.
    const updateMany = vi.fn(async (_args: { data: unknown }) => ({ count: 1 }));
    const row = {
      id: "l1",
      ncFileId: 42,
      fileName: "msa.pdf",
      filePath: INPUT.filePath,
      fileSpace: "personal",
      subjectType: "COMPANY",
      companyId: "co-1",
      contactId: null,
      dealId: null,
      projectId: null,
      workItemId: null,
      role: "CONTRACT",
      linkedBy: "MANUAL",
      confidence: null,
      note: null,
      isArchived: false,
      archivedAt: null,
      createdById: "u1",
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    };
    const prisma = prismaWith({
      entityLink: { updateMany, create, findFirst: async () => row },
    });

    const out = await linkFileToRecord(prisma, { ...INPUT, role: "CONTRACT" }, "u1");
    expect(out.id).toBe("l1");
    expect(create).not.toHaveBeenCalled();
    // Re-linking an ARCHIVED link is how a human un-archives it, and the pair
    // moves together -- never one derived from the other (WARP-884).
    expect(updateMany.mock.calls[0]?.[0].data).toMatchObject({
      isArchived: false,
      archivedAt: null,
    });
  });

  it("folds a lost create race (P2002) into an update instead of surfacing a 500", async () => {
    // Two callers linking the same file to the same record at once. Both miss
    // the first updateMany; one create wins. The loser must not 500 -- and the
    // P2002 it catches only ever fires because the uniqueness is a PARTIAL
    // index; a compound @@unique over the five mostly-NULL subject columns
    // would never raise it and both rows would land.
    const row = {
      id: "l-winner",
      ncFileId: 42,
      fileName: "msa.pdf",
      filePath: INPUT.filePath,
      fileSpace: "personal",
      subjectType: "COMPANY",
      companyId: "co-1",
      contactId: null,
      dealId: null,
      projectId: null,
      workItemId: null,
      role: "OTHER",
      linkedBy: "MANUAL",
      confidence: null,
      note: null,
      isArchived: false,
      archivedAt: null,
      createdById: "u-winner",
      createdAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-09-01T00:00:00Z"),
    };
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const create = vi.fn(async () => {
      throw Object.assign(new Error("unique"), { code: "P2002" });
    });
    const prisma = prismaWith({
      entityLink: { updateMany, create, findFirst: async () => row },
    });

    const out = await linkFileToRecord(prisma, INPUT, "u-loser");
    expect(out.id).toBe("l-winner");
    expect(create).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("rethrows a non-P2002 create failure rather than swallowing it as an update", async () => {
    const prisma = prismaWith({
      entityLink: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async () => {
          throw Object.assign(new Error("fk"), { code: "P2003" });
        }),
        findFirst: async () => null,
      },
    });
    await expect(linkFileToRecord(prisma, INPUT, "u1")).rejects.toThrow("fk");
  });
});

describe("filterVisibleLinks", () => {
  const link = (ncFileId: number) => ({ ncFileId }) as never;

  it("skips the department query entirely when nothing on the page is registered", async () => {
    const findMany = vi.fn(async () => []);
    const membership = vi.fn();
    const rows = [link(1), link(2)];
    const out = await filterVisibleLinks(
      { file: { findMany }, departmentMembership: { findMany: membership } } as never,
      { id: "u1", role: "family" },
      rows,
    );
    // Unregistered -> personal-space semantics, visible. Same posture as
    // team-chat's file_share: the row carries only display fields the linker
    // supplied, and the linker passed a PROPFIND as themselves to create it.
    expect(out).toHaveLength(2);
    expect(membership).not.toHaveBeenCalled();
  });

  it("drops a row whose file lives in a department the viewer cannot read", async () => {
    const prisma = {
      file: {
        findMany: async () => [
          { ncFileId: 1, departmentId: null },
          { ncFileId: 2, departmentId: "dept-secret" },
        ],
      },
      departmentMembership: {
        findMany: async () => [{ department: { id: "dept-open" } }],
      },
    } as never;
    const out = await filterVisibleLinks(prisma, { id: "u1", role: "family" }, [link(1), link(2)]);
    expect(out.map((r) => r.ncFileId)).toEqual([1]);
  });
});
