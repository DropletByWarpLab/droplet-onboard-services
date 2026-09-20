/**
 * WARP-1530 (RBAC v2 T6) — the O-2 connector floors on /api/erp/*.
 *
 * ADR-032 §8 O-2 (resolved 2026-07-24): ERP reads become **family-and-up
 * WITH an `AccessRoleConnectorGrant`** — that is what makes a "Reception"
 * role useful; writes stay **admin-tier only** plus the unchanged
 * `IntegrationConnection.writeEnabled` + staged `ErpWriteRequest` outbox +
 * human confirm above it. §3 adds the other half: only `owner` bypasses
 * layer 2, so an **Admin-based custom role can be narrowed** — an admin
 * whose role carries no ERP connector grant loses ERP reach.
 *
 * The behaviour CHANGE this file pins (today's 403 → 200):
 *   family user WITH a connector grant can read ERP.
 * Everything else is a PIN of existing behaviour, above all:
 *   a person with NO accessRole behaves EXACTLY as today.
 *
 * The route layer is the subject here; `erp.service.test.ts` covers the
 * defence-in-depth assertion that sits under it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { resolveEffectiveAccessMock, recordAccessDeniedMock } = vi.hoisted(() => ({
  resolveEffectiveAccessMock: vi.fn(),
  recordAccessDeniedMock: vi.fn(),
}));

vi.mock("../services/effective-access.service.js", () => ({
  resolveEffectiveAccess: resolveEffectiveAccessMock,
}));

// The REAL requireRole contract (403 + its exact body + the access-denied
// audit hook) — the O-2 wiring must not change what a below-floor caller
// sees, so the stub has to behave like the middleware it stands in for.
vi.mock("../middleware/auth.js", () => ({
  requireRole:
    (...allowed: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as unknown as { user?: { role?: string } }).user?.role;
      if (typeof role !== "string" || role.length === 0) {
        recordAccessDeniedMock(req, "no-role");
        res.status(403).json({ error: "Forbidden: no role on session" });
        return;
      }
      if (!allowed.includes(role)) {
        recordAccessDeniedMock(req, "role-not-permitted");
        res.status(403).json({ error: "Forbidden: role not permitted" });
        return;
      }
      next();
    },
  // WARP-2497 — the cloud dataset route's gate. Modelled on the real one:
  // the MCP service principal is admitted ahead of the tier check (that is
  // the whole reason the route uses it rather than `canRead`), everyone else
  // falls through to the same role logic as above, so the 403 body and the
  // `recordAccessDenied` row stay byte-identical for a human caller.
  requireRoleOrMcpService:
    (...allowed: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const user = (req as unknown as { user?: { id?: string; role?: string } }).user;
      if (user?.id === "_service:mcp" && user.role === "service") {
        next();
        return;
      }
      const role = user?.role;
      if (typeof role !== "string" || role.length === 0) {
        recordAccessDeniedMock(req, "no-role");
        res.status(403).json({ error: "Forbidden: no role on session" });
        return;
      }
      if (!allowed.includes(role)) {
        recordAccessDeniedMock(req, "role-not-permitted");
        res.status(403).json({ error: "Forbidden: role not permitted" });
        return;
      }
      next();
    },
  recordAccessDenied: recordAccessDeniedMock,
}));

/** WARP-2567 — hoisted so a test can assert the WHERE the route built, not
 *  merely the rows it got back. The provider filter is the whole guard. */
const partyLinkFindMany = vi.fn();

const svcMock = {
  getSchedule: vi.fn(),
  searchPatients: vi.fn(),
  getPatient: vi.fn(),
  getArSummary: vi.fn(),
  getRecallDue: vi.fn(),
  createWriteRequest: vi.fn(),
  getWriteRequest: vi.fn(),
  confirmWriteRequest: vi.fn(),
};
vi.mock("../services/erp.service.js", () => ({
  createErpService: () => svcMock,
}));

import { createErpRouter } from "./erp.js";
import { EAGLESOFT_API_PROVIDER, EAGLESOFT_PROVIDER } from "../services/erp-provider.js";
// The REAL error class — `handleErpError` branches on `instanceof`, so a
// duck-typed stand-in would fall through to the 500 handler and quietly make
// the honest-409 assertion below vacuous.
import { ErpError } from "../services/erp-error.js";

