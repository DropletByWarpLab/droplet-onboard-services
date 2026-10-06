/**
 * WARP-3519 (ADR-069 WS-2) — route wiring for /api/pm collaboration: comment
 * edit/delete, reactions, watchers and the merged timeline.
 *
 * The SERVICE is mocked (services/pm/pm-collaboration.service.ts has its own
 * suites); what is under test is everything the router owns:
 *   - the REAL role guard on every mutation (guest, service principal, no role
 *     -> 403 with the guard's own body) and NO guard on a read,
 *   - zod at the boundary -> 400 invalid_request, with the service never reached,
 *   - each service error code -> its documented status and `{ error: <code> }`,
 *   - the success statuses (201 only when something was created),
 *   - exactly what the router hands the service: the prisma client, the actor
 *     `{ id, role }`, the id from the path, and the coerced / alternative inputs
 *     (DELETE takes its emoji / user_id from the body OR the query string),
 *   - an unexpected error reaches the app's error handler, never a swallowed 200.
 *
 * Harness shape as relations.test.ts: a bare Express app, a stub auth middleware
 * that sets `req.user` per principal so the REAL requireRole runs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import type { NextFunction, Request, Response } from "express";
import { isRoleGuard } from "../../middleware/auth.js";
import { readPackageFile } from "../../__tests__/helpers/test-paths.js";
import { createPmCollaborationRouter } from "./collaboration.js";

const { svc, CONTRACT_ERRORS } = vi.hoisted(() => ({
  svc: {
    editComment: vi.fn(),
    deleteComment: vi.fn(),
    addReaction: vi.fn(),
    removeReaction: vi.fn(),
    listWatchers: vi.fn(),
    addWatcher: vi.fn(),
    removeWatcher: vi.fn(),
    getTimeline: vi.fn(),
  },
  /** The codes the contract names (the other two, comment_not_found and
   *  work_item_not_found, are pm.service.ts's PM_ERRORS and stay real). */
  CONTRACT_ERRORS: {
    COMMENT_FORBIDDEN: "comment_forbidden",
    COMMENT_DELETED: "comment_deleted",
    EMPTY_COMMENT: "empty_comment",
    INVALID_EMOJI: "invalid_emoji",
    WATCH_FORBIDDEN: "watch_forbidden",
    USER_CANNOT_READ: "user_cannot_read_item",
    INVALID_CURSOR: "invalid_cursor",
  },
}));

// A PARTIAL mock: every function is a vi.fn, every constant the router reads off
// the module (TIMELINE_MAX_LIMIT, …) stays real, and the error vocabulary is the
// contract's literal strings — so the router is proven against the spec's codes,
// and the last describe below proves the service really exports those strings.
vi.mock("../../services/pm/pm-collaboration.service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/pm/pm-collaboration.service.js")>();
  return {
    ...actual,
    ...svc,
    PM_COLLAB_ERRORS: CONTRACT_ERRORS,
  };
});

type Fn = keyof typeof svc;

/** Handed to the router; the service must receive exactly this object back. */
const PRISMA = { tag: "prisma-sentinel" } as never;

type Principal = { id: string; role?: string } | null;

const OWNER: Principal = { id: "user-owner", role: "owner" };
const ADMIN: Principal = { id: "user-admin", role: "admin" };
const FAMILY: Principal = { id: "user-family", role: "family" };
const GUEST: Principal = { id: "user-guest", role: "guest" };
const MCP: Principal = { id: "_service:mcp", role: "service" };
const OTHER_SERVICE: Principal = { id: "_service:voice", role: "service" };
const NO_ROLE: Principal = { id: "user-norole", role: undefined };

function makeApp(user: Principal) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user) {
      req.user = {
        id: user.id,
        username: user.id,
        displayName: user.id,
        role: user.role as never,
      };
    }
    next();
  });
  app.use("/api", createPmCollaborationRouter(PRISMA));
  // What an unexpected service error must reach (as in guest-company-data.test.ts).
  app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "handler_error" });
  });
  return app;
}

// ── fixtures ─────────────────────────────────────────────────────────────────

