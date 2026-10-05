/**
 * /api/support/* — the HTTP layer of the service desk (WARP-3528).
 *
 * The services are mocked: what is under test here is the ROUTE — who gets in,
 * what is validated, how every service error becomes a status, and what the
 * service is handed. The services themselves are proven against a real Postgres
 * (__tests__/support-desk.pg.test.ts); the gate composition by the sibling file
 * support.routes.gates.test.ts.
 *
 * The router's routes are ENUMERATED from its stack and compared with the table
 * below, so a route added tomorrow fails this suite until someone decides who may
 * call it — the same tripwire the PM isolation suite keeps.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Express } from "express";
import type { AuthUser } from "../../middleware/auth.js";
import type { EffectiveAccessResolver } from "../../middleware/feature-gate.js";
import type { ModuleId } from "@prisma/client";
import type { FeatureLevel } from "../../services/access-catalog.js";
import { ROUTES, grants, type RouteCase } from "../../__tests__/helpers/support-routes.js";

vi.mock("../../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

const svc = vi.hoisted(() => {
  class SupportContactExistsError extends Error {
    readonly contactId: string;
    constructor(contactId: string) {
      super("contact_email_exists");
      this.contactId = contactId;
    }
  }
  return {
    SupportContactExistsError,
    EMPTY_BODY: "empty_body",
    INVALID_CURSOR: "invalid_cursor",
    EMAIL_CHANNEL_ERRORS: { ACCOUNT_NOT_FOUND: "email_account_not_found", CONTACT_OWNER_NOT_FOUND: "contact_owner_not_found", EMAIL_MODULE_DISABLED: "email_module_disabled", INVALID_TEMPLATE: "invalid_auto_ack_template" },
    listAgents: vi.fn(),
    searchRequesterContacts: vi.fn(),
    createRequesterContact: vi.fn(),
    listDesks: vi.fn(),
    createDesk: vi.fn(),
    updateDesk: vi.fn(),
    getDesk: vi.fn(),
    queueCounts: vi.fn(),
    listTickets: vi.fn(),
    createTicket: vi.fn(),
    getTicket: vi.fn(),
    updateTicket: vi.fn(),
    getConversation: vi.fn(),
    addReply: vi.fn(),
    addNote: vi.fn(),
    escalateTicket: vi.fn(),
    listRequesterTickets: vi.fn(),
    listDeskEmailAccounts: vi.fn(),
    getDeskEmailChannel: vi.fn(),
    bindDeskEmailChannel: vi.fn(),
    retryPublicReply: vi.fn(),
  };
});
vi.mock("../../services/support/support.service.js", () => svc);

import { createSupportRouter, mapSupportError } from "./support.routes.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const FULL: Array<[ModuleId, FeatureLevel]> = [
  ["support", "manage"],
  ["projects", "act"],
];

const person = (role: string, id = "u-1"): AuthUser =>
  ({ id, username: `${role}-name`, displayName: role, role }) as AuthUser;

let current: AuthUser | undefined;
let resolver: EffectiveAccessResolver;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (current) req.user = current;
    next();
  });
  app.use("/api", createSupportRouter({} as never, { resolveAccess: (id) => resolver(id), isEmailModuleEffective: async () => true }));
  return app;
}

const TICKET = { id: "t1", key: "SUP-1" };
beforeEach(() => {
  vi.clearAllMocks();
  current = person("owner");
  resolver = async () => grants(FULL);
  svc.listAgents.mockResolvedValue([]);
  svc.searchRequesterContacts.mockResolvedValue([]);
  svc.createRequesterContact.mockResolvedValue({ id: "c1" });
  svc.listDesks.mockResolvedValue([]);
  svc.createDesk.mockResolvedValue({ id: "d1", name: "Support", identifier: "SUP" });
  svc.updateDesk.mockResolvedValue({ id: "d1", name: "Support", identifier: "SUP" });
  svc.queueCounts.mockResolvedValue({});
  svc.listTickets.mockResolvedValue({ tickets: [], total: 0, nextCursor: null });
  svc.createTicket.mockResolvedValue(TICKET);
  svc.getTicket.mockResolvedValue(TICKET);
  svc.updateTicket.mockResolvedValue(TICKET);
  svc.getConversation.mockResolvedValue({ entries: [], truncated: false });
  svc.addReply.mockResolvedValue({ entry: {}, ticket: TICKET });
  svc.addNote.mockResolvedValue({ entry: {}, ticket: TICKET });
  svc.escalateTicket.mockResolvedValue({ workItem: {}, ticket: TICKET });
  svc.listRequesterTickets.mockResolvedValue({ tickets: [], total: 0, nextCursor: null });
  svc.listDeskEmailAccounts.mockResolvedValue([]);
  svc.getDeskEmailChannel.mockResolvedValue(null);
  svc.bindDeskEmailChannel.mockResolvedValue(null);
  svc.retryPublicReply.mockResolvedValue({ status: "queued" });
});

// ── the route table ──────────────────────────────────────────────────────────

const send = (app: Express, c: RouteCase) => {
  const r = request(app)[c.method](c.url);
  return c.body === undefined ? r : r.send(c.body as object);
};

describe("the route table", () => {
  it("covers every route the router mounts — a new route fails until it is classified here", () => {
    const router = createSupportRouter({} as never);
    const mounted = (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>)
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path}`))
      .sort();
    expect(mounted).toEqual(ROUTES.map((c) => `${c.method} ${c.path}`).sort());
  });
});

describe("who gets in", () => {
  it.each(["owner", "admin"])("lets %s through every route", async (role) => {
    current = person(role);
    const app = buildApp();
    for (const c of ROUTES) {
      const res = await send(app, c);
      expect(res.status, `${role} ${c.method} ${c.url}`).toBe(c.ok);
    }
  });

  it("lets a family member work tickets but not set up a desk", async () => {
    current = person("family");
    const app = buildApp();
    for (const c of ROUTES) {
      const res = await send(app, c);
      expect(res.status, `${c.method} ${c.url}`).toBe(c.adminOnly ? 403 : c.ok);
    }
    expect(svc.createDesk).not.toHaveBeenCalled();
    expect(svc.updateDesk).not.toHaveBeenCalled();
  });

  it.each(["guest", "service"])(
    "refuses a %s on every route — the assistant's principal is not admitted here",
    async (role) => {
      current = person(role);
      const app = buildApp();
      for (const c of ROUTES) {
        const res = await send(app, c);
        expect(res.status, `${role} ${c.method} ${c.url}`).toBe(403);
      }
      for (const fn of Object.values(svc)) {
        if (typeof fn === "function" && "mock" in fn) expect(fn).not.toHaveBeenCalled();
      }
    },
  );

  it("refuses a request with no role at all", async () => {
    current = undefined;
    const res = await request(buildApp()).get("/api/support/tickets");
    expect(res.status).toBe(403);
  });
});

describe("the per-person grant level", () => {
  const WRITES = ROUTES.filter((c) => c.method !== "get");

  it("answers a viewer-only person the box's own 404 on every write, and reads still work", async () => {
    resolver = async () => grants([["support", "view"], ["projects", "act"]]);
    const app = buildApp();
    for (const c of ROUTES) {
      const res = await send(app, c);
      if (c.method === "get" && !c.adminOnly) expect(res.status, c.url).toBe(c.ok);
      else {
        expect(res.status, `${c.method} ${c.url}`).toBe(404);
        expect(res.body).toEqual({ error: "module_disabled", module: "support" });
      }
    }
    expect(WRITES.length).toBeGreaterThan(0);
  });

  it("needs `manage` — not just `act` — to run a desk", async () => {
    resolver = async () => grants([["support", "act"], ["projects", "act"]]);
    const app = buildApp();
    for (const c of ROUTES.filter((r) => r.adminOnly)) {
      const res = await send(app, c);
      expect(res.status, c.url).toBe(404);
      expect(res.body.module).toBe("support");
    }
    const ticket = ROUTES.find((c) => c.method === "post" && c.path === "/support/tickets")!;
    expect((await send(app, ticket)).status).toBe(201);
  });

  it("needs the Projects grant as well to escalate, and says which module is missing", async () => {
    resolver = async () => grants([["support", "act"]]);
    const app = buildApp();
    const esc = ROUTES.find((c) => c.path.endsWith("/escalate"))!;
    const res = await send(app, esc);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "module_disabled", module: "projects" });
    expect(svc.escalateTicket).not.toHaveBeenCalled();
    const reply = ROUTES.find((c) => c.path.endsWith("/replies"))!;
    expect((await send(app, reply)).status).toBe(201);
  });
});

// ── validation ───────────────────────────────────────────────────────────────

describe("validation", () => {
  const bad = async (method: "get" | "post" | "patch", url: string, body?: object) => {
    const r = request(buildApp())[method](url);
    const res = await (body === undefined ? r : r.send(body));
    expect(res.status, `${method} ${url}`).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  };

  it.each([
    ["an unknown queue", "/api/support/tickets?queue=everything"],
    ["a zero limit", "/api/support/tickets?limit=0"],
    ["a limit over the cap", "/api/support/tickets?limit=201"],
    ["a non-numeric limit", "/api/support/tickets?limit=abc"],
    ["an unknown priority", "/api/support/tickets?priority=critical"],
    ["a desk id that is far too long", `/api/support/queues?deskId=${"x".repeat(65)}`],
  ])("rejects %s on a read", async (_n, url) => bad("get", url));

  it("rejects malformed ticket bodies", async () => {
    await bad("post", "/api/support/tickets", {});
    await bad("post", "/api/support/tickets", { deskId: "d1", subject: "   " });
    await bad("post", "/api/support/tickets", { deskId: "d1", subject: "s", priority: "critical" });
    // A person cannot forge a channel only another path produces.
    await bad("post", "/api/support/tickets", { deskId: "d1", subject: "s", channel: "EMAIL" });
    await bad("post", "/api/support/tickets", { deskId: "d1", subject: "s", requester: { kind: "CONTACT" } });
    await bad("post", "/api/support/tickets", { deskId: "d1", subject: "s", requester: { kind: "ROBOT" } });
    await bad("post", "/api/support/tickets", { deskId: "d1", subject: "s", assigneeIds: Array(51).fill("u") });
    await bad("patch", "/api/support/tickets/t1", { priority: "now" });
    await bad("patch", "/api/support/tickets/t1", { subject: "" });
    expect(svc.createTicket).not.toHaveBeenCalled();
    expect(svc.updateTicket).not.toHaveBeenCalled();
  });

  it("rejects malformed replies, notes, escalations, desks and contacts", async () => {
    await bad("post", "/api/support/tickets/t1/replies", { bodyHtml: "" });
    await bad("post", "/api/support/tickets/t1/replies", {});
    await bad("post", "/api/support/tickets/t1/notes", { bodyHtml: 5 });
    await bad("post", "/api/support/tickets/t1/escalate", {});
    await bad("post", "/api/support/tickets/t1/escalate", { projectId: "p1", title: "" });
    await bad("post", "/api/support/desks", { name: "" });
    await bad("post", "/api/support/desks", { name: "Support", identifier: "no spaces" });
    await bad("post", "/api/support/desks", { name: "Support", identifier: "TOOLONGKEYXX" });
    await bad("patch", "/api/support/desks/d1", { archived: "yes" });
    await bad("post", "/api/support/contacts", { email: "x".repeat(321) });
    expect(svc.addReply).not.toHaveBeenCalled();
    expect(svc.createDesk).not.toHaveBeenCalled();
  });
});

// ── what the service is handed ───────────────────────────────────────────────

describe("what the service is handed", () => {
  it("passes the caller, the parsed body and whether they hold Projects", async () => {
    current = person("admin", "u-7");
    const body = { deskId: "d1", subject: "Printer", requester: { kind: "CONTACT", contactId: "c9" }, channel: "PHONE" };
    await request(buildApp()).post("/api/support/tickets").send(body).expect(201);
    expect(svc.createTicket).toHaveBeenCalledTimes(1);
    const [, viewer, input, ctx] = svc.createTicket.mock.calls[0]!;
    expect(viewer).toEqual({ id: "u-7", role: "admin" });
    expect(input).toEqual(body);
    // FULL holds Support and Projects but not the CRM.
    expect(ctx).toEqual({ canReadProjects: true, canReadCrm: false });
  });

  it("masks linked work items for a caller without the Projects grant", async () => {
    resolver = async () => grants([["support", "act"]]);
    await request(buildApp()).get("/api/support/tickets/SUP-1").expect(200);
    expect(svc.getTicket.mock.calls[0]![2]).toEqual({ canReadProjects: false, canReadCrm: false });
    await request(buildApp()).get("/api/support/tickets/t1/conversation").expect(200);
    expect(svc.getConversation.mock.calls[0]![2]).toEqual({ canReadProjects: false, canReadCrm: false });
  });

  it("passes the ref, the id and the parsed list query through untouched", async () => {
    await request(buildApp()).get("/api/support/tickets/SUP-12").expect(200);
    expect(svc.getTicket.mock.calls[0]![1]).toBe("SUP-12");
    await request(buildApp())
      .get("/api/support/tickets?deskId=d1&queue=mine&q=print&limit=25&cursor=abc&priority=high")
      .expect(200);
    expect(svc.listTickets.mock.calls[0]![2]).toEqual({
      deskId: "d1",
      queue: "mine",
      q: "print",
      limit: 25,
      cursor: "abc",
      priority: "high",
    });
    await request(buildApp()).get("/api/support/requesters/c1/tickets?limit=6").expect(200);
    expect(svc.listRequesterTickets.mock.calls[0]![1]).toBe("c1");
    expect(svc.listRequesterTickets.mock.calls[0]![2]).toEqual({ limit: 6 });
  });

  it("escalates with the Projects grant already proven, and answers 201 with the new item", async () => {
    svc.escalateTicket.mockResolvedValue({ workItem: { key: "ENG-1" }, ticket: TICKET });
    const res = await request(buildApp())
      .post("/api/support/tickets/t1/escalate")
      .send({ projectId: "p1", title: "Fix it" })
      .expect(201);
    expect(res.body.workItem.key).toBe("ENG-1");
    expect(svc.escalateTicket.mock.calls[0]![2]).toBe("t1");
    expect(svc.escalateTicket.mock.calls[0]![3]).toEqual({ projectId: "p1", title: "Fix it" });
    expect(svc.escalateTicket.mock.calls[0]![4]).toEqual({ canReadProjects: true, canReadCrm: false });
  });

  it("wraps the service's answers in the envelopes the dashboard reads", async () => {
    svc.listTickets.mockResolvedValue({ tickets: [{ id: "a" }], total: 9, nextCursor: "n" });
    expect((await request(buildApp()).get("/api/support/tickets")).body).toEqual({
      tickets: [{ id: "a" }],
      total: 9,
      nextCursor: "n",
    });
    svc.getTicket.mockResolvedValue({ id: "a" });
    expect((await request(buildApp()).get("/api/support/tickets/a")).body).toEqual({ ticket: { id: "a" } });
    svc.getConversation.mockResolvedValue({ entries: [1], truncated: true });
    expect((await request(buildApp()).get("/api/support/tickets/a/conversation")).body).toEqual({
      entries: [1],
      truncated: true,
    });
    svc.listDesks.mockResolvedValue([{ id: "d" }]);
    expect((await request(buildApp()).get("/api/support/desks")).body).toEqual({ desks: [{ id: "d" }] });
    svc.queueCounts.mockResolvedValue({ open: 2 });
    expect((await request(buildApp()).get("/api/support/queues")).body).toEqual({ queues: { open: 2 } });
    svc.listAgents.mockResolvedValue([{ id: "u", displayName: "U" }]);
    expect((await request(buildApp()).get("/api/support/agents")).body).toEqual({
      agents: [{ id: "u", displayName: "U" }],
    });
    svc.searchRequesterContacts.mockResolvedValue([{ id: "c" }]);
    expect((await request(buildApp()).get("/api/support/contacts?q=ab")).body).toEqual({ contacts: [{ id: "c" }] });
    svc.createRequesterContact.mockResolvedValue({ id: "c2" });
    const made = await request(buildApp()).post("/api/support/contacts").send({ displayName: "D" });
    expect(made.status).toBe(201);
    expect(made.body).toEqual({ contact: { id: "c2" } });
  });
});

// ── audit ────────────────────────────────────────────────────────────────────

describe("the audit trail for desk administration", () => {
  it("records a desk being created, with the actor and the desk", async () => {
    await request(buildApp()).post("/api/support/desks").send({ name: "Support" }).expect(201);
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    const row = recordActivityMock.mock.calls[0]![0];
    expect(row).toMatchObject({ kind: "system", severity: "ok", what: "Service desk created", sub: "Support" });
    expect(row.refs).toMatchObject({ deskId: "d1", identifier: "SUP" });
  });

  it.each([
    [{ archived: true }, "Service desk archived"],
    [{ archived: false }, "Service desk restored"],
    [{ name: "Help" }, "Service desk updated"],
  ])("records %j as %s", async (patch, what) => {
    await request(buildApp()).patch("/api/support/desks/d1").send(patch).expect(200);
    expect(recordActivityMock.mock.calls[0]![0]).toMatchObject({ kind: "system", what });
  });

  it("records nothing when the change was refused", async () => {
    svc.updateDesk.mockRejectedValue(new Error("desk_not_found"));
    await request(buildApp()).patch("/api/support/desks/d1").send({ name: "x" }).expect(404);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});

// ── error mapping ────────────────────────────────────────────────────────────

describe("every service error becomes the right status", () => {
  const CASES: Array<[string, number]> = [
    ["desk_not_found", 404],
    ["ticket_not_found", 404],
    ["contact_not_found", 404],
    ["project_not_found", 404],
    ["label_not_found", 404],
    ["state_not_found", 404],
    ["company_not_found", 404],
    ["department_not_found", 404],
    ["invalid_state", 422],
    ["invalid_label", 422],
    ["invalid_assignee", 422],
    ["invalid_requester", 422],
    ["invalid_channel", 422],
    ["department_not_assignable", 422],
    ["empty_body", 422],
    ["contact_needs_a_name", 422],
    ["invalid_cursor", 422],
    ["desk_archived", 409],
    ["identifier_taken", 409],
    ["department_archived", 409],
    ["concurrent_mutation", 409],
  ];

  it.each(CASES)("%s -> %i, with the code in the body", async (code, status) => {
    svc.getTicket.mockRejectedValue(new Error(code));
    const res = await request(buildApp()).get("/api/support/tickets/t1");
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(code);
  });

  it("explains a lost compare-and-set in words", async () => {
    svc.updateTicket.mockRejectedValue(new Error("concurrent_mutation"));
    const res = await request(buildApp()).patch("/api/support/tickets/t1").send({ priority: "low" });
    expect(res.body).toMatchObject({ code: "CONCURRENT_MUTATION" });
    expect(res.body.message).toMatch(/try again/i);
  });

  it("names the existing contact on a duplicate address", async () => {
    svc.createRequesterContact.mockRejectedValue(new svc.SupportContactExistsError("c-existing"));
    const res = await request(buildApp()).post("/api/support/contacts").send({ email: "a@b.test" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "contact_email_exists", contactId: "c-existing" });
  });

  it("hands anything it does not know to the error handler instead of guessing a status", async () => {
    svc.getTicket.mockRejectedValue(new Error("something unexpected"));
    const app = buildApp();
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "handled_elsewhere", message: err.message });
    });
    const res = await request(app).get("/api/support/tickets/t1");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("handled_elsewhere");
    expect(mapSupportError(new Error("nope"), { status: vi.fn() } as never)).toBe(false);
  });
});