/** Prisma surface the route's connector gate needs (the connection probe),
 *  plus — WARP-2567 — the party-link read the practice-by-company route makes. */
function createPrismaMock(opts: {
  connectionConfigured: boolean;
  partyLinks?: Array<{ id: string; externalSystem: string; externalId: string }>;
}) {
  return {
    integrationConnection: {
      findFirst: vi.fn(async () =>
        opts.connectionConfigured ? { id: "conn-1" } : null,
      ),
    },
    partyLink: {
      findMany: partyLinkFindMany.mockImplementation(async () => opts.partyLinks ?? []),
    },
  };
}

function buildApp(
  user: { id?: string; role?: string } | undefined,
  opts: {
    connectionConfigured?: boolean;
    partyLinks?: Array<{ id: string; externalSystem: string; externalId: string }>;
  } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) (req as unknown as { user?: unknown }).user = user;
    next();
  });
  app.use(
    "/api",
    createErpRouter(
      createPrismaMock({
        connectionConfigured: opts.connectionConfigured ?? true,
        partyLinks: opts.partyLinks,
      }) as never,
    ),
  );
  return app;
}

/**
 * Resolver output carrying only what the ERP gates read.
 *
 * `connectors` is the §3 EFFECTIVE level — `min(roleGrant, writeEnabled ?
 * read_write : read)`. `connectorGrants` is the WARP-1579 addition: the RAW
 * role grant, before that min(). It defaults to `null` — "no custom role
 * narrows this axis" — so every pre-existing case below keeps modelling a
 * role-LESS person and keeps its pre-1579 answer.
 */
function access(
  tier: string,
  connectors: Record<string, "read" | "read_write">,
  connectorGrants: Record<string, "read" | "read_write"> | null = null,
) {
  return { tier, connectors, connectorGrants, cloud: false, features: [], toolDomains: [] };
}

const OK_READ = { connected: false, reason: "NOT_CONFIGURED", date: "2026-07-25", items: [] };

beforeEach(() => {
  resolveEffectiveAccessMock.mockReset();
  recordAccessDeniedMock.mockReset();
  for (const fn of Object.values(svcMock)) fn.mockReset();
  svcMock.getSchedule.mockResolvedValue(OK_READ);
  svcMock.getArSummary.mockResolvedValue({ connected: false, totalBalance: null, accountCount: null });
  svcMock.createWriteRequest.mockResolvedValue({ id: "wr-1", status: "PENDING_CONFIRMATION" });
  svcMock.confirmWriteRequest.mockResolvedValue({ id: "wr-1", status: "FAILED" });
  svcMock.getWriteRequest.mockResolvedValue({ id: "wr-1", status: "PENDING_CONFIRMATION" });
});