/** The allowlist, spelled with escapes: the heart is U+2764 U+FE0F. */
const HEART = "❤️";
const ALLOWED_EMOJI = [
  "\u{1F44D}",
  "\u{1F44E}",
  "\u{1F604}",
  "\u{1F389}",
  "\u{1F615}",
  HEART,
  "\u{1F680}",
  "\u{1F440}",
];
const THUMBS_UP = "\u{1F44D}";

const COMMENT = { id: "c-1", workItemId: "wi-1", commentHtml: "<p>hi</p>", reactions: [], mentions: [] };
const TOMBSTONE = { id: "c-1", workItemId: "wi-1", commentHtml: "", deleted: true, reactions: [], mentions: [] };
const WATCHERS = [{ userId: "user-family", reason: "MANUAL", createdAt: "2026-10-04T00:00:00.000Z" }];
const TIMELINE = {
  timeline: [{ type: "comment", id: "c-1", at: "2026-10-04T00:00:00.000Z", comment: COMMENT }],
  refs: { states: {}, labels: {}, workItems: {} },
  nextCursor: "next-page",
  total: 1,
};

interface Route {
  label: string;
  method: "get" | "post" | "patch" | "delete";
  url: string;
  body?: Record<string, unknown>;
  fn: Fn;
  /** What the mocked service resolves with on the happy path. */
  resolves: unknown;
  status: number;
  /** The body the router answers with (the service result, shaped). */
  responds: unknown;
  /** The service codes this route documents, and the status each one maps to. */
  errors: Array<[code: string, status: number]>;
}

const MUTATIONS: Route[] = [
  {
    label: "PATCH /pm/comments/:id",
    method: "patch",
    url: "/api/pm/comments/c-1",
    body: { comment_html: "<p>edited</p>" },
    fn: "editComment",
    resolves: COMMENT,
    status: 200,
    responds: { comment: COMMENT },
    errors: [
      ["comment_forbidden", 403],
      ["comment_not_found", 404],
      ["comment_deleted", 409],
      ["empty_comment", 422],
    ],
  },
  {
    label: "DELETE /pm/comments/:id",
    method: "delete",
    url: "/api/pm/comments/c-1",
    fn: "deleteComment",
    resolves: TOMBSTONE,
    status: 200,
    responds: { deleted: "c-1", comment: TOMBSTONE },
    errors: [
      ["comment_forbidden", 403],
      ["comment_not_found", 404],
    ],
  },
  {
    label: "POST /pm/comments/:id/reactions",
    method: "post",
    url: "/api/pm/comments/c-1/reactions",
    body: { emoji: THUMBS_UP },
    fn: "addReaction",
    resolves: { comment: COMMENT, created: true },
    status: 201,
    responds: { comment: COMMENT },
    errors: [
      ["comment_not_found", 404],
      ["comment_deleted", 409],
    ],
  },
  {
    label: "DELETE /pm/comments/:id/reactions",
    method: "delete",
    url: "/api/pm/comments/c-1/reactions",
    body: { emoji: THUMBS_UP },
    fn: "removeReaction",
    resolves: COMMENT,
    status: 200,
    responds: { comment: COMMENT },
    errors: [
      ["comment_not_found", 404],
      ["comment_deleted", 409],
    ],
  },
  {
    label: "POST /pm/work-items/:id/watchers",
    method: "post",
    url: "/api/pm/work-items/wi-1/watchers",
    body: {},
    fn: "addWatcher",
    resolves: { watchers: WATCHERS, created: true },
    status: 201,
    responds: { watchers: WATCHERS },
    errors: [
      ["watch_forbidden", 403],
      ["work_item_not_found", 404],
      ["user_cannot_read_item", 422],
    ],
  },
  {
    label: "DELETE /pm/work-items/:id/watchers",
    method: "delete",
    url: "/api/pm/work-items/wi-1/watchers",
    fn: "removeWatcher",
    resolves: { watchers: WATCHERS },
    status: 200,
    responds: { watchers: WATCHERS },
    errors: [
      ["watch_forbidden", 403],
      ["work_item_not_found", 404],
    ],
  },
];

