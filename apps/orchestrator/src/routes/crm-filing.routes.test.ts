/**
 * WARP-2730 (ADR-048) — the filing routes, wired for real.
 *
 * `rbac.test.ts` proves the guard CONTRACT against synthetic stand-ins. This
 * proves the WIRING: the real router, the real `requireRole` calls, and the two
 * refusals `requireRole` alone cannot express.
 *
 * 🔴 THE `_service:mcp` ROW IS THE POINT OF THIS FILE. The MCP service
 * principal authenticates with the `admin` ROLE on this box, so `requireRole`
 * lets it through every guard here — and it must still be refused, because a
 * model deciding which of its own extractions to apply is the loop this whole
 * design exists to keep a human inside of. That refusal is `actorOf`'s
 * `_service:` prefix test, and it is the thing a future "let the assistant
 * clear the queue" change would delete.
 *
 * MUTATIONS THESE CATCH:
 *   - widen REVIEWER to include "family"
 *   - swap `requireRole` for `requireRoleOrMcpService`
 *   - delete the `_service:` prefix test in `actorOf`
 *   - map SOURCE_CHANGED to 200, or NOT_PENDING to 404
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

const applyProposalMock = vi.hoisted(() => vi.fn());
const rejectProposalMock = vi.hoisted(() => vi.fn());
const markNotSameMock = vi.hoisted(() => vi.fn());
vi.mock("../services/filing/apply.service.js", async () => {
  const actual = await vi.importActual<typeof import("../services/filing/apply.service.js")>(
    "../services/filing/apply.service.js",
  );
  return {
    // The REAL error codes — a mocked-out code table would let the mapping
    // test pass against strings the service never throws.
    FILING_ERRORS: actual.FILING_ERRORS,
    applyProposal: applyProposalMock,
    rejectProposal: rejectProposalMock,
    markNotSame: markNotSameMock,
  };
});

const ncGetFileIdMock = vi.hoisted(() => vi.fn());
vi.mock("../services/nextcloud.client.js", () => ({ ncGetFileId: ncGetFileIdMock }));

const resolveNcTokenMock = vi.hoisted(() => vi.fn());
vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: resolveNcTokenMock,
}));

import { createCrmFilingRouter } from "./crm-filing.js";
import type { Role } from "../services/jwt.service.js";
import { FILING_ERRORS } from "../services/filing/apply.service.js";

type Principal = { id: string; username: string; displayName: string; role: Role } | null;

const prisma = {
  ingestProposal: {
    count: vi.fn().mockResolvedValue(3),
    findMany: vi.fn().mockResolvedValue([]),
  },
  autoFilingSetting: {
    findUnique: vi.fn().mockResolvedValue(null),
    upsert: vi.fn().mockResolvedValue({}),
  },
  // WARP-2731 — what the Health block reads.
  user: { findUnique: vi.fn().mockResolvedValue({ username: "stefan" }) },
  fileIndexStatus: {
    count: vi.fn().mockResolvedValue(0),
    findFirst: vi.fn().mockResolvedValue(null),
    findMany: vi.fn().mockResolvedValue([]),
  },
  emailMessage: { findMany: vi.fn().mockResolvedValue([]) },
  filingDecision: {
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
  },
  crmCompany: { findMany: vi.fn().mockResolvedValue([]) },
  // The settings PATCH reads the STORED mode and writes in one transaction, so
  // the callback gets the same stub back — this mock is not modelling isolation,
  // only the shape.
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
} as never;

function appAs(user: Principal) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) (req as Request & { user: Principal }).user = user;
    next();
  });
  app.use("/api", createCrmFilingRouter(prisma));
  return app;
}

/** The argument the handler passed to `autoFilingSetting.upsert`. */
function upsertArg(): { create: Record<string, unknown>; update: Record<string, unknown> } {
  const m = (prisma as unknown as {
    autoFilingSetting: { upsert: { mock: { calls: unknown[][] } } };
  }).autoFilingSetting.upsert.mock;
  return m.calls[0][0] as { create: Record<string, unknown>; update: Record<string, unknown> };
}

/** Put a stored row behind the read the handler now does first. */
function storedMode(mode: string | null): void {
  (prisma as unknown as {
    autoFilingSetting: { findUnique: ReturnType<typeof vi.fn> };
  }).autoFilingSetting.findUnique.mockResolvedValue(
    mode === null
      ? null
      : { id: "singleton", mode, enabledById: "u-owner", enabledAt: new Date("2026-09-01") },
  );
}

