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

describe("turning filing on", () => {
  it("stamps the enabling owner from the SESSION, never the body", async () => {
    await request(appAs(OWNER))
      .patch("/api/crm/filing/settings")
      .send({ mode: "propose" });
    const call = (prisma as unknown as {
      autoFilingSetting: { upsert: { mock: { calls: unknown[][] } } };
    }).autoFilingSetting.upsert.mock.calls[0][0] as {
      create: { enabledById: string | null };
      update: { enabledById?: string };
    };
    expect(call.create.enabledById).toBe("u-owner");
    expect(call.update.enabledById).toBe("u-owner");
  });

  it("MUTATION: refresh enabledAt on every edit — everything since is retired as backlog", async () => {
    // `enabledAt` is the BACKLOG BOUNDARY as well as the consent stamp: the
    // worker will not claim a source older than it. An unrelated settings edit
    // must not move it.
    await request(appAs(OWNER))
      .patch("/api/crm/filing/settings")
      .send({ level: "also_create" });
    const call = (prisma as unknown as {
      autoFilingSetting: { upsert: { mock: { calls: unknown[][] } } };
    }).autoFilingSetting.upsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update).not.toHaveProperty("enabledAt");
    expect(call.update).toMatchObject({ level: "also_create" });
  });

  it("refuses an unknown settings key", async () => {
    const res = await request(appAs(OWNER))
      .patch("/api/crm/filing/settings")
      .send({ mode: "propose", canaryPassedAt: "2026-01-01T00:00:00.000Z" });
    expect(res.status).toBe(400);
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