const READS: Route[] = [
  {
    label: "GET /pm/work-items/:id/watchers",
    method: "get",
    url: "/api/pm/work-items/wi-1/watchers",
    fn: "listWatchers",
    resolves: WATCHERS,
    status: 200,
    responds: { watchers: WATCHERS },
    errors: [["work_item_not_found", 404]],
  },
  {
    label: "GET /pm/work-items/:id/timeline",
    method: "get",
    url: "/api/pm/work-items/wi-1/timeline",
    fn: "getTimeline",
    resolves: TIMELINE,
    status: 200,
    responds: TIMELINE,
    errors: [
      ["invalid_cursor", 400],
      ["work_item_not_found", 404],
    ],
  },
];

const ROUTES: Route[] = [...MUTATIONS, ...READS];

function send(app: ReturnType<typeof makeApp>, route: Route, url = route.url) {
  const req = request(app)[route.method](url);
  return route.body === undefined ? req : req.send(route.body);
}

/** The arguments of the nth call to a mocked service function. */
const argsOf = (fn: Fn, n = 0): unknown[] => svc[fn].mock.calls[n] as unknown[];

const expectInvalidRequest = (res: { status: number; body: { error?: string; details?: unknown } }) => {
  expect(res.status).toBe(400);
  expect(res.body.error).toBe("invalid_request");
  expect(typeof res.body.details).toBe("object");
  expect(res.body.details).not.toBeNull();
};

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset();
});

// ── the role guard ───────────────────────────────────────────────────────────

describe.each(MUTATIONS)("$label — role guard", (route) => {
  it.each([
    ["a guest", GUEST, "Forbidden: role not permitted"],
    ["the MCP service principal", MCP, "Forbidden: role not permitted"],
    ["another service principal", OTHER_SERVICE, "Forbidden: role not permitted"],
    ["a principal with no role", NO_ROLE, "Forbidden: no role on session"],
    ["no principal at all", null, "Forbidden: no role on session"],
  ])("refuses %s with the guard's own 403, and never reaches the service", async (_who, user, error) => {
    const res = await send(makeApp(user), route);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error });
    expect(svc[route.fn]).not.toHaveBeenCalled();
  });

  it.each([
    ["owner", OWNER],
    ["admin", ADMIN],
    ["family", FAMILY],
  ])("admits %s", async (_who, user) => {
    svc[route.fn].mockResolvedValue(route.resolves);
    const res = await send(makeApp(user), route);
    expect(res.status).toBe(route.status);
    expect(svc[route.fn]).toHaveBeenCalledTimes(1);
  });
});

describe("the guard runs before validation", () => {
  it("a guest's malformed body is a 403, not a 400 (no validation detail for a caller who may not write)", async () => {
    const patch = await request(makeApp(GUEST)).patch("/api/pm/comments/c-1").send({});
    expect(patch.status).toBe(403);
    const react = await request(makeApp(GUEST)).post("/api/pm/comments/c-1/reactions").send({ emoji: "💩" });
    expect(react.status).toBe(403);
    expect(svc.editComment).not.toHaveBeenCalled();
    expect(svc.addReaction).not.toHaveBeenCalled();
  });
});

describe.each(READS)("$label — no role guard", (route) => {
  // The projects module gate and its tier floor answer for the person; a
  // router-level role guard here would 403 the assistant's service principal on
  // a read it is meant to make.
  it.each([
    ["a family member", FAMILY],
    ["the MCP service principal", MCP],
    ["a principal the module gate let through", GUEST],
  ])("is served to %s", async (_who, user) => {
    svc[route.fn].mockResolvedValue(route.resolves);
    const res = await send(makeApp(user), route);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(route.responds);
  });
});

// ── success shapes and statuses ──────────────────────────────────────────────

describe.each(MUTATIONS)("$label — success", (route) => {
  it("answers with the documented status and exactly the documented body", async () => {
    svc[route.fn].mockResolvedValue(route.resolves);
    const res = await send(makeApp(FAMILY), route);
    expect(res.status).toBe(route.status);
    expect(res.body).toEqual(route.responds);
  });
});