describe("ERP reads — the O-2 floor (WARP-1530)", () => {
  it("BEHAVIOUR CHANGE: a family person WITH an ERP connector grant can read (today: 403)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("family", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const app = buildApp({ id: "u-reception", role: "family" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(200);
    expect(svcMock.getSchedule).toHaveBeenCalled();
    // The service is told the resolved reach so its own assertion can admit
    // this person without widening the tier set (defence in depth).
    expect(svcMock.getSchedule.mock.calls.at(-1)![1]).toMatchObject({
      id: "u-reception",
      role: "family",
      connectorLevel: "read",
    });
  });

  it("a family person WITHOUT a grant is denied — today's exact 403 (body + audit hook)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(access("family", {}));
    const app = buildApp({ id: "u-family", role: "family" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
    expect(recordAccessDeniedMock).toHaveBeenCalledWith(
      expect.anything(),
      "role-not-permitted",
    );
    expect(svcMock.getSchedule).not.toHaveBeenCalled();
  });

  it("a guest is denied exactly as today, without a resolver read", async () => {
    const app = buildApp({ id: "u-guest", role: "guest" });

    const res = await request(app).get("/api/erp/patients?query=sm");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  // ── the family-AND-UP half of O-2, which lives HERE ────────────────
  //
  // T3 does not enforce it: `normalizeGrants` (access.ts) only clamps
  // read_write→read on non-admin starting points, so a GUEST-based role can
  // hold a connector grant, and the resolver faithfully resolves it to
  // "read" (effective-access.service.ts, the accessRole !== null branch).
  // Trusting `connectors[p]` on its own would therefore hand a guest-based
  // role PHI. The tier floor is what stops that — asserted in both
  // directions so a future refactor of either layer trips a test.
  it("a GUEST-based role holding an ERP grant is still refused — the tier floor, not the grant, is the floor", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("guest", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const app = buildApp({ id: "u-guest-role", role: "guest" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
    expect(svcMock.getSchedule).not.toHaveBeenCalled();
    // Refused BEFORE layer 2 — a grant a guest should never have held is
    // never even read, let alone honoured.
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("…and the same grant on a FAMILY-based role is honoured (the floor is a floor, not a ban)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("family", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const app = buildApp({ id: "u-reception", role: "family" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(200);
    expect(svcMock.getSchedule).toHaveBeenCalled();
  });

  it("an Admin-based custom role with NO ERP grant loses reach (§3 — admins do not bypass layer 2)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(access("admin", {}));
    const app = buildApp({ id: "u-narrowed-admin", role: "admin" });

    const res = await request(app).get("/api/erp/ar-summary");

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(svcMock.getArSummary).not.toHaveBeenCalled();
  });

  it("an owner bypasses layer 2 entirely — never resolved, never narrowed", async () => {
    const app = buildApp({ id: "u-owner", role: "owner" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(200);
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });
});

describe("ERP reads — a person with NO accessRole behaves exactly as today", () => {
  it("a role-less admin reads (the resolver hands back the tier's full connector reach)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("admin", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const app = buildApp({ id: "u-admin", role: "admin" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(200);
    expect(svcMock.getSchedule).toHaveBeenCalled();
  });

  it("a role-less admin still gets the honest not-configured read when NOTHING is connected", async () => {
    // With no IntegrationConnection row the resolver hands back {} for
    // EVERYONE (no connection = no reach). "Nothing is connected" is not an
    // authorization answer — the service's honest NOT_CONFIGURED must win,
    // exactly as it does today.
    resolveEffectiveAccessMock.mockResolvedValue(access("admin", {}));
    const app = buildApp({ id: "u-admin", role: "admin" }, { connectionConfigured: false });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(200);
    expect(res.body.reason).toBe("NOT_CONFIGURED");
  });

  it("a role-less family person is STILL denied when nothing is connected (today's 403)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(access("family", {}));
    const app = buildApp({ id: "u-family", role: "family" }, { connectionConfigured: false });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
  });

  it("a GRANTED family person also gets 403 when nothing is connected — the accepted cost of the fall-through", async () => {
    // The resolver returns {} for everyone when no IntegrationConnection row
    // exists (`no connection = no reach`), so a granted family person is
    // indistinguishable from an ungranted one here and lands on today's
    // floor: 403 rather than the honest NOT_CONFIGURED an admin would see.
    // Pinned deliberately — the alternative (letting family through on an
    // unconfigured box) would regress the role-less family 403 directly
    // above it, which is the louder promise. Revisit if the resolver ever
    // reports grants independently of connections.
    resolveEffectiveAccessMock.mockResolvedValue(access("family", {}));
    const app = buildApp({ id: "u-reception", role: "family" }, { connectionConfigured: false });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Forbidden: role not permitted" });
    expect(svcMock.getSchedule).not.toHaveBeenCalled();
  });

  it("falls back to today's floor when the resolver is unavailable — no reach is invented, none is lost", async () => {
    resolveEffectiveAccessMock.mockRejectedValue(new Error("db down"));

    // admin keeps today's access…
    const adminRes = await request(
      buildApp({ id: "u-admin", role: "admin" }),
    ).get("/api/erp/schedule");
    expect(adminRes.status).toBe(200);

    // …and family does not get the O-2 widening on a broken resolver.
    const familyRes = await request(
      buildApp({ id: "u-reception", role: "family" }),
    ).get("/api/erp/schedule");
    expect(familyRes.status).toBe(403);
  });
});

describe("ERP writes — admin-tier only, unchanged above that (WARP-1530)", () => {
  it("a family person WITH a read grant still cannot stage a write", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("family", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const app = buildApp({ id: "u-reception", role: "family" });

    const res = await request(app)
      .post("/api/erp/write-requests")
      .send({ command: "reschedule_appointment", params: {} });

    expect(res.status).toBe(403);
    expect(svcMock.createWriteRequest).not.toHaveBeenCalled();
  });

  it("an admin stages a write exactly as today — the writeEnabled + outbox + confirm chain is untouched", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("admin", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const app = buildApp({ id: "u-admin", role: "admin" });

    const staged = await request(app)
      .post("/api/erp/write-requests")
      .send({ command: "reschedule_appointment", params: {} });

    expect(staged.status).toBe(201);
    expect(staged.body.status).toBe("PENDING_CONFIRMATION");

    const confirmed = await request(app).post("/api/erp/write-requests/wr-1/confirm");
    expect(confirmed.status).toBe(200);
    expect(svcMock.confirmWriteRequest).toHaveBeenCalledWith("wr-1", expect.anything());
  });

  it("the write path never NARROWS on the EFFECTIVE level — writeEnabled stays the service's call", async () => {
    // `connectors[p]` folds `writeEnabled` into the level via min(), so the
    // route deliberately does NOT gate writes on "read_write": doing so would
    // mask the honest 409 WRITE_NOT_ENABLED with a misleading 403.
    resolveEffectiveAccessMock.mockResolvedValue(
      access("admin", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    svcMock.createWriteRequest.mockRejectedValue(ErpError.writeNotEnabled());
    const app = buildApp({ id: "u-admin", role: "admin" });

    const res = await request(app)
      .post("/api/erp/write-requests")
      .send({ command: "reschedule_appointment", params: {} });

    // The point of the test: the caller reaches the service and gets the
    // HONEST 409, not a 403 invented by a route gate reading `read` as
    // "no write permission".
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WRITE_NOT_ENABLED");
    expect(svcMock.createWriteRequest).toHaveBeenCalled();
  });
});

/**
 * WARP-1579 — "read-only Admin" becomes expressible, and the write path stops
 * ignoring the grant.
 *
 * T6 shipped the read half of O-2 and left the write path authorising off the
 * TIER alone, so an Admin-based role holding a deliberately read-only ERP
 * connector grant could still stage and confirm writes. A grant level the
 * enforcement ignores is a false statement in the admin UI, so the fix reads
 * the grant.
 *
 * The RAW grant is what it must read, never `connectors[p]`: that field is
 * `min(grant, connection.writeEnabled ? read_write : read)`, so a `read` there
 * is ambiguous between "the role is read-only" (a 403, honestly) and "the
 * CONNECTION has writes off" (today's 409 `WRITE_NOT_ENABLED`, which names the
 * actual remedy). Collapsing those two into one 403 would trade this bug for a
 * lie — the two tests directly above pin the 409 and stay green.
 *
 * Layer 1 is untouched: `requireRole("owner","admin")`, admin-tier only.
 */
describe("ERP writes — the connector grant LEVEL is enforced (WARP-1579)", () => {
  const WRITE_BODY = { command: "reschedule_appointment", params: {} };

  it("SECURITY FIX: an Admin-based role with a READ-ONLY grant cannot stage a write", async () => {
    // The connection allows writes (so the honest 409 is NOT the answer) and
    // the role deliberately says read-only. min() flattens that to "read" in
    // `connectors`; only `connectorGrants` still carries the operator's intent.
    resolveEffectiveAccessMock.mockResolvedValue(
      access(
        "admin",
        { [EAGLESOFT_PROVIDER]: "read" },
        { [EAGLESOFT_PROVIDER]: "read" },
      ),
    );
    const app = buildApp({ id: "u-readonly-admin", role: "admin" });

    const res = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(svcMock.createWriteRequest).not.toHaveBeenCalled();
    expect(recordAccessDeniedMock).toHaveBeenCalledWith(
      expect.anything(),
      "erp-connector-grant-read-only",
    );
  });

  it("…and cannot confirm one either — every write verb carries the gate", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access(
        "admin",
        { [EAGLESOFT_PROVIDER]: "read" },
        { [EAGLESOFT_PROVIDER]: "read" },
      ),
    );
    const app = buildApp({ id: "u-readonly-admin", role: "admin" });

    const confirm = await request(app).post("/api/erp/write-requests/wr-1/confirm");
    expect(confirm.status).toBe(403);
    expect(svcMock.confirmWriteRequest).not.toHaveBeenCalled();

    const read = await request(app).get("/api/erp/write-requests/wr-1");
    expect(read.status).toBe(403);
    expect(svcMock.getWriteRequest).not.toHaveBeenCalled();
  });

  it("…and the SAME role still READS — which is what makes 'read-only Admin' a real thing", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access(
        "admin",
        { [EAGLESOFT_PROVIDER]: "read" },
        { [EAGLESOFT_PROVIDER]: "read" },
      ),
    );
    const app = buildApp({ id: "u-readonly-admin", role: "admin" });

    const res = await request(app).get("/api/erp/schedule");

    expect(res.status).toBe(200);
    expect(svcMock.getSchedule.mock.calls.at(-1)![1]).toMatchObject({
      role: "admin",
      connectorLevel: "read",
    });
  });

  it("a read_write grant writes — the level is a level, not a ban", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access(
        "admin",
        { [EAGLESOFT_PROVIDER]: "read_write" },
        { [EAGLESOFT_PROVIDER]: "read_write" },
      ),
    );
    const app = buildApp({ id: "u-ops-admin", role: "admin" });

    const staged = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);
    expect(staged.status).toBe(201);

    const confirmed = await request(app).post("/api/erp/write-requests/wr-1/confirm");
    expect(confirmed.status).toBe(200);
  });

  it("a read_write grant on a write-DISABLED connection still gets the honest 409, not a 403", async () => {
    // The grant permits writes; the connection does not. `connectors` mins to
    // "read", but the RAW grant is read_write, so the gate must let this
    // through and leave the diagnosis to the service.
    resolveEffectiveAccessMock.mockResolvedValue(
      access(
        "admin",
        { [EAGLESOFT_PROVIDER]: "read" },
        { [EAGLESOFT_PROVIDER]: "read_write" },
      ),
    );
    svcMock.createWriteRequest.mockRejectedValue(ErpError.writeNotEnabled());
    const app = buildApp({ id: "u-ops-admin", role: "admin" });

    const res = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WRITE_NOT_ENABLED");
  });

  it("an Admin-based role with NO ERP grant cannot write (it cannot read either — §3)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(access("admin", {}, {}));
    const app = buildApp({ id: "u-narrowed-admin", role: "admin" });

    const res = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN");
    expect(recordAccessDeniedMock).toHaveBeenCalledWith(
      expect.anything(),
      "erp-connector-grant-missing",
    );
  });

  it("…but NOT when nothing is connected — 'there is nothing to write to' is not an authz answer", async () => {
    // Mirrors the read gate exactly: with no IntegrationConnection row the
    // resolver reports {} for everyone, so a grantless role is indistinguishable
    // from a granted one. The service's honest NOT_CONFIGURED must win.
    resolveEffectiveAccessMock.mockResolvedValue(access("admin", {}, {}));
    svcMock.createWriteRequest.mockRejectedValue(ErpError.notConfigured(EAGLESOFT_PROVIDER));
    const app = buildApp({ id: "u-admin", role: "admin" }, { connectionConfigured: false });

    const res = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(res.status).not.toBe(403);
    expect(svcMock.createWriteRequest).toHaveBeenCalled();
  });

  it("an owner bypasses layer 2 — never resolved, never narrowed (§3)", async () => {
    const app = buildApp({ id: "u-owner", role: "owner" });

    const res = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(res.status).toBe(201);
    expect(resolveEffectiveAccessMock).not.toHaveBeenCalled();
  });

  it("a role-LESS admin writes exactly as today (connectorGrants: null = nothing narrows)", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access("admin", { [EAGLESOFT_PROVIDER]: "read_write" }),
    );
    const app = buildApp({ id: "u-admin", role: "admin" });

    const res = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(res.status).toBe(201);
  });

  it("falls back to today's floor when the resolver is unavailable — the narrowing half stays SOFT", async () => {
    // T6's stated rule for this axis: the widening is hard-closed, the
    // narrowing is deliberately soft, so it is NOT an availability-independent
    // control. A resolver outage restores today's admin-tier write reach
    // rather than locking the box out of its own ERP.
    resolveEffectiveAccessMock.mockRejectedValue(new Error("db down"));
    const app = buildApp({ id: "u-readonly-admin", role: "admin" });

    const res = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(res.status).toBe(201);
  });

  // ── the soft fall-back is a THROW, and only a throw ──────────────
  //
  // `resolveEffectiveAccess` returns null for "no such user" — a session that
  // outlived its User row, which `requireAuth` cannot catch because `req.user`
  // is built from JWT claims alone. That is a SUCCESSFUL read with a negative
  // answer, not an outage, and the READ gate already refuses it. Treating it
  // as a resolver failure would make writes strictly MORE permissive than
  // reads for the same person.

  it("a session that outlived its User row is refused — writes are never softer than reads", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(null);
    const app = buildApp({ id: "u-deleted", role: "admin" });

    const res = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(res.status).toBe(403);
    expect(svcMock.createWriteRequest).not.toHaveBeenCalled();
    expect(recordAccessDeniedMock).toHaveBeenCalledWith(
      expect.anything(),
      "erp-connector-grant-missing",
    );

    // …and the READ gate answers identically for the same principal, which is
    // the property being pinned: one fact, one answer, both directions.
    const read = await request(app).get("/api/erp/schedule");
    expect(read.status).toBe(403);
  });

  it("…but with nothing connected it still falls through — same exception the read gate makes", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(null);
    svcMock.createWriteRequest.mockRejectedValue(ErpError.notConfigured(EAGLESOFT_PROVIDER));
    const app = buildApp({ id: "u-deleted", role: "admin" }, { connectionConfigured: false });

    const res = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(res.status).not.toBe(403);
    expect(svcMock.createWriteRequest).toHaveBeenCalled();
  });

  it("an absent connectorGrants field does NOT read as 'nothing narrows' — the tri-state fails CLOSED", async () => {
    // Production cannot produce this today (`connectorGrants` is a required
    // field on EffectiveAccessResult and both compose branches set it), but
    // the gate must not be one field-rename or one partial select away from
    // handing back full write reach. `undefined` is not a statement that this
    // person is unnarrowed, so it gets the grant-absent denial, not a pass.
    const { connectorGrants: _omitted, ...withoutGrants } = access(
      "admin",
      { [EAGLESOFT_PROVIDER]: "read_write" },
      { [EAGLESOFT_PROVIDER]: "read_write" },
    );
    resolveEffectiveAccessMock.mockResolvedValue(withoutGrants);
    const app = buildApp({ id: "u-admin", role: "admin" });

    const res = await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(res.status).toBe(403);
    expect(svcMock.createWriteRequest).not.toHaveBeenCalled();
  });

  it("the grant level rides down to the service as the RAW grant, beside the effective level", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(
      access(
        "admin",
        { [EAGLESOFT_PROVIDER]: "read_write" },
        { [EAGLESOFT_PROVIDER]: "read_write" },
      ),
    );
    const app = buildApp({ id: "u-ops-admin", role: "admin" });

    await request(app).post("/api/erp/write-requests").send(WRITE_BODY);

    expect(svcMock.createWriteRequest.mock.calls.at(-1)![1]).toMatchObject({
      id: "u-ops-admin",
      role: "admin",
      connectorGrantLevel: "read_write",
    });
  });
});

