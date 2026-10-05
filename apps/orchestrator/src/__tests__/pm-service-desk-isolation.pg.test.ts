/**
 * WARP-3528 (ADR-069 §1) — the `pm` grant is never a way into a customer
 * conversation.
 *
 * A ticket is a `PmWorkItem` in a SERVICE_DESK project. Every route under
 * `/api/pm/*` and `/api/mobile/pm/*` — and every other reader of PM rows — must
 * answer for a desk, and for everything under it, exactly as it does for a row
 * that does not exist.
 *
 * This file drives the REAL routers against a REAL Postgres. The routers' route
 * lists are ENUMERATED from their stacks and compared with the table below, so a
 * route added tomorrow fails here until somebody classifies it — the exclusion
 * cannot be forgotten silently. A mocked Prisma could not prove this at all: the
 * rule lives in `where` clauses.
 *
 * `business_find` / `business_create` reach PM only through these routes, so
 * their exclusion is this file's exclusion.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express, { type Router } from "express";
import type { Server } from "node:http";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";

vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

type Method = "get" | "post" | "put" | "patch" | "delete";
interface Ids {
  workspaceSlug: string;
  pmProjectId: string;
  pmItemId: string;
  deskId: string;
  deskStateId: string;
  deskLabelId: string;
  deskItemId: string;
  deskPropertyId: string;
  relationId: string;
  ownerId: string;
}
interface Probe {
  /** `METHOD /full/path` exactly as the router declares it. */
  route: string;
  /** desk: every id names a desk row and the answer is 404. collection: the
   *  response may carry no desk row. control: nothing to do with desks. */
  kind: "desk" | "collection" | "control";
  method: Method;
  url: (ids: Ids) => string;
  body?: object;
}