const OWNER = { id: "u-owner", username: "owner", displayName: "Owner", role: "owner" as Role };
const FAMILY = { id: "u-fam", username: "fam", displayName: "Fam", role: "family" as Role };
/** How the MCP service principal actually presents: the `admin` role, and an
 *  id no human has. `requireRole` cannot tell it from a person. */
const MCP = { id: "_service:mcp", username: "mcp", displayName: "MCP", role: "admin" as Role };

const PROPOSAL_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  resolveNcTokenMock.mockResolvedValue("nc-token");
  ncGetFileIdMock.mockResolvedValue(8891);
  applyProposalMock.mockResolvedValue({ proposalId: PROPOSAL_ID });
  rejectProposalMock.mockResolvedValue(undefined);
  markNotSameMock.mockResolvedValue(undefined);
});

describe("🔴 who may see and decide", () => {
  it("MUTATION: widen REVIEWER to family — a household member reads document quotes", async () => {
    const res = await request(appAs(FAMILY)).get("/api/crm/filing/proposals");
    expect(res.status).toBe(403);
  });

  it("family cannot apply either", async () => {
    const res = await request(appAs(FAMILY))
      .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/apply`)
      .send({});
    expect(res.status).toBe(403);
    expect(applyProposalMock).not.toHaveBeenCalled();
  });

  it("MUTATION: delete the `_service:` test — the assistant clears its own queue", async () => {
    // The role guard passes: this principal is `admin`. The refusal has to come
    // from the id, which is why it lives in the route rather than the guard.
    const res = await request(appAs(MCP))
      .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/apply`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "human_reviewer_required" });
    expect(applyProposalMock).not.toHaveBeenCalled();
  });

  it("the service principal cannot reject or teach a rule either", async () => {
    for (const path of ["reject", "not-same"]) {
      const res = await request(appAs(MCP))
        .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/${path}`)
        .send({ companyId: "22222222-2222-4222-8222-222222222222" });
      expect(res.status).toBe(403);
    }
    expect(rejectProposalMock).not.toHaveBeenCalled();
    expect(markNotSameMock).not.toHaveBeenCalled();
  });

  it("an owner gets through", async () => {
    const res = await request(appAs(OWNER))
      .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/apply`)
      .send({});
    expect(res.status).toBe(200);
    expect(applyProposalMock).toHaveBeenCalledTimes(1);
    // The deciding owner's real User.id, never null and never a service id.
    expect(applyProposalMock.mock.calls[0][2]).toMatchObject({ actorId: "u-owner" });
  });
});

describe("🔴 the source is re-checked as the caller", () => {
  it("refuses when the caller has no Nextcloud session, rather than acting as admin", async () => {
    resolveNcTokenMock.mockResolvedValue(null);
    const res = await request(appAs(OWNER))
      .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/apply`)
      .send({});
    expect(res.status).toBe(401);
    expect(applyProposalMock).not.toHaveBeenCalled();
  });

  it("resolves the fileid with the caller's OWN token", async () => {
    await request(appAs(OWNER))
      .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/apply`)
      .send({});
    const ctx = applyProposalMock.mock.calls[0][2] as {
      resolveFileId: (p: string) => Promise<number | null>;
    };
    await ctx.resolveFileId("/Customers/acme-invoice.pdf");
    expect(ncGetFileIdMock).toHaveBeenCalledWith("nc-token", "owner", "/Customers/acme-invoice.pdf");
  });

  it("MUTATION: drop assertSafeNcPath — a stored path traverses out of the namespace", async () => {
    await request(appAs(OWNER))
      .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/apply`)
      .send({});
    const ctx = applyProposalMock.mock.calls[0][2] as {
      resolveFileId: (p: string) => Promise<number | null>;
    };
    // `webdavUrl()` percent-encodes each segment but does NOT reject `..`.
    expect(await ctx.resolveFileId("/Customers/../../etc/passwd")).toBeNull();
    expect(ncGetFileIdMock).not.toHaveBeenCalled();
  });
});

describe("refusals map to statuses a client can act on", () => {
  const cases: [string, number][] = [
    [FILING_ERRORS.PROPOSAL_NOT_FOUND, 404],
    // 409, not 404: the row is there and the caller's view is stale.
    [FILING_ERRORS.NOT_PENDING, 409],
    // 422, not 400: the body was fine, the answer is no.
    [FILING_ERRORS.NEVER_APPLIABLE, 422],
    [FILING_ERRORS.SOURCE_CHANGED, 422],
    [FILING_ERRORS.CHOICE_REQUIRED, 422],
    [FILING_ERRORS.CHOICE_NOT_OFFERED, 422],
    [FILING_ERRORS.PAYLOAD_UNREADABLE, 422],
  ];
  for (const [code, status] of cases) {
    it(`${code} → ${status}`, async () => {
      applyProposalMock.mockRejectedValue(new Error(code));
      const res = await request(appAs(OWNER))
        .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/apply`)
        .send({});
      expect(res.status).toBe(status);
      expect(res.body).toEqual({ error: code });
    });
  }
});