describe("WARP-2567 — the practice block on a customer record", () => {
  const LINKS = [
    { id: "pl-erp", externalSystem: EAGLESOFT_API_PROVIDER, externalId: "4471" },
    { id: "pl-stripe", externalSystem: "stripe", externalId: "cus_9f2" },
  ];

  it("is gated by the ERP's OWN connector gate, not by a second one", async () => {
    // The assertion that stops a second PHI gate coming into existence.
    // Comparing the middleware REFERENCES, not their behaviour: two gates
    // that agree today are two gates to keep agreeing, and the day one is
    // updated is the day they diverge silently.
    const router = createErpRouter(createPrismaMock({ connectionConfigured: true }) as never);
    const layerFor = (path: string) =>
      (router as unknown as { stack: Array<{ route?: { path: string; stack: Array<{ handle: unknown }> } }> }).stack.find(
        (l) => l.route?.path === path,
      )?.route;

    const patient = layerFor("/erp/patient/:id");
    const practice = layerFor("/erp/practice/by-company/:companyId");
    expect(patient).toBeDefined();
    expect(practice).toBeDefined();

    // Each route is [gate, handler]; the gate is the first.
    expect(practice!.stack[0].handle).toBe(patient!.stack[0].handle);
  });

  it("refuses a family member with no connector grant, and says nothing else", async () => {
    resolveEffectiveAccessMock.mockResolvedValue(access("family", {}));
    const res = await request(buildApp({ id: "u1", role: "family" }, { partyLinks: LINKS })).get(
      "/api/erp/practice/by-company/co1",
    );
    expect(res.status).toBe(403);
    // The refusal must not disclose that a patient link exists.
    expect(JSON.stringify(res.body)).not.toContain("4471");
    expect(svcMock.getPatient).not.toHaveBeenCalled();
  });

  it("resolves ONLY ERP links — a Stripe id never reaches the dental connector", async () => {
    // The customer carries both. Handing cus_9f2 to Eaglesoft would at best
    // 404 and at worst read a patient whose chart number collides with it.
    resolveEffectiveAccessMock.mockResolvedValue(
      access("owner", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    svcMock.getPatient.mockResolvedValue({ id: "4471", name: "Dana W" });

    const res = await request(buildApp({ id: "u1", role: "owner" }, { partyLinks: LINKS })).get(
      "/api/erp/practice/by-company/co1",
    );
    expect(res.status).toBe(200);

    const where = partyLinkFindMany.mock.calls[0][0].where;
    // Mutation: drop the externalSystem filter → the Stripe row comes back and
    // is sent to getPatient.
    expect(where.externalSystem).toEqual({
      in: [EAGLESOFT_PROVIDER, EAGLESOFT_API_PROVIDER],
    });
    // Mutation: drop this and an unlinked customer's stale links resurface.
    expect(where.isArchived).toBe(false);
    expect(where.companyId).toBe("co1");
  });

  it("answers 'no link' distinctly from 'not permitted' — on the WIRE", async () => {
    // The response tells them apart; the PAGE deliberately does not. Both
    // render as nothing, so a lock never announces that a patient exists.
    resolveEffectiveAccessMock.mockResolvedValue(
      access("owner", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    const res = await request(buildApp({ id: "u1", role: "owner" }, { partyLinks: [] })).get(
      "/api/erp/practice/by-company/co1",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ patients: [], linked: false });
    expect(svcMock.getPatient).not.toHaveBeenCalled();
  });

  it("reads each linked patient through the EXISTING patient read", async () => {
    // Not a new query path: the connector, the drift lock, the degraded
    // handling and the minimum-necessary field set all come along with it.
    resolveEffectiveAccessMock.mockResolvedValue(
      access("owner", { [EAGLESOFT_PROVIDER]: "read" }),
    );
    svcMock.getPatient.mockResolvedValue({ id: "4471", name: "Dana W" });

    const res = await request(
      buildApp({ id: "u1", role: "owner" }, { partyLinks: [LINKS[0]] }),
    ).get("/api/erp/practice/by-company/co1");

    expect(svcMock.getPatient).toHaveBeenCalledTimes(1);
    expect(svcMock.getPatient.mock.calls[0][0]).toBe("4471");
    expect(res.body.linked).toBe(true);
    expect(res.body.patients[0].externalId).toBe("4471");
  });
});