const probes: Probe[] = [
  // ── native router: a desk, or a row under one, is 404 ────────────────────
  { route: "GET /api/pm/projects/:id", kind: "desk", method: "get", url: (i) => `/api/pm/projects/${i.deskId}` },
  { route: "PATCH /api/pm/projects/:id", kind: "desk", method: "patch", url: (i) => `/api/pm/projects/${i.deskId}`, body: { name: "renamed" } },
  { route: "DELETE /api/pm/projects/:id", kind: "desk", method: "delete", url: (i) => `/api/pm/projects/${i.deskId}` },
  { route: "GET /api/pm/projects/:id/states", kind: "desk", method: "get", url: (i) => `/api/pm/projects/${i.deskId}/states` },
  { route: "POST /api/pm/projects/:id/states", kind: "desk", method: "post", url: (i) => `/api/pm/projects/${i.deskId}/states`, body: { name: "Extra", group: "started" } },
  { route: "PATCH /api/pm/states/:id", kind: "desk", method: "patch", url: (i) => `/api/pm/states/${i.deskStateId}`, body: { name: "Renamed" } },
  { route: "DELETE /api/pm/states/:id", kind: "desk", method: "delete", url: (i) => `/api/pm/states/${i.deskStateId}` },
  { route: "POST /api/pm/projects/:id/states/reorder", kind: "desk", method: "post", url: (i) => `/api/pm/projects/${i.deskId}/states/reorder`, body: { state_ids: ["DESK_STATE"] } },
  { route: "GET /api/pm/projects/:id/labels", kind: "desk", method: "get", url: (i) => `/api/pm/projects/${i.deskId}/labels` },
  { route: "POST /api/pm/projects/:id/labels", kind: "desk", method: "post", url: (i) => `/api/pm/projects/${i.deskId}/labels`, body: { name: "Extra" } },
  { route: "PATCH /api/pm/labels/:id", kind: "desk", method: "patch", url: (i) => `/api/pm/labels/${i.deskLabelId}`, body: { name: "Renamed" } },
  { route: "DELETE /api/pm/labels/:id", kind: "desk", method: "delete", url: (i) => `/api/pm/labels/${i.deskLabelId}` },
  { route: "GET /api/pm/projects/:id/work-items", kind: "desk", method: "get", url: (i) => `/api/pm/projects/${i.deskId}/work-items` },
  { route: "POST /api/pm/projects/:id/work-items", kind: "desk", method: "post", url: (i) => `/api/pm/projects/${i.deskId}/work-items`, body: { name: "Smuggled" } },
  { route: "GET /api/pm/work-items/:id", kind: "desk", method: "get", url: (i) => `/api/pm/work-items/${i.deskItemId}` },
  { route: "PATCH /api/pm/work-items/:id", kind: "desk", method: "patch", url: (i) => `/api/pm/work-items/${i.deskItemId}`, body: { name: "renamed" } },
  { route: "POST /api/pm/work-items/:id/transition", kind: "desk", method: "post", url: (i) => `/api/pm/work-items/${i.deskItemId}/transition`, body: { state_id: "anything" } },
  { route: "DELETE /api/pm/work-items/:id", kind: "desk", method: "delete", url: (i) => `/api/pm/work-items/${i.deskItemId}` },
  { route: "POST /api/pm/work-items/:id/archive", kind: "desk", method: "post", url: (i) => `/api/pm/work-items/${i.deskItemId}/archive` },
  { route: "POST /api/pm/work-items/:id/restore", kind: "desk", method: "post", url: (i) => `/api/pm/work-items/${i.deskItemId}/restore` },
  { route: "GET /api/pm/work-items/:id/comments", kind: "desk", method: "get", url: (i) => `/api/pm/work-items/${i.deskItemId}/comments` },
  { route: "POST /api/pm/work-items/:id/comments", kind: "desk", method: "post", url: (i) => `/api/pm/work-items/${i.deskItemId}/comments`, body: { comment_html: "<p>x</p>" } },
  { route: "GET /api/pm/work-items/:id/activity", kind: "desk", method: "get", url: (i) => `/api/pm/work-items/${i.deskItemId}/activity` },
  // ── relations router ─────────────────────────────────────────────────────
  { route: "GET /api/pm/work-items/:id/relations", kind: "desk", method: "get", url: (i) => `/api/pm/work-items/${i.deskItemId}/relations` },
  { route: "POST /api/pm/work-items/:id/relations", kind: "desk", method: "post", url: (i) => `/api/pm/work-items/${i.pmItemId}/relations`, body: { to_work_item_id: "DESK_ITEM", kind: "RELATES" } },
  { route: "DELETE /api/pm/relations/:relationId", kind: "desk", method: "delete", url: (i) => `/api/pm/relations/${i.relationId}` },
  // ── editing fields share the same project / desk boundary ────────────────
  { route: "GET /api/pm/projects/:id/properties", kind: "desk", method: "get", url: (i) => `/api/pm/projects/${i.deskId}/properties` },
  { route: "POST /api/pm/projects/:id/properties", kind: "desk", method: "post", url: (i) => `/api/pm/projects/${i.deskId}/properties`, body: { name: "Extra", type: "text" } },
  { route: "POST /api/pm/projects/:id/properties/reorder", kind: "desk", method: "post", url: (i) => `/api/pm/projects/${i.deskId}/properties/reorder`, body: { property_ids: ["DESK_PROPERTY"] } },
  { route: "PATCH /api/pm/properties/:id", kind: "desk", method: "patch", url: (i) => `/api/pm/properties/${i.deskPropertyId}`, body: { name: "Renamed" } },
  { route: "DELETE /api/pm/properties/:id", kind: "desk", method: "delete", url: (i) => `/api/pm/properties/${i.deskPropertyId}` },
  { route: "PUT /api/pm/work-items/:id/properties/:propertyId", kind: "desk", method: "put", url: (i) => `/api/pm/work-items/${i.deskItemId}/properties/${i.deskPropertyId}`, body: { value: { text: "Changed" } } },
  { route: "DELETE /api/pm/work-items/:id/properties/:propertyId", kind: "desk", method: "delete", url: (i) => `/api/pm/work-items/${i.deskItemId}/properties/${i.deskPropertyId}` },
  // ── mobile router ────────────────────────────────────────────────────────
  { route: "GET /api/mobile/pm/work-items/:id", kind: "desk", method: "get", url: (i) => `/api/mobile/pm/work-items/${i.deskItemId}?workspace=${i.workspaceSlug}&project_id=${i.deskId}` },
  // ── schedule router: stage's Timeline and My Work need the same boundary ──
  { route: "GET /api/pm/projects/:id/timeline", kind: "desk", method: "get", url: (i) => `/api/pm/projects/${i.deskId}/timeline?from=2026-10-01&to=2026-10-31` },
  // ── collections: nothing of a desk may appear ────────────────────────────
  { route: "GET /api/pm/projects", kind: "collection", method: "get", url: () => "/api/pm/projects?archived=1" },
  { route: "GET /api/pm/summary", kind: "collection", method: "get", url: (i) => `/api/pm/summary?workspace=${i.workspaceSlug}` },
  { route: "GET /api/pm/work-items", kind: "collection", method: "get", url: () => "/api/pm/work-items?q=warp3528i" },
  { route: "GET /api/pm/assigned-to-me", kind: "collection", method: "get", url: () => "/api/pm/assigned-to-me" },
  { route: "GET /api/pm/my-work", kind: "collection", method: "get", url: () => "/api/pm/my-work?section=assigned&today=2026-10-03" },
  { route: "GET /api/mobile/pm/projects", kind: "collection", method: "get", url: (i) => `/api/mobile/pm/projects?workspace=${i.workspaceSlug}` },
  { route: "GET /api/mobile/pm/work-items", kind: "collection", method: "get", url: (i) => `/api/mobile/pm/work-items?workspace=${i.workspaceSlug}&project_id=${i.pmProjectId}` },
  // ── controls: nothing to do with a desk ──────────────────────────────────
  { route: "GET /api/pm/workspaces", kind: "control", method: "get", url: () => "/api/pm/workspaces" },
  { route: "GET /api/pm/workspaces/:slug", kind: "control", method: "get", url: (i) => `/api/pm/workspaces/${i.workspaceSlug}` },
  { route: "POST /api/pm/projects", kind: "control", method: "post", url: () => "/api/pm/projects", body: { name: "warp3528i-created", identifier: "W28IC" } },
  { route: "GET /api/mobile/pm/workspaces", kind: "control", method: "get", url: () => "/api/mobile/pm/workspaces" },
];

