/**
 * WARP-2733 (ADR-048) — what the two READ routes put on the wire.
 *
 * Both of them carry a promise, and neither promise is checkable from the
 * dashboard's own tests:
 *
 *   `/crm/filing/proposals` says WHO applied each one. If `autoApplied` stops
 *   reaching the card, the "Droplet did this one" chip silently never renders
 *   and a hand-filed row and an unattended one become indistinguishable — on
 *   the exact surface an owner opens to check what the box did without them.
 *   The dashboard test asserts the chip renders when the field is true; only a
 *   test here can assert the field leaves the box at all.
 *
 *   `/crm/filing/summary` carries the READBACK, derived server-side from the
 *   policy table. The whole consent argument is that the owner was told, in
 *   plain English, what class of action they were promoting. A summary that
 *   shipped no readback would leave the settings card with nothing to render
 *   and the page would simply omit the promise — quietly, and looking fine.
 *
 * Supertest + an in-memory Prisma stand-in, the house pattern from
 * `storage-pools.routes.test.ts`. No database, no model.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express from "express";

const resolveAttributedToolAccessMock = vi.hoisted(() => vi.fn());
vi.mock("../services/tool-access.service.js", () => ({
  resolveAttributedToolAccess: resolveAttributedToolAccessMock,
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(async () => "tok"),
}));
vi.mock("../services/nextcloud.client.js", () => ({ ncGetFileId: vi.fn(async () => 1) }));

import { createCrmFilingRouter } from "./crm-filing.js";

const OWNER = { id: "u-owner", username: "ada", displayName: "Ada Lovelace" };

const row = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  kind: "CREATE_CUSTOMER",
  status: "APPLIED",
  policyClass: "AUTO",
  policyReason: null,
  confidence: 96,
  phiVerdict: "CLEAN",
  matchKind: "NONE",
  sourceKind: "FILE",
  ncFileId: 8891,
  autoApplied: true,
  payload: { name: "ACME Dental Supply Ltd" },
  evidence: [],
  createdAt: new Date("2026-09-05T09:00:00.000Z"),
  decidedAt: new Date("2026-09-05T09:01:00.000Z"),
  ...over,
});

function createPrismaMock(rows: ReturnType<typeof row>[], mode = "auto") {
  return {
    autoFilingSetting: {
      findUnique: vi.fn(async () => ({
        id: "singleton",
        mode,
        level: "also_create",
        vertical: "general",
        enabledById: OWNER.id,
        enabledAt: new Date("2026-09-05T08:00:00.000Z"),
        folders: [],
        pathDenylist: [],
        hourlyApplyCap: 50,
        dailyCreateCap: 10,
        digestHour: 8,
      })),
    },
    user: { findUnique: vi.fn(async () => OWNER) },
    moduleSetting: { findUnique: vi.fn(async () => ({ moduleId: "crm", enabled: true })) },
    ingestProposal: {
      findMany: vi.fn(async () => rows),
      count: vi.fn(async () => rows.length),
    },
    fileIndexStatus: {
      count: vi.fn(async () => 0),
      findFirst: vi.fn(async () => null),
    },
  } as never;
}

function makeApp(prisma: never) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: unknown }).user = { id: OWNER.id, role: "owner" };
    next();
  });
  app.use("/api", createCrmFilingRouter(prisma));
  return app;
}

beforeEach(() => {
  resolveAttributedToolAccessMock.mockReset().mockResolvedValue({
    unresolved: null,
    tier: "owner",
    scope: null,
  });
});

describe("🔴 the card says who applied it", () => {
  it("MUTATION: stop reporting `autoApplied` — the chip can never render", async () => {
    const app = makeApp(createPrismaMock([row(), row({ autoApplied: false })]));
    const res = await request(app).get("/api/crm/filing/proposals?status=decided");

    expect(res.status).toBe(200);
    expect(res.body.proposals.map((p: { autoApplied: boolean }) => p.autoApplied)).toEqual([
      true,
      false,
    ]);
  });
});

/**
 * 🔴 WARP-2737 — the money card's customer, resolved on the way out.
 *
 * The dashboard cannot work this out for itself. A money payload written for a
 * business the box did not have carries NO `companyId`, and it never gains one:
 * the payload is the record of what was read, and the customer only comes into
 * existence later, when the `CREATE_CUSTOMER` card beside it is applied. So the
 * card is gated on a field only the server can fill, and if that field stops
 * reaching the wire the gate never opens — the surface would show an honest
 * sentence forever about a document it could in fact file, which is the same
 * dead end this slice exists to remove, wearing better manners.
 */