describe("bodies are strict", () => {
  it("refuses an unknown key on apply", async () => {
    const res = await request(appAs(OWNER))
      .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/apply`)
      .send({ chooseCompanyId: "22222222-2222-4222-8222-222222222222", force: true });
    expect(res.status).toBe(400);
    expect(applyProposalMock).not.toHaveBeenCalled();
  });

  it("not-same needs the company it is teaching about", async () => {
    const res = await request(appAs(OWNER))
      .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/not-same`)
      .send({});
    expect(res.status).toBe(400);
    expect(markNotSameMock).not.toHaveBeenCalled();
  });
});

describe("🔴 the Health block makes two silences visible", () => {
  it("reports when the tick last ran, and whether the canary has it paused", async () => {
    const res = await request(appAs(OWNER)).get("/api/crm/filing/summary");
    expect(res.status).toBe(200);
    // MUTATION: drop `health` from the response — a stalled worker and a
    // stalled corpus both present as "nothing new arrived", and the page has
    // no way to tell the owner which.
    expect(res.body.health).toBeTruthy();
    expect(res.body.health).toHaveProperty("lastTickAt");
    expect(res.body.health).toHaveProperty("hoursSinceLastIndex");
    expect(res.body.health).toHaveProperty("paused");
    expect(res.body.health.paused).toBe(false);
  });

  it("family cannot read it — it counts the owner's documents", async () => {
    expect((await request(appAs(FAMILY)).get("/api/crm/filing/summary")).status).toBe(403);
  });
});

describe("the Rules memory is owner-only, and revoking is audited", () => {
  it("lists for an owner", async () => {
    const res = await request(appAs(OWNER)).get("/api/crm/filing/rules");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("rules");
  });

  it("family sees neither the rules nor the skipped list", async () => {
    expect((await request(appAs(FAMILY)).get("/api/crm/filing/rules")).status).toBe(403);
    expect((await request(appAs(FAMILY)).get("/api/crm/filing/skipped")).status).toBe(403);
  });

  it("MUTATION: let the service principal forget a rule", async () => {
    const res = await request(appAs(MCP)).delete("/api/crm/filing/rules/r1");
    expect(res.status).toBe(403);
  });

  it("refuses an unknown key when teaching a rule", async () => {
    const res = await request(appAs(OWNER))
      .post("/api/crm/filing/rules")
      .send({
        keyKind: "EMAIL_DOMAIN",
        keyValue: "northgate.example",
        companyId: "22222222-2222-4222-8222-222222222222",
        verdict: "ALWAYS_HERE",
      });
    // `verdict` is not on the body schema: this route writes NOT_SAME only.
    // Accepting it would let a chip mint an ALWAYS_HERE rule, which is the
    // strongest thing in the feature, from a one-click control.
    expect(res.status).toBe(400);
  });
});