describe.skipIf(!RUN)("the PM surface answers 404 for a service desk and everything under it (WARP-3528)", () => {
  let prisma: PrismaClient;
  // ONE listening server for the whole file: `request(server)` binds a fresh
  // ephemeral port per call, and ~100 of them collide on Windows (EADDRINUSE).
  let server: Server;
  let ids: Ids;
  let routers: Array<{ router: Router; prefix: string }>;
  // Only ever in a desk row: if any appears in a PM response, a desk leaked.
  const DESK_MARKERS = [
    "warp3528i-DESK-NAME",
    "warp3528i-TICKET-SUBJECT",
    "warp3528i-TICKET-BODY",
    "W28IZ",
  ];
  const P = "warp3528i-";
  const OURS = { startsWith: P } as const;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new RealPrismaClient();
    await prisma.$connect();
    const [{ createPmNativeRouter }, { createPmRelationsRouter }, { createPmMobileRouter }, { createPmScheduleRouter }, { createPmFieldsRouter }] =
      await Promise.all([
        import("../routes/pm/native.js"),
        import("../routes/pm/relations.js"),
        import("../routes/mobile/pm.js"),
        import("../routes/pm/schedule.js"),
        import("../routes/pm/fields.js"),
      ]);
    const native = createPmNativeRouter(prisma);
    const relations = createPmRelationsRouter(prisma);
    const mobile = createPmMobileRouter(prisma);
    const schedule = createPmScheduleRouter(prisma);
    const fields = createPmFieldsRouter(prisma);
    routers = [
      { router: native, prefix: "/api" },
      { router: relations, prefix: "/api" },
      { router: mobile, prefix: "" },
      { router: schedule, prefix: "/api" },
      { router: fields, prefix: "/api" },
    ];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: `${P}owner`, username: `${P}owner`, displayName: "Owner", role: "owner" } as never;
      next();
    });
    app.use("/api", native);
    app.use("/api", relations);
    app.use(mobile);
    app.use("/api", schedule);
    app.use("/api", fields);
    app.use(
      (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(500).json({ error: "unhandled", message: err.message });
      },
    );
    server = app.listen(0, "127.0.0.1");
  });

  async function cleanup(): Promise<void> {
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmProject.deleteMany({ where: { identifier: { in: ["W28IC", "W28IZ", "W28IP"] } } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
  }

  afterAll(async () => {
    server.close();
    await cleanup();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanup();
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `${P}ws-${Date.now()}`, name: `${P}ws` },
    });
    const owner = `${P}owner`;

    const project = await prisma.pmProject.create({
      data: {
        workspaceId: ws.id,
        name: `${P}project`,
        identifier: "W28IP",
        states: { create: [{ name: "Todo", group: "unstarted", isDefault: true }] },
        labels: { create: [{ name: "Bug" }] },
      },
      include: { states: true, labels: true },
    });
    const pmItem = await prisma.pmWorkItem.create({
      data: {
        projectId: project.id,
        sequenceId: 1,
        name: `${P}plain item`,
        stateId: project.states[0]!.id,
        createdById: owner,
        dueDate: new Date("2026-10-02T00:00:00.000Z"),
        assignees: { create: [{ userId: owner }] },
      },
    });
    await prisma.pmComment.create({ data: { workItemId: pmItem.id, commentHtml: "<p>ok</p>" } });
    await prisma.pmProject.update({ where: { id: project.id }, data: { seqCounter: 1 } });

    const desk = await prisma.pmProject.create({
      data: {
        workspaceId: ws.id,
        kind: "SERVICE_DESK",
        name: "warp3528i-DESK-NAME",
        identifier: "W28IZ",
        states: {
          create: [
            { name: "New", group: "unstarted", isDefault: true },
            { name: "Solved", group: "completed", slaClock: "STOPPED" },
          ],
        },
        labels: { create: [{ name: "Question" }] },
      },
      include: { states: true, labels: true },
    });
    const deskItem = await prisma.pmWorkItem.create({
      data: {
        projectId: desk.id,
        sequenceId: 1,
        name: "warp3528i-TICKET-SUBJECT",
        descriptionHtml: "<p>warp3528i-TICKET-BODY</p>",
        stateId: desk.states[0]!.id,
        createdById: owner,
        dueDate: new Date("2026-10-02T00:00:00.000Z"),
        assignees: { create: [{ userId: owner }] },
        labels: { create: [{ labelId: desk.labels[0]!.id }] },
      },
    });
    await prisma.pmProject.update({ where: { id: desk.id }, data: { seqCounter: 1 } });
    await prisma.pmTicket.create({
      data: {
        workItemId: deskItem.id,
        requesterKind: "USER",
        requesterUserId: `${P}requester`,
        requesterName: `${P}Ana`,
        channel: "INTERNAL",
      },
    });
    await prisma.pmComment.createMany({
      data: [
        { workItemId: deskItem.id, commentHtml: "<p>note</p>" },
        { workItemId: deskItem.id, commentHtml: "<p>reply</p>", visibility: "PUBLIC" },
      ],
    });
    await prisma.pmActivity.create({ data: { workItemId: deskItem.id, verb: "created" } });
    const deskProperty = await prisma.pmCustomProperty.create({
      data: { projectId: desk.id, name: "Private", type: "text" },
    });
    await prisma.pmWorkItemPropertyValue.create({
      data: { workItemId: deskItem.id, propertyId: deskProperty.id, value: { text: "Private" } },
    });

    // The escalation link, as the support service writes it: one symmetric row,
    // smaller id first.
    const [fromId, toId] =
      deskItem.id < pmItem.id ? [deskItem.id, pmItem.id] : [pmItem.id, deskItem.id];
    const relation = await prisma.pmWorkItemRelation.create({
      data: { fromId, toId, kind: "RELATES" },
    });

    ids = {
      workspaceSlug: ws.slug,
      pmProjectId: project.id,
      pmItemId: pmItem.id,
      deskId: desk.id,
      deskStateId: desk.states[0]!.id,
      deskLabelId: desk.labels[0]!.id,
      deskItemId: deskItem.id,
      deskPropertyId: deskProperty.id,
      relationId: relation.id,
      ownerId: owner,
    };
  });

  const send = (p: Probe) => {
    const url = p.url(ids);
    const body =
      p.body === undefined
        ? undefined
        : JSON.parse(JSON.stringify(p.body)
          .replace("DESK_ITEM", ids.deskItemId)
          .replace("DESK_STATE", ids.deskStateId)
          .replace("DESK_PROPERTY", ids.deskPropertyId));
    const r = request(server)[p.method](url);
    return body === undefined ? r : r.send(body);
  };

  const mountedRoutes = (): string[] =>
    routers
      .flatMap(({ router, prefix }) =>
        (router.stack as Array<{ route?: { path: string; methods: Record<string, boolean> } }>)
          .filter((l) => l.route)
          .flatMap((l) =>
            Object.keys(l.route!.methods).map((m) => `${m.toUpperCase()} ${prefix}${l.route!.path}`),
          ),
      )
      .sort();

  it("classifies EVERY route the PM routers mount — a new route fails here until it is decided", () => {
    expect(mountedRoutes()).toEqual(probes.map((p) => p.route).sort());
  });

  it.each(probes.filter((p) => p.kind === "desk").map((p) => [p.route, p] as const))(
    "%s is a 404 for a desk row, with no trace of it in the body",
    async (_route, probe) => {
      const res = await send(probe);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      const text = JSON.stringify(res.body);
      for (const marker of DESK_MARKERS) expect(text).not.toContain(marker);
      // A final getWorkItem guard is too late if the write already committed.
      expect(await prisma.pmWorkItem.findUnique({ where: { id: ids.deskItemId }, select: { isArchived: true } }))
        .toEqual({ isArchived: false });
      expect(await prisma.pmWorkItemPropertyValue.findUnique({
        where: { workItemId_propertyId: { workItemId: ids.deskItemId, propertyId: ids.deskPropertyId } },
        select: { value: true },
      })).toEqual({ value: { text: "Private" } });
    },
  );

  it.each(probes.filter((p) => p.kind === "collection").map((p) => [p.route, p] as const))(
    "%s never lists a desk, a ticket or anything about them",
    async (_route, probe) => {
      const res = await send(probe);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const text = JSON.stringify(res.body);
      for (const marker of DESK_MARKERS) expect(text).not.toContain(marker);
      for (const id of [ids.deskId, ids.deskItemId, ids.deskStateId, ids.deskLabelId, ids.relationId]) {
        expect(text).not.toContain(id);
      }
      // The project's own row is there, so the check above is not vacuous.
      if (probe.route !== "GET /api/pm/summary" && probe.route !== "GET /api/pm/assigned-to-me") {
        expect(text).toMatch(/warp3528i|W28IP|plain item|project/i);
      }
    },
  );

  it("counts only projects in the summary", async () => {
    const res = await send(probes.find((p) => p.route === "GET /api/pm/summary")!);
    expect(res.body.summary).toMatchObject({ activeProjects: 1, itemsOpen: 1 });
  });

  it("lists the owner's assigned work without the ticket assigned to them", async () => {
    const res = await send(probes.find((p) => p.route === "GET /api/pm/assigned-to-me")!);
    expect(res.body.work_items.map((w: { id: string }) => w.id)).toEqual([ids.pmItemId]);
  });

  it("My Work excludes an assigned, authored and overdue ticket from every list and count", async () => {
    for (const section of ["assigned", "created", "overdue", "due_this_week"]) {
      const res = await request(server).get(`/api/pm/my-work?section=${section}&today=2026-10-03`);
      expect(res.status).toBe(200);
      expect(res.body.counts).toEqual({ assigned: 1, created: 1, overdue: 1, dueThisWeek: 0 });
      expect(res.body.items.map((w: { id: string }) => w.id)).toEqual(section === "due_this_week" ? [] : [ids.pmItemId]);
      expect(JSON.stringify(res.body)).not.toContain(ids.deskId);
      expect(JSON.stringify(res.body)).not.toContain(ids.deskItemId);
    }
  });

  it("finds the project item by search and not the ticket that shares its prefix", async () => {
    const res = await send(probes.find((p) => p.route === "GET /api/pm/work-items")!);
    expect(res.body.work_items.map((w: { id: string }) => w.id)).toEqual([ids.pmItemId]);
  });

  it.each(probes.filter((p) => p.kind === "control").map((p) => [p.route, p] as const))(
    "%s still works — the exclusion is not a blanket 404",
    async (_route, probe) => {
      const res = await send(probe);
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
    },
  );

  it("still serves the project's own rows on the very routes a desk is refused on", async () => {
    const own: Array<[Method, string]> = [
      ["get", `/api/pm/projects/${ids.pmProjectId}`],
      ["get", `/api/pm/projects/${ids.pmProjectId}/states`],
      ["get", `/api/pm/projects/${ids.pmProjectId}/labels`],
      ["get", `/api/pm/projects/${ids.pmProjectId}/work-items`],
      ["get", `/api/pm/projects/${ids.pmProjectId}/timeline?from=2026-10-01&to=2026-10-31`],
      ["get", `/api/pm/work-items/${ids.pmItemId}`],
      ["get", `/api/pm/work-items/${ids.pmItemId}/comments`],
      ["get", `/api/pm/work-items/${ids.pmItemId}/activity`],
      ["get", `/api/pm/work-items/${ids.pmItemId}/relations`],
      [
        "get",
        `/api/mobile/pm/work-items/${ids.pmItemId}?workspace=${ids.workspaceSlug}&project_id=${ids.pmProjectId}`,
      ],
    ];
    for (const [method, url] of own) {
      const res = await request(server)[method](url);
      expect(res.status, `${method} ${url}`).toBe(200);
    }
  });

  it("never shows the escalation link, or the ticket's key, from the PM item's side", async () => {
    const list = await request(server).get(`/api/pm/work-items/${ids.pmItemId}/relations`);
    expect(list.body.relations).toEqual([]);
    const detail = await request(server).get(`/api/pm/work-items/${ids.pmItemId}`);
    expect(detail.body.relations).toEqual([]);
    expect(JSON.stringify(detail.body)).not.toContain("W28IZ");
    // The edge is still there for the support side to read.
    expect(await prisma.pmWorkItemRelation.count({ where: { id: ids.relationId } })).toBe(1);
  });

  it("keeps the edge when PM tries to remove it, and when the project item is deleted it is audited on the ticket", async () => {
    const del = await request(server).delete(`/api/pm/relations/${ids.relationId}`);
    expect(del.status).toBe(404);
    expect(await prisma.pmWorkItemRelation.count({ where: { id: ids.relationId } })).toBe(1);

    await request(server).delete(`/api/pm/work-items/${ids.pmItemId}`).expect(200);
    expect(await prisma.pmWorkItemRelation.count({ where: { id: ids.relationId } })).toBe(0);
    const audit = await prisma.pmActivity.findMany({
      where: { workItemId: ids.deskItemId, verb: "relation_removed" },
    });
    expect(audit).toHaveLength(1);
  });

  it("refuses a body that names a desk's parent, state or label, never attaching it", async () => {
    const parent = await request(server)
      .post(`/api/pm/projects/${ids.pmProjectId}/work-items`)
      .send({ name: "child", parent_id: ids.deskItemId });
    expect(parent.status).toBe(404);
    const state = await request(server)
      .post(`/api/pm/projects/${ids.pmProjectId}/work-items`)
      .send({ name: "child", state_id: ids.deskStateId });
    expect(state.status).toBe(404);
    const label = await request(server)
      .post(`/api/pm/projects/${ids.pmProjectId}/work-items`)
      .send({ name: "child", label_ids: [ids.deskLabelId] });
    expect(label.status).toBe(422);
    expect(label.body.error).toBe("invalid_label");
    const patchLabel = await request(server)
      .patch(`/api/pm/work-items/${ids.pmItemId}`)
      .send({ label_ids: [ids.deskLabelId] });
    expect(patchLabel.status).toBe(422);
    expect(await prisma.pmWorkItemLabel.count({ where: { labelId: ids.deskLabelId } })).toBe(1);
    expect(await prisma.pmWorkItem.count({ where: { projectId: ids.pmProjectId } })).toBe(1);
  });

  it("refuses to relate a project item to a ticket, in either direction", async () => {
    const other = await prisma.pmWorkItem.create({
      data: { projectId: ids.pmProjectId, sequenceId: 2, name: `${P}second` },
    });
    const ok = await request(server)
      .post(`/api/pm/work-items/${ids.pmItemId}/relations`)
      .send({ to_work_item_id: other.id, kind: "BLOCKS" });
    expect(ok.status).toBe(201);
    const toTicket = await request(server)
      .post(`/api/pm/work-items/${ids.pmItemId}/relations`)
      .send({ to_work_item_id: ids.deskItemId, kind: "BLOCKS" });
    expect(toTicket.status).toBe(404);
    const fromTicket = await request(server)
      .post(`/api/pm/work-items/${ids.deskItemId}/relations`)
      .send({ to_work_item_id: ids.pmItemId, kind: "BLOCKS" });
    expect(fromTicket.status).toBe(404);
  });

  // ── the other readers of PM rows ─────────────────────────────────────────

  describe("the other readers of PM rows", () => {
    it("a deal cannot be filed under a desk, and an activity cannot point at a ticket", async () => {
      const crm = await import("../services/crm/crm.service.js");
      await expect(
        crm.createDeal(prisma, { title: `${P}deal`, projectId: ids.deskId }, null),
      ).rejects.toThrow("project_not_found");
      const company = await prisma.crmCompany.create({ data: { name: `${P}Acme` } });
      try {
        await expect(
          crm.logActivity(
            prisma,
            {
              subjectType: "COMPANY",
              companyId: company.id,
              kind: "TASK",
              summary: "follow up",
              workItemId: ids.deskItemId,
            },
            null,
          ),
        ).rejects.toThrow("work_item_not_found");
        await expect(
          crm.logActivity(
            prisma,
            {
              subjectType: "COMPANY",
              companyId: company.id,
              kind: "TASK",
              summary: "follow up",
              workItemId: ids.pmItemId,
            },
            null,
          ),
        ).resolves.toBeTruthy();
      } finally {
        await prisma.crmCompany.delete({ where: { id: company.id } });
      }
    });

    it("a customer's record lists their projects and never a desk filed under them", async () => {
      const { getCustomerRecord } = await import("../services/crm/customer-record.service.js");
      const company = await prisma.crmCompany.create({ data: { name: `${P}Acme` } });
      try {
        await prisma.pmProject.updateMany({
          where: { id: { in: [ids.pmProjectId, ids.deskId] } },
          data: { companyId: company.id },
        });
        const record = await getCustomerRecord(prisma, company.id);
        expect(record.projects.map((p) => p.id)).toEqual([ids.pmProjectId]);
      } finally {
        await prisma.pmProject.updateMany({
          where: { id: { in: [ids.pmProjectId, ids.deskId] } },
          data: { companyId: null },
        });
        await prisma.crmCompany.delete({ where: { id: company.id } });
      }
    });

    it("a file cannot be linked to a desk or a ticket", async () => {
      const { linkFileToRecord } = await import("../services/crm/entity-link.service.js");
      const base = { ncFileId: 42, filePath: "/Contracts/nda.pdf", fileSpace: "company" };
      await expect(
        linkFileToRecord(prisma, { ...base, subjectType: "PROJECT", subjectId: ids.deskId }, null),
      ).rejects.toThrow("subject_not_found");
      await expect(
        linkFileToRecord(prisma, { ...base, subjectType: "WORK_ITEM", subjectId: ids.deskItemId }, null),
      ).rejects.toThrow("subject_not_found");
    });
  });
});