describe("201 only when something was created", () => {
  it("a reaction that already existed is 200, a new one is 201 — the body is the comment either way", async () => {
    svc.addReaction.mockResolvedValue({ comment: COMMENT, created: false });
    const again = await request(makeApp(FAMILY))
      .post("/api/pm/comments/c-1/reactions")
      .send({ emoji: THUMBS_UP });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ comment: COMMENT });

    svc.addReaction.mockResolvedValue({ comment: COMMENT, created: true });
    const fresh = await request(makeApp(FAMILY))
      .post("/api/pm/comments/c-1/reactions")
      .send({ emoji: THUMBS_UP });
    expect(fresh.status).toBe(201);
    expect(fresh.body).toEqual({ comment: COMMENT });
  });

  it("a watcher that already existed is 200, a new one is 201 — the body is the list either way", async () => {
    svc.addWatcher.mockResolvedValue({ watchers: WATCHERS, created: false });
    const again = await request(makeApp(FAMILY)).post("/api/pm/work-items/wi-1/watchers").send({});
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ watchers: WATCHERS });

    svc.addWatcher.mockResolvedValue({ watchers: WATCHERS, created: true });
    const fresh = await request(makeApp(FAMILY)).post("/api/pm/work-items/wi-1/watchers").send({});
    expect(fresh.status).toBe(201);
    expect(fresh.body).toEqual({ watchers: WATCHERS });
  });
});

// ── what the service receives ────────────────────────────────────────────────

