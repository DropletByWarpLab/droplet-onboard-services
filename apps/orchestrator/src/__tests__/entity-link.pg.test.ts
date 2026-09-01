/**
 * WARP-2585 -- the EntityLink invariants only a REAL Postgres can prove, plus
 * the one equivalence that keeps the read filter from drifting.
 *
 * WHY THESE CASES RUN HERE, and not in the DB-less lane:
 *
 *   exactly-one   -- `EntityLink_subject_exactly_one` is raw migration SQL.
 *                    Prisma's schema language cannot express an XOR, so a
 *                    mocked client will happily "write" a row with two subjects
 *                    or with a subjectType that disagrees with the column that
 *                    is set. Only Postgres refuses.
 *   uniqueness    -- and this is the case worth reading. The design brief
 *                    specified `@@unique([ncFileId, companyId, contactId,
 *                    dealId, projectId, workItemId])`. That index would reject
 *                    NOTHING: four of the five subject columns are NULL on
 *                    every row, NULL never equals NULL, so no two rows ever
 *                    collide and P2002 never fires -- which would also make the
 *                    brief's own prescribed P2002 retry dead code. The shipped
 *                    schema uses five PARTIAL unique indexes instead. The test
 *                    below fails if anyone "simplifies" it back.
 *   cascade       -- deleting a record takes its links. Forced, not chosen:
 *                    the CHECK forbids an orphan, so a subject column cannot be
 *                    SetNull (the CrmActivity ruling, same shape).
 *   read filter   -- a link carries a file NAME. An unfiltered listing tells a
 *                    reader a file they cannot open exists and what it is
 *                    called. Proven against real `File` registry rows and real
 *                    `DepartmentMembership`.
 *   equivalence   -- `readableDepartmentIdsFor` is a SECOND reader of the
 *                    `checkSpaceAccess` truth table, taken because per-row
 *                    checkSpaceAccess would emit an audited denial per hidden
 *                    document per page load. Two readers of one table drift.
 *                    This asserts them equal across roles and membership, so
 *                    the drift is a red test rather than a leak.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL like every other `*.pg.test.ts`.
 * Local: scripts/test-orchestrator-pg.sh. CI: the `pg-integration` job.
 *
 * FIXTURE SCOPING -- this DB is shared by the pg suites and the lane runs
 * --no-file-parallelism. Every row is namespaced `warp2582-` and every cleanup
 * is scoped to that prefix; ncFileIds sit in a reserved 2582xx range. Never an
 * unscoped deleteMany, never a TRUNCATE (the access-role.pg.test.ts rule).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

// The DB-less lane's global setup mocks @prisma/client; this file needs the
// real driver (access-role.pg.test.ts precedent).
vi.unmock("@prisma/client");

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
  },
}));

// Leaf EFFECTS are mocked; every DECISION is real (the rbac lane idiom).
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn().mockResolvedValue("warp2582-token"),
}));
// The PROPFIND is Nextcloud's answer, not Postgres's -- stubbed to the fixture
// id so the DROPLET-side half of the gate is what this suite actually measures.
// `vi.mock` is hoisted above every top-level const, so a factory that closes
// over one throws "Cannot access before initialization". `vi.hoisted` is the
// documented way to share a mock fn with the factory. (vitest 3 also takes the
// whole function type as ONE type argument, not the pair vitest 1 used.)
const { ncGetFileId } = vi.hoisted(() => ({
  ncGetFileId: vi.fn<(a: string, b: string, c: string) => Promise<number | null>>(),
}));
vi.mock("../services/nextcloud.client.js", () => ({ ncGetFileId }));

import { createCrmEntityLinksRouter } from "../routes/crm-entity-links.js";
import { checkSpaceAccess, readableDepartmentIdsFor } from "../middleware/space.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("EntityLink -- real Postgres (WARP-2585)", () => {
  let prisma: PrismaClient;

  const PREFIX = "warp2582-";
  const OURS = { startsWith: PREFIX } as const;
  const NC_PERSONAL = 258_201;
  const NC_DEPT = 258_202;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  async function cleanup() {
    // FK-ordered and scoped. Links cascade with their subject, but a failed run
    // can leave one whose subject we are about to delete, so they go first.
    await prisma.entityLink.deleteMany({ where: { filePath: OURS } });
    await prisma.crmDeal.deleteMany({ where: { title: OURS } });
    await prisma.crmCompany.deleteMany({ where: { name: OURS } });
    await prisma.crmPipeline.deleteMany({ where: { name: OURS } });
    await prisma.file.deleteMany({ where: { ncFileId: { in: [NC_PERSONAL, NC_DEPT] } } });
    await prisma.departmentMembership.deleteMany({ where: { department: { slug: OURS } } });
    await prisma.department.deleteMany({ where: { slug: OURS } });
    await prisma.user.deleteMany({ where: { username: OURS } });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ncGetFileId.mockResolvedValue(NC_PERSONAL);
    await cleanup();
  });

  // Clean at end-of-suite too: rail 5 in rbac-v2-guard-rails.pg.test.ts counts
  // operators BOX-WIDE, so an ACTIVE owner/admin left behind reads as a foreign
  // operator there and fails its last-operator premise.
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  // ── fixtures ────────────────────────────────────────────────────

  async function mkUser(suffix: string, role: "owner" | "admin" | "family" | "guest") {
    const username = `${PREFIX}${suffix}`;
    return prisma.user.create({
      data: {
        username,
        displayName: username,
        nextcloudUsername: username,
        role,
        directoryStatus: "ACTIVE",
      },
    });
  }

  async function mkCompany(suffix = "acme") {
    return prisma.crmCompany.create({ data: { name: `${PREFIX}${suffix}` } });
  }

  function buildApp(actor: { id: string; username: string; role: string }) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user: typeof actor }).user = { ...actor };
      next();
    });
    app.use("/api", createCrmEntityLinksRouter(prisma));
    return app;
  }

  const asActor = (u: { id: string; username: string; role: string }) => ({
    id: u.id,
    username: u.username,
    role: u.role,
  });

  /** A bare request shaped enough for recordAccessDenied's `${method} ${path}`. */
  const fakeReq = (u: { id: string; role: string }) =>
    ({ method: "GET", path: "/api/crm/entity-links", user: u }) as unknown as Request;

  // ── EntityLink_subject_exactly_one ──────────────────────────────────

  const base = {
    ncFileId: NC_PERSONAL,
    fileName: "contract.pdf",
    filePath: `${PREFIX}docs/contract.pdf`,
    fileSpace: "personal",
  };

  it("refuses a link with NO subject", async () => {
    // MUTATION: drop the `= 1` arm of the CHECK and this row is accepted --
    // an attachment to nothing, invisible to every listing.
    await expect(
      prisma.entityLink.create({ data: { ...base, subjectType: "COMPANY" } }),
    ).rejects.toThrow();
  });

  it("refuses a link with TWO subjects", async () => {
    const company = await mkCompany();
    const pipeline = await prisma.crmPipeline.create({
      data: {
        name: `${PREFIX}pipeline`,
        // NOT the default: `CrmPipeline_one_default` is a box-wide partial
        // unique index and claiming it would collide with a real pipeline.
        isDefault: false,
        stages: { create: { name: `${PREFIX}stage`, kind: "OPEN", sortOrder: 0 } },
      },
      include: { stages: true },
    });
    const deal = await prisma.crmDeal.create({
      data: {
        title: `${PREFIX}deal`,
        pipelineId: pipeline.id,
        stageId: pipeline.stages[0].id,
      },
    });
    await expect(
      prisma.entityLink.create({
        data: { ...base, subjectType: "COMPANY", companyId: company.id, dealId: deal.id },
      }),
    ).rejects.toThrow();
  });

  it("refuses a subjectType that disagrees with the column that is set", async () => {
    const company = await mkCompany();
    // The half of the constraint a naive `= 1` check would miss. Without the
    // agreement clauses this row is legal, and every listing built on
    // subjectType silently drops it -- the CrmActivity defect, pre-empted.
    await expect(
      prisma.entityLink.create({
        data: { ...base, subjectType: "DEAL", companyId: company.id },
      }),
    ).rejects.toThrow();
  });

  // ── confidence <-> origin ─────────────────────────────────────────

  it("refuses a confidence on a MANUAL link and a missing one on a SUGGESTED link", async () => {
    const company = await mkCompany();
    await expect(
      prisma.entityLink.create({
        data: { ...base, subjectType: "COMPANY", companyId: company.id, linkedBy: "MANUAL", confidence: 90 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.entityLink.create({
        data: { ...base, subjectType: "COMPANY", companyId: company.id, linkedBy: "SUGGESTED" },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.entityLink.create({
        data: { ...base, subjectType: "COMPANY", companyId: company.id, linkedBy: "EXTRACTED", confidence: 101 },
      }),
    ).rejects.toThrow();

    const ok = await prisma.entityLink.create({
      data: { ...base, subjectType: "COMPANY", companyId: company.id, linkedBy: "SUGGESTED", confidence: 72 },
    });
    expect(ok.confidence).toBe(72);
  });

  // ── the partial unique index the brief's compound @@unique would not be ──

  it("rejects a SECOND link of the same file to the same record -- and would not with a compound @@unique", async () => {
    const company = await mkCompany();
    await prisma.entityLink.create({
      data: { ...base, subjectType: "COMPANY", companyId: company.id },
    });
    // THE POINT OF THIS FILE. With `@@unique([ncFileId, companyId, contactId,
    // dealId, projectId, workItemId])` this create SUCCEEDS -- contactId,
    // dealId, projectId and workItemId are NULL, NULL never equals NULL, so
    // the rows are not duplicates as far as the index is concerned. It is the
    // `WHERE "companyId" IS NOT NULL` predicate that makes this throw.
    await expect(
      prisma.entityLink.create({
        data: { ...base, subjectType: "COMPANY", companyId: company.id, role: "SCAN" },
      }),
    ).rejects.toThrow();

    // ...and the same file on a DIFFERENT record is not a duplicate.
    const other = await mkCompany("other");
    const second = await prisma.entityLink.create({
      data: { ...base, subjectType: "COMPANY", companyId: other.id },
    });
    expect(second.id).toBeTruthy();
  });

  it("deleting the record deletes its links (Cascade is forced, not chosen)", async () => {
    const company = await mkCompany();
    await prisma.entityLink.create({
      data: { ...base, subjectType: "COMPANY", companyId: company.id },
    });
    await prisma.crmCompany.delete({ where: { id: company.id } });
    // MUTATION: change the relation to SetNull and the delete throws instead --
    // the CHECK forbids the orphan the SetNull would create.
    expect(await prisma.entityLink.count({ where: { filePath: OURS } })).toBe(0);
  });

  // ── the read filter ─────────────────────────────────────────────

  it("a link to a department file is INVISIBLE to a non-member and visible to a member", async () => {
    const owner = await mkUser("owner", "owner");
    const alice = await mkUser("alice", "family"); // member
    const bob = await mkUser("bob", "family"); // NOT a member
    const company = await mkCompany();

    const dept = await prisma.department.create({
      data: {
        name: `${PREFIX}finance`,
        slug: `${PREFIX}finance`,
        kind: "DEPARTMENT",
        state: "active",
        createdBy: owner.id,
      },
    });
    await prisma.departmentMembership.create({
      data: {
        departmentId: dept.id,
        userId: alice.id,
        right: "reader",
        syncState: "synced",
        grantedBy: owner.id,
      },
    });
    await prisma.file.create({
      data: {
        ncFileId: NC_DEPT,
        ownerUserId: alice.id,
        departmentId: dept.id,
        path: `/${PREFIX}finance/master-services-agreement.pdf`,
      },
    });
    const link = await prisma.entityLink.create({
      data: {
        ncFileId: NC_DEPT,
        fileName: "master-services-agreement.pdf",
        filePath: `${PREFIX}finance/master-services-agreement.pdf`,
        fileSpace: `dept:${dept.id}`,
        subjectType: "COMPANY",
        companyId: company.id,
        role: "CONTRACT",
      },
    });

    const q = `/api/crm/entity-links?subject_type=COMPANY&subject_id=${company.id}`;

    // Bob is a legitimate CRM reader and sees the company. He must not learn
    // that a file called "master-services-agreement.pdf" exists.
    const hidden = await request(buildApp(asActor(bob))).get(q);
    expect(hidden.status).toBe(200);
    expect(hidden.body.links).toEqual([]);
    // The total is POST-filter. An unfiltered total would leak the count and
    // therefore the existence -- which is the whole point.
    expect(hidden.body.total).toBe(0);
    // By id, the answer is 404 and never 403: a 403 confirms the row.
    expect((await request(buildApp(asActor(bob))).get(`/api/crm/entity-links/${link.id}`)).status).toBe(404);

    const seen = await request(buildApp(asActor(alice))).get(q);
    expect(seen.status).toBe(200);
    expect(seen.body.links).toHaveLength(1);
    expect(seen.body.links[0].fileName).toBe("master-services-agreement.pdf");
    expect(seen.body.links[0].subjectId).toBe(company.id);
  });

  it("POST refuses to link a department file the caller cannot read, and stores nothing", async () => {
    const owner = await mkUser("owner", "owner");
    const bob = await mkUser("bob", "family");
    const company = await mkCompany();
    const dept = await prisma.department.create({
      data: {
        name: `${PREFIX}legal`,
        slug: `${PREFIX}legal`,
        kind: "DEPARTMENT",
        state: "active",
        createdBy: owner.id,
      },
    });
    await prisma.file.create({
      data: {
        ncFileId: NC_DEPT,
        ownerUserId: owner.id,
        departmentId: dept.id,
        path: `/${PREFIX}legal/nda.pdf`,
      },
    });
    // Step 1 of the gate SUCCEEDS -- a groupfolder is mounted into the member's
    // home, so a PROPFIND can answer for a file Droplet policy says no to. Step
    // 2 is what refuses. This is why routes/files.ts runs both.
    ncGetFileId.mockResolvedValue(NC_DEPT);

    const res = await request(buildApp(asActor(bob)))
      .post("/api/crm/entity-links")
      .send({
        filePath: `${PREFIX}legal/nda.pdf`,
        subjectType: "COMPANY",
        subjectId: company.id,
        role: "CONTRACT",
      });
    expect(res.status).toBe(403);
    expect(await prisma.entityLink.count({ where: { filePath: OURS } })).toBe(0);
  });

  it("POST resolves the path to an ncFileId, derives the name, and records the LOCAL user id", async () => {
    const alice = await mkUser("alice", "family");
    const company = await mkCompany();
    ncGetFileId.mockResolvedValue(NC_PERSONAL);

    const res = await request(buildApp(asActor(alice)))
      .post("/api/crm/entity-links")
      .send({
        filePath: `${PREFIX}docs/quote-2026.pdf`,
        subjectType: "COMPANY",
        subjectId: company.id,
        role: "QUOTE",
      });
    expect(res.status).toBe(201);
    expect(res.body.link.ncFileId).toBe(NC_PERSONAL);
    expect(res.body.link.fileName).toBe("quote-2026.pdf");
    expect(res.body.link.fileSpace).toBe("personal");
    // IDOR: the UUID, never `nextcloudUsername`. Storing the username while
    // filtering on the UUID is the bug FileComment's docstring records.
    expect(res.body.link.createdById).toBe(alice.id);
    expect(res.body.link.createdById).not.toBe(alice.username);

    // Re-linking the SAME file to the SAME record updates in place rather than
    // duplicating or 409ing -- the updateMany-then-create path.
    const again = await request(buildApp(asActor(alice)))
      .post("/api/crm/entity-links")
      .send({
        filePath: `${PREFIX}docs/quote-2026.pdf`,
        subjectType: "COMPANY",
        subjectId: company.id,
        role: "CONTRACT",
      });
    expect(again.status).toBe(201);
    expect(again.body.link.id).toBe(res.body.link.id);
    expect(again.body.link.role).toBe("CONTRACT");
    expect(await prisma.entityLink.count({ where: { companyId: company.id } })).toBe(1);
  });

  it("404s on a subject that does not exist, rather than surfacing an FK error", async () => {
    const alice = await mkUser("alice", "family");
    const res = await request(buildApp(asActor(alice)))
      .post("/api/crm/entity-links")
      .send({
        filePath: `${PREFIX}docs/orphan.pdf`,
        subjectType: "DEAL",
        subjectId: "00000000-0000-0000-0000-000000000000",
      });
    expect(res.status).toBe(404);
  });

  // ── two readers of one truth table, pinned equal ────────────────────────

  it("readableDepartmentIdsFor agrees with checkSpaceAccess(reader) for every role and membership", async () => {
    const owner = await mkUser("owner", "owner");
    const dept = await prisma.department.create({
      data: {
        name: `${PREFIX}ops`,
        slug: `${PREFIX}ops`,
        kind: "DEPARTMENT",
        state: "active",
        createdBy: owner.id,
      },
    });

    const cases: Array<{ role: "owner" | "admin" | "family" | "guest"; member: boolean }> = [
      { role: "owner", member: false },
      { role: "admin", member: false },
      { role: "admin", member: true },
      { role: "family", member: false },
      { role: "family", member: true },
      { role: "guest", member: false },
      { role: "guest", member: true },
    ];

    for (const [i, c] of cases.entries()) {
      const u = await mkUser(`matrix-${i}`, c.role);
      if (c.member) {
        await prisma.departmentMembership.create({
          data: {
            departmentId: dept.id,
            userId: u.id,
            right: "reader",
            syncState: "synced",
            grantedBy: owner.id,
          },
        });
      }
      const caller = { id: u.id, role: c.role };
      const viaSet = (await readableDepartmentIdsFor(prisma, caller)).has(dept.id);
      const viaCheck = (await checkSpaceAccess(prisma, fakeReq(caller), caller, dept.id, "reader"))
        .allowed;
      expect(
        viaSet,
        `role=${c.role} member=${c.member}: the batch reader and checkSpaceAccess disagree`,
      ).toBe(viaCheck);
    }
  });

  it("a membership in syncState 'removing' is not readable -- policy access dies at commit", async () => {
    const owner = await mkUser("owner", "owner");
    const leaving = await mkUser("leaving", "family");
    const dept = await prisma.department.create({
      data: {
        name: `${PREFIX}rd`,
        slug: `${PREFIX}rd`,
        kind: "DEPARTMENT",
        state: "active",
        createdBy: owner.id,
      },
    });
    await prisma.departmentMembership.create({
      data: {
        departmentId: dept.id,
        userId: leaving.id,
        right: "manager",
        // The revocation has committed; the Nextcloud push has not converged.
        // checkSpaceAccess treats this as absent, and so must the batch reader
        // -- otherwise a revoked member keeps seeing document names for as long
        // as the reconciler takes to retry.
        syncState: "removing",
        grantedBy: owner.id,
      },
    });
    const caller = { id: leaving.id, role: "family" };
    expect((await readableDepartmentIdsFor(prisma, caller)).has(dept.id)).toBe(false);
    expect(
      (await checkSpaceAccess(prisma, fakeReq(caller), caller, dept.id, "reader")).allowed,
    ).toBe(false);
  });
});
