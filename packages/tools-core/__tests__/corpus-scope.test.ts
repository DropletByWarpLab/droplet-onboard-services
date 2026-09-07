/**
 * WARP-2821 — the one corpus-visibility rule, and the boundary it still has to
 * agree with by hand.
 *
 * This replaces `services/mcp-server/__tests__/chunk-owner.parity.test.ts`,
 * which asserted that two TypeScript files contained the same literal strings.
 * That guard could not have caught a third privileged role: every string it
 * checked would have been unchanged while the two resolvers diverged again.
 * There is now ONE implementation, called by both processes, so the TypeScript
 * half cannot drift — and the cases below test behaviour rather than spelling.
 *
 * 🔴 ONE PARITY CHECK SURVIVES, because one boundary genuinely cannot be
 * shared: the file-indexer that WRITES these sentinel owners is Python. Those
 * two format strings are asserted against `watcher.py` and `config.py`
 * directly. A mismatch there is silent — it reads as "the department has no
 * documents", not as an error — which is exactly the failure this whole ticket
 * was about.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient } from "@prisma/client";
import {
  HOUSEHOLD_INDEX_USER,
  deptSentinel,
  deptCorpusKeys,
  maxAclVersion,
  visibleDepartmentsFor,
} from "../src/corpus-scope.js";

const DEPT = "6e2c9e2a-1111-4c1a-9c1a-000000000001";
const HOUSE = "6e2c9e2a-9999-4c1a-9c1a-000000000009";

function prismaWith(all: unknown[], mine: unknown[]) {
  return {
    department: { findMany: vi.fn(async () => all) },
    departmentMembership: {
      findMany: vi.fn(async () => mine.map((department) => ({ department }))),
    },
  } as unknown as PrismaClient;
}

describe("visibleDepartmentsFor — who sees which departments (WARP-2821)", () => {
  it("gives an owner every ACTIVE department", async () => {
    const prisma = prismaWith([{ id: DEPT, kind: "TEAM", aclVersion: 3 }], []);
    const out = await visibleDepartmentsFor(prisma, { id: "u1", role: "owner" });
    expect(out.map((d) => d.id)).toEqual([DEPT]);
    expect(
      (prisma as unknown as { department: { findMany: ReturnType<typeof vi.fn> } }).department
        .findMany,
    ).toHaveBeenCalledWith({
      where: { state: "active" },
      select: { id: true, kind: true, aclVersion: true },
    });
  });

  it("treats an admin as privileged too", async () => {
    const prisma = prismaWith([{ id: DEPT, kind: "TEAM", aclVersion: 1 }], []);
    const out = await visibleDepartmentsFor(prisma, { id: "u1", role: "admin" });
    expect(out).toHaveLength(1);
  });

  it("gives everyone else only their OWN active memberships", async () => {
    // The line that matters: a member must never get the see-all branch.
    const prisma = prismaWith(
      [{ id: "other", kind: "TEAM", aclVersion: 9 }],
      [{ id: DEPT, kind: "TEAM", aclVersion: 2 }],
    );
    const out = await visibleDepartmentsFor(prisma, { id: "u1", role: "family" });
    expect(out.map((d) => d.id)).toEqual([DEPT]);
    expect(
      (prisma as unknown as { department: { findMany: ReturnType<typeof vi.fn> } }).department
        .findMany,
    ).not.toHaveBeenCalled();
  });

  it("treats an UNRECOGNISED role as unprivileged, not as an error", async () => {
    // Fail-restrictive: a role this function has never heard of gets the
    // narrow branch. A future role added elsewhere must not silently inherit
    // see-all by being unknown here.
    const prisma = prismaWith([{ id: "other", kind: "TEAM", aclVersion: 9 }], []);
    const out = await visibleDepartmentsFor(prisma, { id: "u1", role: "auditor" });
    expect(out).toEqual([]);
  });

  it("scopes the membership query to ACTIVE departments and to this user", async () => {
    const prisma = prismaWith([], []);
    await visibleDepartmentsFor(prisma, { id: "u-me", role: "guest" });
    expect(
      (prisma as unknown as {
        departmentMembership: { findMany: ReturnType<typeof vi.fn> };
      }).departmentMembership.findMany,
    ).toHaveBeenCalledWith({
      where: { userId: "u-me", department: { state: "active" } },
      select: { department: { select: { id: true, kind: true, aclVersion: true } } },
    });
  });

  it("THROWS on a database failure rather than answering 'no departments'", async () => {
    // Both callers degrade differently and neither should have the choice made
    // here: an empty list is indistinguishable from a real answer, and the
    // Files route would mint a cache key against it.
    const prisma = {
      department: { findMany: vi.fn(async () => { throw new Error("db down"); }) },
      departmentMembership: { findMany: vi.fn(async () => { throw new Error("db down"); }) },
    } as unknown as PrismaClient;
    await expect(visibleDepartmentsFor(prisma, { id: "u1", role: "owner" })).rejects.toThrow();
    await expect(visibleDepartmentsFor(prisma, { id: "u1", role: "family" })).rejects.toThrow();
  });
});

describe("deptCorpusKeys — the sentinel owners (WARP-2821)", () => {
  it("emits one sentinel per department", () => {
    expect(deptCorpusKeys([{ id: DEPT, kind: "TEAM", aclVersion: 0 }])).toEqual([
      `__dept_${DEPT}__`,
    ]);
  });

  it("DUAL-sentinels the household department, both forms", () => {
    // Old watcher builds wrote `__household__`; WARP-1264 builds write the
    // uuid form. Neither is reindexed, so emitting one hides half the drive.
    const keys = deptCorpusKeys([{ id: HOUSE, kind: "HOUSEHOLD", aclVersion: 0 }]);
    expect(keys).toContain(HOUSEHOLD_INDEX_USER);
    expect(keys).toContain(`__dept_${HOUSE}__`);
  });

  it("emits nothing for no departments", () => {
    expect(deptCorpusKeys([])).toEqual([]);
  });
});

describe("maxAclVersion (WARP-1556 cache key)", () => {
  it("takes the max, and 0 for none", () => {
    expect(maxAclVersion([])).toBe(0);
    expect(
      maxAclVersion([
        { id: "a", kind: "TEAM", aclVersion: 2 },
        { id: "b", kind: "TEAM", aclVersion: 7 },
      ]),
    ).toBe(7);
  });
});

/**
 * The only parity that still has to be asserted by hand. The producer of these
 * values is Python and cannot import this module.
 */
describe("sentinel parity with the file-indexer (WARP-2821)", () => {
  // `__dirname`, not `import.meta.url`: this package builds to CommonJS, and
  // `typecheck:tests` (WARP-2606) rejects `import.meta` in a CJS target. The
  // old parity test lived in the mcp-server, which is ESM, so this only bites
  // now that the check moved here.
  const REPO = resolve(__dirname, "..", "..", "..");
  const read = (rel: string) => readFileSync(resolve(REPO, rel), "utf8");

  it("uses the household sentinel config.py writes", () => {
    expect(read("services/file-indexer/config.py")).toContain(
      `HOUSEHOLD_USER_ID = "${HOUSEHOLD_INDEX_USER}"`,
    );
  });

  it("uses the department sentinel watcher.py writes", () => {
    // watcher.py:  f"__dept_{dept['id']}__"
    expect(read("services/file-indexer/watcher.py")).toContain('f"__dept_{dept[\'id\']}__"');
    expect(deptSentinel("X")).toBe("__dept_X__");
  });
});