describe("what the router hands the service", () => {
  it.each([
    ["owner", OWNER],
    ["admin", ADMIN],
    ["family", FAMILY],
  ])("the actor is { id, role } of the signed-in %s, on every mutation", async (_who, user) => {
    for (const route of MUTATIONS) {
      svc[route.fn].mockReset();
      svc[route.fn].mockResolvedValue(route.resolves);
      const res = await send(makeApp(user), route);
      expect(res.status, route.label).toBe(route.status);
      expect(argsOf(route.fn)[0], `${route.label}: prisma`).toBe(PRISMA);
      expect(argsOf(route.fn)[1], `${route.label}: actor`).toEqual({ id: user!.id, role: user!.role });
    }
  });

  it("PATCH comment: the comment id comes from the path, comment_html goes through as the string it was", async () => {
    svc.editComment.mockResolvedValue(COMMENT);
    await request(makeApp(FAMILY)).patch("/api/pm/comments/c-9").send({ comment_html: "<p>x <b>y</b></p>" });
    const [, , commentId, html] = argsOf("editComment");
    expect(commentId).toBe("c-9");
    expect(html).toBe("<p>x <b>y</b></p>");
  });

  it("DELETE comment: the comment id comes from the path", async () => {
    svc.deleteComment.mockResolvedValue(TOMBSTONE);
    const res = await request(makeApp(FAMILY)).delete("/api/pm/comments/c-9");
    expect(argsOf("deleteComment")[2]).toBe("c-9");
    expect(res.body).toEqual({ deleted: "c-9", comment: TOMBSTONE });
  });

  it("POST reaction: the comment id comes from the path, the emoji is the one sent", async () => {
    svc.addReaction.mockResolvedValue({ comment: COMMENT, created: true });
    await request(makeApp(FAMILY)).post("/api/pm/comments/c-9/reactions").send({ emoji: "\u{1F680}" });
    const [, , commentId, emoji] = argsOf("addReaction");
    expect(commentId).toBe("c-9");
    expect(emoji).toBe("\u{1F680}");
  });

  it("GET watchers: the work item id comes from the path, and no actor is passed", async () => {
    svc.listWatchers.mockResolvedValue(WATCHERS);
    await request(makeApp(FAMILY)).get("/api/pm/work-items/wi-9/watchers");
    const args = argsOf("listWatchers");
    expect(args[0]).toBe(PRISMA);
    expect(args[1]).toBe("wi-9");
  });

  describe("POST watchers: user_id is the target, and absent means the caller", () => {
    it("passes user_id through as the target", async () => {
      svc.addWatcher.mockResolvedValue({ watchers: WATCHERS, created: true });
      await request(makeApp(ADMIN)).post("/api/pm/work-items/wi-9/watchers").send({ user_id: "user-someone" });
      const [, , workItemId, target] = argsOf("addWatcher");
      expect(workItemId).toBe("wi-9");
      expect(target).toBe("user-someone");
    });

    it("passes NO target for an empty JSON body (the service defaults to the actor)", async () => {
      svc.addWatcher.mockResolvedValue({ watchers: WATCHERS, created: true });
      const res = await request(makeApp(FAMILY)).post("/api/pm/work-items/wi-9/watchers").send({});
      expect(res.status).toBe(201);
      expect(argsOf("addWatcher")[3]).toBeUndefined();
    });

    it("passes NO target for a request with no body at all", async () => {
      svc.addWatcher.mockResolvedValue({ watchers: WATCHERS, created: true });
      const res = await request(makeApp(FAMILY)).post("/api/pm/work-items/wi-9/watchers");
      expect(res.status).toBe(201);
      expect(argsOf("addWatcher")[3]).toBeUndefined();
    });
  });

  describe("DELETE watchers: user_id comes from the body OR the query string", () => {
    it("from the JSON body", async () => {
      svc.removeWatcher.mockResolvedValue({ watchers: [] });
      await request(makeApp(ADMIN)).delete("/api/pm/work-items/wi-9/watchers").send({ user_id: "user-body" });
      const [, , workItemId, target] = argsOf("removeWatcher");
      expect(workItemId).toBe("wi-9");
      expect(target).toBe("user-body");
    });

    it("from ?user_id=", async () => {
      svc.removeWatcher.mockResolvedValue({ watchers: [] });
      const res = await request(makeApp(ADMIN)).delete("/api/pm/work-items/wi-9/watchers?user_id=user-query");
      expect(res.status).toBe(200);
      expect(argsOf("removeWatcher")[3]).toBe("user-query");
    });

    it("neither: no target (the service defaults to the actor)", async () => {
      svc.removeWatcher.mockResolvedValue({ watchers: [] });
      const res = await request(makeApp(FAMILY)).delete("/api/pm/work-items/wi-9/watchers");
      expect(res.status).toBe(200);
      expect(argsOf("removeWatcher")[3]).toBeUndefined();
    });
  });

  describe("DELETE reactions: the emoji comes from the body OR the percent-encoded query string", () => {
    it("from the JSON body", async () => {
      svc.removeReaction.mockResolvedValue(COMMENT);
      await request(makeApp(FAMILY)).delete("/api/pm/comments/c-9/reactions").send({ emoji: "\u{1F389}" });
      const [, , commentId, emoji] = argsOf("removeReaction");
      expect(commentId).toBe("c-9");
      expect(emoji).toBe("\u{1F389}");
    });

    it("from ?emoji=, decoded (a body on a DELETE is not something every client can send)", async () => {
      svc.removeReaction.mockResolvedValue(COMMENT);
      // U+1F680 ROCKET, percent-encoded as a browser's URLSearchParams writes it
      const res = await request(makeApp(FAMILY)).delete("/api/pm/comments/c-9/reactions?emoji=%F0%9F%9A%80");
      expect(res.status).toBe(200);
      expect(argsOf("removeReaction")[3]).toBe("\u{1F680}");
    });

    it("from ?emoji= for the heart, selector included (%E2%9D%A4%EF%B8%8F)", async () => {
      svc.removeReaction.mockResolvedValue(COMMENT);
      const res = await request(makeApp(FAMILY)).delete(
        "/api/pm/comments/c-9/reactions?emoji=%E2%9D%A4%EF%B8%8F",
      );
      expect(res.status).toBe(200);
      expect(argsOf("removeReaction")[3]).toBe(HEART);
    });

    it("with neither a body nor a query: 400, and the service is not reached", async () => {
      const res = await request(makeApp(FAMILY)).delete("/api/pm/comments/c-9/reactions");
      expectInvalidRequest(res);
      expect(svc.removeReaction).not.toHaveBeenCalled();
    });
  });

  describe("GET timeline: limit is a number, the cursor is passed through", () => {
    it("coerces ?limit= to a number and hands over ?cursor= unchanged", async () => {
      svc.getTimeline.mockResolvedValue(TIMELINE);
      const cursor = "eyJhdCI6IjIwMjYtMTAtMDRUMDA6MDA6MDAuMDAwWiIsImsiOiJjIiwiaWQiOiJjLTEifQ";
      const res = await request(makeApp(FAMILY)).get(`/api/pm/work-items/wi-9/timeline?limit=25&cursor=${cursor}`);
      expect(res.status).toBe(200);
      const [prisma, workItemId, opts] = argsOf("getTimeline") as [unknown, string, { limit?: unknown; cursor?: unknown }];
      expect(prisma).toBe(PRISMA);
      expect(workItemId).toBe("wi-9");
      expect(opts.limit).toBe(25); // a number, not "25"
      expect(opts.cursor).toBe(cursor);
    });

    it("no query: no cursor, and the limit is left to the service's default of 100", async () => {
      svc.getTimeline.mockResolvedValue(TIMELINE);
      const res = await request(makeApp(FAMILY)).get("/api/pm/work-items/wi-9/timeline");
      expect(res.status).toBe(200);
      const opts = (argsOf("getTimeline")[2] ?? {}) as { limit?: number; cursor?: string | null };
      expect(opts.cursor ?? null).toBeNull();
      expect(opts.limit ?? 100).toBe(100);
    });

    it.each([
      ["1", 1],
      ["100", 100],
      ["500", 500],
    ])("accepts limit=%s", async (raw, expected) => {
      svc.getTimeline.mockResolvedValue(TIMELINE);
      const res = await request(makeApp(FAMILY)).get(`/api/pm/work-items/wi-9/timeline?limit=${raw}`);
      expect(res.status).toBe(200);
      expect((argsOf("getTimeline")[2] as { limit?: number }).limit).toBe(expected);
    });
  });
});