describe("🔴 the money card carries the customer it will be filed under", () => {
  const MONEY = {
    kind: "CREATE_MONEY_DOC",
    status: "PENDING",
    policyClass: "REVIEW",
    autoApplied: false,
    payload: {
      kind: "INVOICE",
      currency: "USD",
      total: "4250.00",
      direction: "RECEIVABLE",
      counterpartyName: "ACME Dental Supply Ltd",
    },
    dependsOnProposalId: "prop-customer",
  };

  function withChain(
    rows: ReturnType<typeof row>[],
    parent: { status: string; createdCompanyId: string | null } | null,
    company: { id: string; name: string; isArchived: boolean } | null,
  ) {
    const prisma = createPrismaMock(rows, "propose") as unknown as {
      ingestProposal: { findUnique?: unknown };
      crmCompany?: unknown;
    };
    prisma.ingestProposal.findUnique = vi.fn(async () => parent);
    prisma.crmCompany = { findUnique: vi.fn(async () => company) };
    return prisma as never;
  }

  it("names the customer once the card it depends on has been applied", async () => {
    const app = makeApp(
      withChain(
        [row(MONEY)],
        { status: "APPLIED", createdCompanyId: "c-1" },
        { id: "c-1", name: "ACME Dental Supply Ltd", isArchived: false },
      ),
    );
    const res = await request(app).get("/api/crm/filing/proposals");
    expect(res.status).toBe(200);
    expect(res.body.proposals[0].resolvedCustomer).toEqual({
      companyId: "c-1",
      companyName: "ACME Dental Supply Ltd",
    });
  });

  it("🔴 MUTATION: sends null while that card is still waiting to be applied", async () => {
    // Null is the load-bearing value: it is what keeps the surface from
    // offering a button the box would refuse.
    const app = makeApp(
      withChain(
        [row(MONEY)],
        { status: "PENDING", createdCompanyId: null },
        { id: "c-1", name: "ACME Dental Supply Ltd", isArchived: false },
      ),
    );
    const res = await request(app).get("/api/crm/filing/proposals");
    expect(res.body.proposals[0].resolvedCustomer).toBeNull();
  });

  it("MUTATION: does not go looking for a customer a card already names", async () => {
    // A payload with a companyId carries the resolution the matcher already
    // made. Consulting the chain as well would be a second answer, and a query
    // per card on every page load for no gain.
    const prisma = withChain(
      [row({ ...MONEY, payload: { ...MONEY.payload, companyId: "c-9" } })],
      { status: "APPLIED", createdCompanyId: "c-1" },
      { id: "c-1", name: "ACME Dental Supply Ltd", isArchived: false },
    ) as unknown as { crmCompany: { findUnique: { mock: { calls: unknown[] } } } };
    const res = await request(makeApp(prisma as never)).get("/api/crm/filing/proposals");
    expect(res.body.proposals[0].resolvedCustomer).toBeNull();
    expect(prisma.crmCompany.findUnique.mock.calls).toHaveLength(0);
  });

  it("🔴 MUTATION: every other kind carries null, even one that IS chained", async () => {
    // A `LINK_FILE` against a customer the same run proposes creating is the
    // schema's own example of a chained child, so "has a pointer" cannot be the
    // test — the resolution is MONEY's, and every other kind names its target in
    // its payload or does not need one. Without the kind filter this card would
    // sprout a customer it never asked for, and pay a query per page for it.
    const prisma = withChain(
      [row({ kind: "LINK_FILE", dependsOnProposalId: "prop-customer" })],
      { status: "APPLIED", createdCompanyId: "c-1" },
      { id: "c-1", name: "ACME Dental Supply Ltd", isArchived: false },
    ) as unknown as { crmCompany: { findUnique: { mock: { calls: unknown[] } } } };
    const res = await request(makeApp(prisma as never)).get("/api/crm/filing/proposals");
    expect(res.body.proposals[0].resolvedCustomer).toBeNull();
    expect(prisma.crmCompany.findUnique.mock.calls).toHaveLength(0);
  });
});

describe("🔴 the summary carries the consent record", () => {
  it("MUTATION: ship no readback — the settings card promises nothing", async () => {
    const app = makeApp(createPrismaMock([]));
    const res = await request(app).get("/api/crm/filing/summary");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.readback)).toBe(true);
    expect(res.body.readback.length).toBeGreaterThan(0);
    // The two clauses that must be there at EVERY auto setting, because they
    // are what a practice owner is actually deciding about. `CREATE_CONTACT`
    // has no AUTO cell in the table, in any mode, on any vertical.
    expect(res.body.readback.join(" ")).toMatch(/looks like a patient record/i);
    expect(res.body.readback.join(" ")).toMatch(/address book/i);
    // Server-stamped, from the session — never from a request body.
    expect(res.body.readback.join(" ")).toMatch(/Runs as: Ada Lovelace/);
  });

  it("names why auto mode is switched on but not running", async () => {
    resolveAttributedToolAccessMock.mockResolvedValue({
      unresolved: "user_deactivated",
      tier: null,
      scope: null,
    });
    const app = makeApp(createPrismaMock([]));
    const res = await request(app).get("/api/crm/filing/summary");

    expect(res.body.health.paused).toBe(true);
    // In the owner's words, not the pre-flight's reason code — the code is
    // beside it for an operator, and the sentence is what reaches the header.
    expect(res.body.health.pausedMessage).toMatch(/no longer active/i);
    expect(res.body.health.pausedReason).toBe("owner_unavailable");
  });

  it("does not offer a promotion the owner has not earned", async () => {
    // `propose` with two applied rows: nowhere near the twenty-with-at-most-two
    // -corrections bar, so the page must say nothing rather than nag.
    const app = makeApp(createPrismaMock([row(), row()], "propose"));
    const res = await request(app).get("/api/crm/filing/summary");
    expect(res.body.promotion).toEqual({ offer: false });
  });
});