describe("undo is a human's decision", () => {
  it("MUTATION: let the service principal undo", async () => {
    const res = await request(appAs(MCP))
      .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/undo`)
      .send({});
    expect(res.status).toBe(403);
  });

  it("family cannot undo either", async () => {
    const res = await request(appAs(FAMILY))
      .post(`/api/crm/filing/proposals/${PROPOSAL_ID}/undo`)
      .send({});
    expect(res.status).toBe(403);
  });
});

describe("turning filing on", () => {
  it("stamps the enabling owner from the SESSION, never the body", async () => {
    storedMode(null); // no row yet — this IS the off -> on edge
    await request(appAs(OWNER))
      .patch("/api/crm/filing/settings")
      .send({ mode: "propose" });
    const call = upsertArg();
    expect(call.create.enabledById).toBe("u-owner");
    expect(call.update.enabledById).toBe("u-owner");
  });

  it("MUTATION: refresh enabledAt on every edit — everything since is retired as backlog", async () => {
    // `enabledAt` is the BACKLOG BOUNDARY as well as the consent stamp: the
    // worker will not claim a source older than it. An unrelated settings edit
    // must not move it.
    storedMode("propose");
    await request(appAs(OWNER))
      .patch("/api/crm/filing/settings")
      .send({ level: "also_create" });
    const call = upsertArg();
    expect(call.update).not.toHaveProperty("enabledAt");
    expect(call.update).toMatchObject({ level: "also_create" });
  });

  it("refuses an unknown settings key", async () => {
    const res = await request(appAs(OWNER))
      .patch("/api/crm/filing/settings")
      .send({ mode: "propose", canaryPassedAt: "2026-01-01T00:00:00.000Z" });
    expect(res.status).toBe(400);
  });

  it("🔴 MUTATION: turning filing OFF clears the actor pair — or the CHECK 500s and filing stays ON", async () => {
    // `AutoFilingSetting_enabled_has_actor` is a BICONDITIONAL:
    //
    //     ("mode" <> 'off') = ("enabledById" IS NOT NULL AND "enabledAt" IS NOT NULL)
    //
    // so when filing goes off the actor pair is REQUIRED TO BE ABSENT, not
    // merely allowed to be. Leaving it populated is `false = true` — a 23514
    // the route's catch does not recognise, so a 500, and because the statement
    // rolls back the row still says 'propose'. The off switch did not turn
    // filing off, and the worker kept reading the owner's files.
    //
    // Asserted on the WRITE rather than the response, because a mocked prisma
    // has no CHECK to violate: the invariant this test defends lives in
    // Postgres, and the pg-lane companion in filing-schema.pg.test.ts exercises
    // it for real.
    storedMode("propose");
    await request(appAs(OWNER))
      .patch("/api/crm/filing/settings")
      .send({ mode: "off" });

    const call = upsertArg();
    expect(call.update).toMatchObject({ mode: "off", enabledById: null, enabledAt: null });
  });

  it("🔴 MUTATION: re-stamp enabledAt on propose -> auto — accepting the promotion retires the queue", async () => {
    // The one click this feature is built around. `enabledAt` is the backlog
    // BOUNDARY as well as the consent stamp, so moving it to now excludes every
    // document still waiting from ever being claimed. Those rows never reach a
    // terminal status, so they show up in no tab and in no count: saying yes to
    // Droplet would silently discard the queue it had just offered to file.
    //
    // The pre-existing no-refresh test could not catch this: it sends a
    // `level`-only body, where the old `turningOn` was already false because no
    // mode was named at all. The mode CHANGE is the case that mattered.
    storedMode("propose");
    await request(appAs(OWNER))
      .patch("/api/crm/filing/settings")
      .send({ mode: "auto" });

    const call = upsertArg();
    expect(call.update).toMatchObject({ mode: "auto" });
    expect(call.update).not.toHaveProperty("enabledAt");
    expect(call.update).not.toHaveProperty("enabledById");
  });

  it("switching back on from OFF does stamp again — consent is re-taken", async () => {
    // The complement of the two above: off -> propose is a genuine new grant,
    // so it takes a fresh actor and a fresh boundary. Without this, a fix for
    // the two cases above could simply never stamp and both would still pass.
    storedMode("off");
    await request(appAs(OWNER))
      .patch("/api/crm/filing/settings")
      .send({ mode: "propose" });

    const call = upsertArg();
    expect(call.update).toMatchObject({ mode: "propose", enabledById: "u-owner" });
    expect(call.update.enabledAt).toBeInstanceOf(Date);
  });

  it("the canary CHECK surfaces as 422, not 500", async () => {
    (prisma as unknown as {
      autoFilingSetting: { upsert: ReturnType<typeof vi.fn> };
    }).autoFilingSetting.upsert.mockRejectedValueOnce(
      new Error(
        'new row for relation "AutoFilingSetting" violates check constraint ' +
          '"AutoFilingSetting_auto_requires_canary"',
      ),
    );
    const res = await request(appAs(OWNER))
      .patch("/api/crm/filing/settings")
      .send({ mode: "auto" });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "auto_needs_canary" });
  });
});