// ── validation ───────────────────────────────────────────────────────────────

describe("validation: 400 invalid_request, and the service is never reached", () => {
  describe("PATCH /pm/comments/:id — comment_html is a string of 1..100000", () => {
    it.each([
      ["a missing comment_html", {}],
      ["an empty comment_html", { comment_html: "" }],
      ["a number", { comment_html: 5 }],
      ["null", { comment_html: null }],
      ["an array", { comment_html: ["<p>x</p>"] }],
      ["an oversized comment_html (100001 characters)", { comment_html: "a".repeat(100_001) }],
    ])("rejects %s", async (_label, body) => {
      const res = await request(makeApp(FAMILY)).patch("/api/pm/comments/c-1").send(body);
      expectInvalidRequest(res);
      expect(svc.editComment).not.toHaveBeenCalled();
    });

    it("rejects a request with no body at all", async () => {
      const res = await request(makeApp(FAMILY)).patch("/api/pm/comments/c-1");
      expectInvalidRequest(res);
      expect(svc.editComment).not.toHaveBeenCalled();
    });

    it.each([
      ["one character", "a"],
      ["exactly 100000 characters", "a".repeat(100_000)],
    ])("accepts %s", async (_label, html) => {
      svc.editComment.mockResolvedValue(COMMENT);
      const res = await request(makeApp(FAMILY)).patch("/api/pm/comments/c-1").send({ comment_html: html });
      expect(res.status).toBe(200);
      expect(argsOf("editComment")[3]).toBe(html);
    });
  });

  describe("reactions — the emoji must normalise into the allowlist", () => {
    const REJECTED: Array<[string, unknown]> = [
      ["a missing emoji", undefined],
      ["an empty emoji", ""],
      ["a whitespace-only emoji", "  "],
      ["an emoji outside the allowlist", "\u{1F4A9}"],
      ["a skin-tone variant (the list is closed, not a family)", "\u{1F44D}\u{1F3FD}"],
      ["two allowed emoji glued together", "\u{1F44D}\u{1F44D}"],
      ["text", "thumbsup"],
      ["a number", 5],
      ["null", null],
      ["an array holding an allowed emoji", [THUMBS_UP]],
      ["an object", { value: THUMBS_UP }],
    ];

    it.each(REJECTED)("POST rejects %s", async (_label, emoji) => {
      const body = emoji === undefined ? {} : { emoji };
      const res = await request(makeApp(FAMILY)).post("/api/pm/comments/c-1/reactions").send(body);
      expectInvalidRequest(res);
      expect(svc.addReaction).not.toHaveBeenCalled();
    });

    it.each(REJECTED)("DELETE (JSON body) rejects %s", async (_label, emoji) => {
      const body = emoji === undefined ? {} : { emoji };
      const res = await request(makeApp(FAMILY)).delete("/api/pm/comments/c-1/reactions").send(body);
      expectInvalidRequest(res);
      expect(svc.removeReaction).not.toHaveBeenCalled();
    });

    it("DELETE (query string) rejects an emoji outside the allowlist", async () => {
      const res = await request(makeApp(FAMILY)).delete("/api/pm/comments/c-1/reactions?emoji=%F0%9F%92%A9");
      expectInvalidRequest(res);
      expect(svc.removeReaction).not.toHaveBeenCalled();
    });

    it.each(ALLOWED_EMOJI.map((e) => [e]))("POST accepts %s, handing the service that emoji", async (emoji) => {
      svc.addReaction.mockResolvedValue({ comment: COMMENT, created: true });
      const res = await request(makeApp(FAMILY)).post("/api/pm/comments/c-1/reactions").send({ emoji });
      expect(res.status).toBe(201);
      expect(argsOf("addReaction")[3]).toBe(emoji);
    });

    it("POST accepts the heart WITHOUT its variation selector — several keyboards emit it bare", async () => {
      svc.addReaction.mockResolvedValue({ comment: COMMENT, created: true });
      const res = await request(makeApp(FAMILY)).post("/api/pm/comments/c-1/reactions").send({ emoji: "❤" });
      expect(res.status).toBe(201);
      // canonical or bare: the service normalises either (normalizePmReactionEmoji)
      expect([HEART, "❤"]).toContain(argsOf("addReaction")[3]);
    });

    it("POST accepts an allowed emoji with surrounding whitespace", async () => {
      svc.addReaction.mockResolvedValue({ comment: COMMENT, created: true });
      const res = await request(makeApp(FAMILY)).post("/api/pm/comments/c-1/reactions").send({ emoji: " \u{1F680} " });
      expect(res.status).toBe(201);
      expect((argsOf("addReaction")[3] as string).trim()).toBe("\u{1F680}");
    });
  });

  describe("watchers — user_id is a string of 1..64", () => {
    const REJECTED: Array<[string, unknown]> = [
      ["an empty user_id", ""],
      ["a 65-character user_id", "u".repeat(65)],
      ["a number", 5],
      ["an array", ["user-1"]],
    ];

    it.each(REJECTED)("POST rejects %s", async (_label, user_id) => {
      const res = await request(makeApp(ADMIN)).post("/api/pm/work-items/wi-1/watchers").send({ user_id });
      expectInvalidRequest(res);
      expect(svc.addWatcher).not.toHaveBeenCalled();
    });

    it.each(REJECTED)("DELETE (JSON body) rejects %s", async (_label, user_id) => {
      const res = await request(makeApp(ADMIN)).delete("/api/pm/work-items/wi-1/watchers").send({ user_id });
      expectInvalidRequest(res);
      expect(svc.removeWatcher).not.toHaveBeenCalled();
    });

    it("DELETE (query string) rejects an empty and a 65-character user_id", async () => {
      for (const query of ["user_id=", `user_id=${"u".repeat(65)}`]) {
        const res = await request(makeApp(ADMIN)).delete(`/api/pm/work-items/wi-1/watchers?${query}`);
        expectInvalidRequest(res);
      }
      expect(svc.removeWatcher).not.toHaveBeenCalled();
    });

    it("accepts a 64-character user_id on both routes", async () => {
      const user_id = "u".repeat(64);
      svc.addWatcher.mockResolvedValue({ watchers: WATCHERS, created: true });
      svc.removeWatcher.mockResolvedValue({ watchers: [] });
      expect((await request(makeApp(ADMIN)).post("/api/pm/work-items/wi-1/watchers").send({ user_id })).status).toBe(201);
      expect((await request(makeApp(ADMIN)).delete("/api/pm/work-items/wi-1/watchers").send({ user_id })).status).toBe(200);
      expect(argsOf("addWatcher")[3]).toBe(user_id);
      expect(argsOf("removeWatcher")[3]).toBe(user_id);
    });
  });

  describe("GET timeline — limit is 1..500, the cursor is bounded", () => {
    it.each([
      ["limit=0", "limit=0"],
      ["limit=501", "limit=501"],
      ["a negative limit", "limit=-1"],
      ["a non-numeric limit", "limit=abc"],
    ])("rejects %s", async (_label, query) => {
      const res = await request(makeApp(FAMILY)).get(`/api/pm/work-items/wi-1/timeline?${query}`);
      expectInvalidRequest(res);
      expect(svc.getTimeline).not.toHaveBeenCalled();
    });

    it("rejects an over-long cursor (5000 characters; a real one is a couple of hundred)", async () => {
      const res = await request(makeApp(FAMILY)).get(`/api/pm/work-items/wi-1/timeline?cursor=${"a".repeat(5000)}`);
      expectInvalidRequest(res);
      expect(svc.getTimeline).not.toHaveBeenCalled();
    });
  });
});

// ── service errors -> HTTP ───────────────────────────────────────────────────

describe.each(ROUTES)("$label — service errors", (route) => {
  it.each(route.errors)("maps %s to %i with body { error: <code> }", async (code, status) => {
    svc[route.fn].mockRejectedValue(new Error(code));
    const res = await send(makeApp(FAMILY), route);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ error: code });
  });
});

describe.each(ROUTES)("$label — an unexpected error", (route) => {
  it.each([
    ["a rejected promise", () => svc[route.fn].mockRejectedValue(new Error("boom"))],
    ["a code the router does not know", () => svc[route.fn].mockRejectedValue(new Error("some_future_code"))],
    [
      "a synchronous throw",
      () =>
        svc[route.fn].mockImplementation(() => {
          throw new Error("boom");
        }),
    ],
  ])("reaches the error handler (500) on %s — never a swallowed 200", async (_label, arrange) => {
    arrange();
    const res = await send(makeApp(FAMILY), route);
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "handler_error" });
  });
});

// ── the vocabulary the router maps ───────────────────────────────────────────

describe("the service's error vocabulary", () => {
  it("is the contract's strings — the router maps these exact codes, and the service throws them", async () => {
    const actual = await vi.importActual<typeof import("../../services/pm/pm-collaboration.service.js")>(
      "../../services/pm/pm-collaboration.service.js",
    );
    expect(actual.PM_COLLAB_ERRORS).toMatchObject(CONTRACT_ERRORS);
  });
});

// ── the router, as registered ────────────────────────────────────────────────

type Handle = unknown;
interface Layer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Handle }> };
}

const REGISTERED = (() => {
  const stack = (createPmCollaborationRouter(PRISMA) as unknown as { stack: Layer[] }).stack;
  return stack.flatMap((layer) =>
    layer.route
      ? Object.keys(layer.route.methods)
          .filter((m) => layer.route!.methods[m])
          .map((m) => ({
            key: `${m.toUpperCase()} ${layer.route!.path}`,
            method: m.toUpperCase(),
            handles: layer.route!.stack.map((s) => s.handle),
          }))
      : [],
  );
})();

describe("the router, as registered", () => {
  it("registers exactly the eight documented routes — a new one must be added to the tables above", () => {
    expect(REGISTERED.map((r) => r.key).sort()).toEqual(
      [
        "DELETE /pm/comments/:id",
        "DELETE /pm/comments/:id/reactions",
        "DELETE /pm/work-items/:id/watchers",
        "GET /pm/work-items/:id/timeline",
        "GET /pm/work-items/:id/watchers",
        "PATCH /pm/comments/:id",
        "POST /pm/comments/:id/reactions",
        "POST /pm/work-items/:id/watchers",
      ].sort(),
    );
  });

  it("EVERY non-GET route carries a role guard, ahead of its handler", () => {
    const writes = REGISTERED.filter((r) => r.method !== "GET");
    expect(writes).toHaveLength(MUTATIONS.length);
    for (const route of writes) {
      const guard = route.handles.findIndex(isRoleGuard);
      expect(guard, `${route.key} must carry a role guard`).toBeGreaterThanOrEqual(0);
      expect(guard, `${route.key}: the guard must come before the handler`).toBeLessThan(route.handles.length - 1);
    }
  });

  it("registers every route in the literal `router.<method>(\"/path\"` form the guest-surface scans read", () => {
    // guest-company-data.test.ts (and guest-work-item-share.test.ts) find a
    // router's routes by scanning its SOURCE with this exact regex. A route
    // spelled any other way is invisible to them: the guest-refusal proof would
    // quietly stop covering it, with the list still long enough to pass.
    const source = readPackageFile("src", "routes", "pm", "collaboration.ts");
    const scanned = [...source.matchAll(/router\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map(
      (m) => `${m[1].toUpperCase()} ${m[2]}`,
    );
    expect(scanned.sort()).toEqual(REGISTERED.map((r) => r.key).sort());
  });
});
