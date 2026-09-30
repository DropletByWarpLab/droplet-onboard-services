/**
 * WARP-3354 — a routine is PRIVATE to its creator unless it is shared with the
 * Workspace; owners and admins see every routine.
 *
 * Until this, `GET /api/tools` listed every routine to every member and
 * `GET /api/tools/:slug` returned any routine with its steps and their
 * arguments (file paths, recipients, prompts, code) to the same three roles.
 * These pins are per route and per person:
 *
 *   - list / get: a member sees the Workspace's routines and their own, never
 *     another member's private one; owner and admin see all; the refusal is a
 *     404 that reads exactly like an unknown slug;
 *   - run / run history / schedules: same visibility, so a private routine
 *     cannot be run, read back or scheduled-peeked by someone who cannot see it;
 *   - share / un-share: its creator, an owner or an admin — nobody else, and
 *     never the assistant;
 *   - the assistant (`_service:mcp` acting for a person) is held to the
 *     visibility of THAT person, not of a robot;
 *   - the migration's backfill: live routines and suggestions stay shared,
 *     drafts become private, and the column has no default.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));
const { recordActivityMock } = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));

import { createToolsRouter } from "../routes/tools.js";
import type { StepDispatcher } from "../services/tool-spec-runner.service.js";
import { DAILY_REPORT_SLUG } from "../services/daily-report-spec.service.js";
import type { AuthUser } from "../middleware/auth.js";
import { userDirectory, type DirectoryUser } from "./helpers/user-directory.js";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const mcp: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" };
const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "romain", role: "owner" };
const admin: AuthUser = { id: "u-admin", username: "stefan", displayName: "stefan", role: "admin" };
const alice: AuthUser = { id: "u-alice", username: "alice", displayName: "alice", role: "family" };
const bob: AuthUser = { id: "u-bob", username: "bob", displayName: "bob", role: "family" };
const guest: AuthUser = { id: "u-guest", username: "visitor", displayName: "visitor", role: "guest" };
const DIRECTORY: DirectoryUser[] = [owner, admin, alice, bob, guest].map((u) => ({
  id: u.id,
  username: u.username,
  nextcloudUsername: null,
  role: u.role,
}));

type Visibility = "PRIVATE" | "WORKSPACE";
interface StepRow {
  id: string;
  specId: string;
  idx: number;
  kind: string;
  args: unknown;
}
interface SpecRow {
  id: string;
  slug: string;
  name: string;
  category: string | null;
  description: string | null;
  version: number;
  status: "live" | "draft" | "suggested";
  ownerId: string | null;
  share: string | null;
  visibility: Visibility;
  safety: number;
  writes: boolean;
  reversible: boolean;
  createdAt: Date;
  updatedAt: Date;
  steps: StepRow[];
}

function spec(
  slug: string,
  over: Partial<Pick<SpecRow, "status" | "ownerId" | "visibility">>,
): SpecRow {
  const id = `spec-${slug}`;
  return {
    id,
    slug,
    name: slug,
    category: null,
    description: null,
    version: 1,
    status: "live",
    ownerId: null,
    share: null,
    visibility: "PRIVATE",
    safety: 1,
    writes: false,
    reversible: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    steps: [{ id: `${id}-s0`, specId: id, idx: 0, kind: "call", args: { tool: "list_files", args: { path: `/secret/${slug}` } } }],
    ...over,
  };
}

/** One of every kind of routine a box can hold. */
function fixtures(): SpecRow[] {
  return [
    spec("alice-draft", { status: "draft", ownerId: alice.id, visibility: "PRIVATE" }),
    spec("alice-live", { status: "live", ownerId: alice.id, visibility: "PRIVATE" }),
    spec("bob-live", { status: "live", ownerId: bob.id, visibility: "PRIVATE" }),
    spec("shared", { status: "live", ownerId: bob.id, visibility: "WORKSPACE" }),
    spec("mined", { status: "suggested", ownerId: null, visibility: "WORKSPACE" }),
    spec("orphan-draft", { status: "draft", ownerId: null, visibility: "PRIVATE" }),
    spec(DAILY_REPORT_SLUG, { status: "live", ownerId: null, visibility: "WORKSPACE" }),
  ];
}

type Where = {
  status?: string;
  category?: string;
  OR?: Array<{ visibility?: Visibility; ownerId?: string }>;
};

/** Prisma's `where` semantics for exactly the keys the routes send. */
function matches(r: SpecRow, where: Where = {}): boolean {
  if (where.status && r.status !== where.status) return false;
  if (where.category && r.category !== where.category) return false;
  if (where.OR && !where.OR.some((c) => (c.visibility ? r.visibility === c.visibility : r.ownerId === c.ownerId))) {
    return false;
  }
  return true;
}

function createPrismaMock(seed: SpecRow[] = fixtures()) {
  const specs = new Map(seed.map((s) => [s.slug, s]));
  const runs: Array<{ specId: string; triggeredBy: string | null; status: string }> = [];
  let n = 1;
  const tables = {
    specs,
    runs,
    user: {
      findFirst: vi.fn(async ({ where }: { where: { username: string } }) => {
        const u = DIRECTORY.find((x) => x.username === where.username);
        return u ? { id: u.id, username: u.username, role: u.role } : null;
      }),
      findMany: userDirectory(DIRECTORY).findMany,
      findUnique: vi.fn(async () => ({ accessRoleId: null, accessRole: null })),
    },
    toolSpec: {
      findMany: vi.fn(async ({ where }: { where?: Where } = {}) =>
        [...specs.values()]
          .filter((r) => matches(r, where))
          .map((r) => ({ ...r, _count: { steps: r.steps.length, runs: 0 }, schedules: [] })),
      ),
      findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        if (where.slug) return specs.get(where.slug) ?? null;
        return [...specs.values()].find((r) => r.id === where.id) ?? null;
      }),
      create: vi.fn(
        async ({ data }: { data: Record<string, unknown> & { steps: { create: Array<Omit<StepRow, "id" | "specId">> } } }) => {
          const id = `spec-new-${n++}`;
          const row: SpecRow = {
            id,
            slug: data.slug as string,
            name: data.name as string,
            category: (data.category as string | null) ?? null,
            description: (data.description as string | null) ?? null,
            version: 1,
            status: data.status as SpecRow["status"],
            ownerId: (data.ownerId as string | null) ?? null,
            share: null,
            visibility: data.visibility as Visibility,
            safety: 1,
            writes: data.writes as boolean,
            reversible: true,
            createdAt: new Date(),
            updatedAt: new Date(),
            steps: data.steps.create.map((s, i) => ({ id: `${id}-s${i}`, specId: id, ...s })),
          };
          specs.set(row.slug, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { slug?: string; id?: string }; data: Record<string, unknown> }) => {
          const row = where.slug ? specs.get(where.slug) : [...specs.values()].find((r) => r.id === where.id);
          if (!row) throw new Error("not found");
          if (data.visibility !== undefined) row.visibility = data.visibility as Visibility;
          if (typeof data.name === "string") row.name = data.name;
          if (data.status) row.status = data.status as SpecRow["status"];
          return row;
        },
      ),
    },
    toolStep: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    toolSchedule: { findMany: vi.fn(async () => []) },
    toolRun: {
      create: vi.fn(async ({ data }: { data: { specId: string; triggeredBy: string | null; status: string } }) => {
        runs.push({ specId: data.specId, triggeredBy: data.triggeredBy, status: data.status });
        return { id: `run-${n++}`, ...data, startedAt: new Date(), trace: [] };
      }),
      findMany: vi.fn(async ({ where }: { where: { specId: string; triggeredBy?: { in: string[] } } }) =>
        runs
          .filter((r) => r.specId === where.specId && (!where.triggeredBy || where.triggeredBy.in.includes(r.triggeredBy ?? "")))
          .map((r, i) => ({ id: `r${i}`, ...r, startedAt: new Date(), endedAt: new Date(), error: null, trace: [] })),
      ),
    },
  };
  return Object.assign(tables, {
    $transaction: vi.fn(async (fn: (tx: typeof tables) => unknown) => fn(tables)),
  });
}

function makeDispatcher(): StepDispatcher {
  return { call: vi.fn().mockResolvedValue({ ok: true }) };
}

function buildApp(prisma: ReturnType<typeof createPrismaMock>, user: AuthUser, dispatcher = makeDispatcher()) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createToolsRouter(prisma as never, dispatcher));
  return app;
}

const slugs = (body: { specs: Array<{ slug: string }> }) => body.specs.map((s) => s.slug).sort();

beforeEach(() => {
  vi.clearAllMocks();
});

// ── list ─────────────────────────────────────────────────────────
describe("GET /api/tools — a member lists the Workspace's routines and their own", () => {
  it("alice sees shared, suggested and her own, never bob's private routine", async () => {
    const res = await request(buildApp(createPrismaMock(), alice)).get("/api/tools");
    expect(res.status).toBe(200);
    expect(slugs(res.body)).toEqual(["alice-draft", "alice-live", DAILY_REPORT_SLUG, "mined", "shared"].sort());
  });

  it("bob sees his own and the shared ones, never alice's drafts", async () => {
    const res = await request(buildApp(createPrismaMock(), bob)).get("/api/tools");
    expect(slugs(res.body)).toEqual(["bob-live", DAILY_REPORT_SLUG, "mined", "shared"].sort());
  });

  it("owner and admin see every routine, private and creator-less included", async () => {
    for (const who of [owner, admin]) {
      const prisma = createPrismaMock();
      const res = await request(buildApp(prisma, who)).get("/api/tools");
      expect(slugs(res.body), who.role).toEqual(fixtures().map((f) => f.slug).sort());
      // Not filtered at all — no visibility clause reaches the query.
      expect(prisma.toolSpec.findMany.mock.calls[0]![0]!.where).not.toHaveProperty("OR");
    }
  });

  it("filters in the QUERY, and composes with the status filter", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, alice)).get("/api/tools?status=live");
    expect(slugs(res.body)).toEqual(["alice-live", DAILY_REPORT_SLUG, "shared"].sort());
    expect(prisma.toolSpec.findMany.mock.calls[0]![0]!.where).toEqual({
      status: "live",
      OR: [{ visibility: "WORKSPACE" }, { ownerId: "u-alice" }],
    });
  });

  it("answers visibility and a per-viewer canShare on every row", async () => {
    const asAlice = await request(buildApp(createPrismaMock(), alice)).get("/api/tools");
    const row = (slug: string) => asAlice.body.specs.find((s: { slug: string }) => s.slug === slug);
    expect(row("alice-draft")).toMatchObject({ visibility: "PRIVATE", canShare: true });
    expect(row("shared")).toMatchObject({ visibility: "WORKSPACE", canShare: false });
    expect(row("mined")).toMatchObject({ visibility: "WORKSPACE", canShare: false });

    const asOwner = await request(buildApp(createPrismaMock(), owner)).get("/api/tools");
    expect(asOwner.body.specs.every((s: { canShare: boolean }) => s.canShare)).toBe(true);
  });

  it("an external guest lists nothing — 403 before the query", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, guest)).get("/api/tools");
    expect(res.status).toBe(403);
    expect(prisma.toolSpec.findMany).not.toHaveBeenCalled();
  });
});

// ── get ──────────────────────────────────────────────────────────
describe("GET /api/tools/:slug — steps and their arguments are the author's data", () => {
  it("the creator reads their private routine, steps included", async () => {
    const res = await request(buildApp(createPrismaMock(), alice)).get("/api/tools/alice-draft");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: "alice-draft", visibility: "PRIVATE", canShare: true });
    expect(res.body.steps[0].args.args.path).toBe("/secret/alice-draft");
  });

  it("another member gets a 404 that reads exactly like an unknown slug — no steps, no arguments", async () => {
    const app = buildApp(createPrismaMock(), bob);
    const hidden = await request(app).get("/api/tools/alice-draft");
    const missing = await request(app).get("/api/tools/never-existed");
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual(missing.body);
    expect(JSON.stringify(hidden.body)).not.toContain("secret");
  });

  it("a shared routine is readable by every member, but only its creator may share it", async () => {
    const res = await request(buildApp(createPrismaMock(), alice)).get("/api/tools/shared");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ visibility: "WORKSPACE", canShare: false });
  });

  it("a creator-less private routine is owner/admin only", async () => {
    expect((await request(buildApp(createPrismaMock(), alice)).get("/api/tools/orphan-draft")).status).toBe(404);
    expect((await request(buildApp(createPrismaMock(), admin)).get("/api/tools/orphan-draft")).status).toBe(200);
  });

  it("owner and admin read any private routine", async () => {
    for (const who of [owner, admin]) {
      const res = await request(buildApp(createPrismaMock(), who)).get("/api/tools/bob-live");
      expect(res.status, who.role).toBe(200);
    }
  });
});

// ── run, history, schedules ──────────────────────────────────────
describe("run, run history and schedules follow the routine's visibility", () => {
  it("another member cannot run a private routine: 404, nothing dispatched, no run row", async () => {
    const prisma = createPrismaMock();
    const dispatcher = makeDispatcher();
    const res = await request(buildApp(prisma, alice, dispatcher)).post("/api/tools/bob-live/runs").send({});
    expect(res.status).toBe(404);
    expect(dispatcher.call).not.toHaveBeenCalled();
    expect(prisma.toolRun.create).not.toHaveBeenCalled();
  });

  it("the creator runs their own private routine, as themselves", async () => {
    const prisma = createPrismaMock();
    const dispatcher = makeDispatcher();
    const res = await request(buildApp(prisma, alice, dispatcher)).post("/api/tools/alice-live/runs").send({});
    expect(res.status).toBe(200);
    expect(dispatcher.call).toHaveBeenCalledTimes(1);
    expect(prisma.runs[0]).toMatchObject({ triggeredBy: "alice" });
  });

  it("a shared routine runs for any member under today's run rules", async () => {
    const dispatcher = makeDispatcher();
    const res = await request(buildApp(createPrismaMock(), alice, dispatcher)).post("/api/tools/shared/runs").send({});
    expect(res.status).toBe(200);
    expect(dispatcher.call).toHaveBeenCalledTimes(1);
    // Today's rule, unchanged: a draft still cannot run, private or not.
    const draft = await request(buildApp(createPrismaMock(), alice, dispatcher)).post("/api/tools/alice-draft/runs").send({});
    expect(draft.status).toBe(400);
  });

  it("owner and admin run any routine", async () => {
    for (const who of [owner, admin]) {
      const dispatcher = makeDispatcher();
      const res = await request(buildApp(createPrismaMock(), who, dispatcher)).post("/api/tools/bob-live/runs").send({});
      expect(res.status, who.role).toBe(200);
      expect(dispatcher.call).toHaveBeenCalledTimes(1);
    }
  });

  it("run history and schedules of a private routine are 404 to another member, open to its creator", async () => {
    for (const suffix of ["runs", "schedules"]) {
      const other = await request(buildApp(createPrismaMock(), alice)).get(`/api/tools/bob-live/${suffix}`);
      expect(other.status, suffix).toBe(404);
      const own = await request(buildApp(createPrismaMock(), bob)).get(`/api/tools/bob-live/${suffix}`);
      expect(own.status, suffix).toBe(200);
      const adm = await request(buildApp(createPrismaMock(), admin)).get(`/api/tools/bob-live/${suffix}`);
      expect(adm.status, suffix).toBe(200);
    }
  });

  it("a shared routine's schedules are readable by every member", async () => {
    expect((await request(buildApp(createPrismaMock(), alice)).get("/api/tools/shared/schedules")).status).toBe(200);
  });
});

// ── create + edit ────────────────────────────────────────────────
describe("a new routine is born private to its creator", () => {
  const body = { slug: "my-weekly", name: "My weekly", steps: [{ tool: "list_files", args: {} }] };

  it("POST /api/tools creates it PRIVATE and owned by the caller; the body cannot say otherwise", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, alice))
      .post("/api/tools")
      .send({ ...body, visibility: "WORKSPACE", ownerId: bob.id });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ visibility: "PRIVATE", ownerId: "u-alice", status: "draft", canShare: true });
    // ...and bob, another member, cannot see it.
    const asBob = await request(buildApp(prisma, bob)).get("/api/tools");
    expect(slugs(asBob.body)).not.toContain("my-weekly");
  });

  it("PATCH cannot change visibility — sharing moves only through the share routes", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, admin))
      .patch("/api/tools/alice-draft")
      .send({ name: "Renamed", visibility: "WORKSPACE" });
    expect(res.status).toBe(200);
    expect(res.body.visibility).toBe("PRIVATE");
    expect(prisma.toolSpec.update.mock.calls[0]![0]!.data).not.toHaveProperty("visibility");
  });

  it("a member cannot edit a routine at all, their own included (unchanged)", async () => {
    const res = await request(buildApp(createPrismaMock(), alice)).patch("/api/tools/alice-draft").send({ name: "x" });
    expect(res.status).toBe(403);
  });
});

// ── share / un-share ─────────────────────────────────────────────
describe("POST / DELETE /api/tools/:slug/share", () => {
  it("the creator shares their private routine; it is then visible to another member", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, alice)).post("/api/tools/alice-live/share");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ slug: "alice-live", visibility: "WORKSPACE", canShare: true });
    expect((await request(buildApp(prisma, bob)).get("/api/tools/alice-live")).status).toBe(200);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool_run",
        actor: { type: "user", id: "u-alice" },
        refs: expect.objectContaining({ slug: "alice-live", from: "PRIVATE", to: "WORKSPACE" }),
      }),
    );
  });

  it("the creator makes it private again, and it disappears for other members", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, bob)).delete("/api/tools/shared/share");
    expect(res.status).toBe(200);
    expect(res.body.visibility).toBe("PRIVATE");
    expect((await request(buildApp(prisma, alice)).get("/api/tools/shared")).status).toBe(404);
  });

  it("is idempotent — repeating it changes nothing and records nothing", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, bob)).post("/api/tools/shared/share");
    expect(res.status).toBe(200);
    expect(res.body.visibility).toBe("WORKSPACE");
    expect(prisma.toolSpec.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("another member cannot share a private routine they cannot see — 404, row untouched", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, alice)).post("/api/tools/bob-live/share");
    expect(res.status).toBe(404);
    expect(prisma.specs.get("bob-live")!.visibility).toBe("PRIVATE");
    expect(prisma.toolSpec.update).not.toHaveBeenCalled();
  });

  it("another member cannot pull a shared routine back — they can see it, so 403 not 404", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, alice)).delete("/api/tools/shared/share");
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden_not_creator");
    expect(prisma.specs.get("shared")!.visibility).toBe("WORKSPACE");
  });

  it("owner and admin share and un-share any routine, another member's included", async () => {
    for (const who of [owner, admin]) {
      const prisma = createPrismaMock();
      const up = await request(buildApp(prisma, who)).post("/api/tools/bob-live/share");
      expect(up.status, who.role).toBe(200);
      expect(prisma.specs.get("bob-live")!.visibility).toBe("WORKSPACE");
      const down = await request(buildApp(prisma, who)).delete("/api/tools/bob-live/share");
      expect(down.status, who.role).toBe(200);
      expect(prisma.specs.get("bob-live")!.visibility).toBe("PRIVATE");
    }
  });

  it("a routine with no creator (a suggestion) is for owner and admin to share or un-share, not a member", async () => {
    expect((await request(buildApp(createPrismaMock(), alice)).delete("/api/tools/mined/share")).status).toBe(403);
    expect((await request(buildApp(createPrismaMock(), admin)).delete("/api/tools/mined/share")).status).toBe(200);
  });

  it("the box's daily report cannot be made private — members' Reports tile runs it", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, owner)).delete(`/api/tools/${DAILY_REPORT_SLUG}/share`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("box_routine_stays_shared");
    expect(prisma.specs.get(DAILY_REPORT_SLUG)!.visibility).toBe("WORKSPACE");
  });

  it("an external guest is refused before any lookup", async () => {
    const prisma = createPrismaMock();
    expect((await request(buildApp(prisma, guest)).post("/api/tools/shared/share")).status).toBe(403);
    expect(prisma.toolSpec.findUnique).not.toHaveBeenCalled();
  });

  it("the assistant cannot share a routine on anyone's behalf — the mcp principal is not admitted", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mcp)).post("/api/tools/alice-live/share").set("X-Nextcloud-User", "alice");
    expect(res.status).toBe(403);
    expect(prisma.specs.get("alice-live")!.visibility).toBe("PRIVATE");
  });
});

// ── the assistant (routine_list / routine_run / routine_draft) ───
describe("the assistant sees what the person it acts for sees", () => {
  it("routine_list for alice omits bob's private routine; for the owner it lists everything", async () => {
    const asAlice = await request(buildApp(createPrismaMock(), mcp)).get("/api/tools").set("X-Nextcloud-User", "alice");
    expect(asAlice.status).toBe(200);
    expect(slugs(asAlice.body)).toEqual(["alice-draft", "alice-live", DAILY_REPORT_SLUG, "mined", "shared"].sort());

    const asOwner = await request(buildApp(createPrismaMock(), mcp)).get("/api/tools").set("X-Nextcloud-User", "romain");
    expect(slugs(asOwner.body)).toEqual(fixtures().map((f) => f.slug).sort());
  });

  it("routine_run for alice cannot reach bob's private routine — 404 and nothing dispatched", async () => {
    const prisma = createPrismaMock();
    const dispatcher = makeDispatcher();
    const res = await request(buildApp(prisma, mcp, dispatcher))
      .post("/api/tools/bob-live/runs")
      .set("X-Nextcloud-User", "alice")
      .send({});
    expect(res.status).toBe(404);
    expect(dispatcher.call).not.toHaveBeenCalled();
    expect(prisma.toolRun.create).not.toHaveBeenCalled();
  });

  it("routine_run for alice runs alice's own private routine, recorded as alice", async () => {
    const prisma = createPrismaMock();
    const dispatcher = makeDispatcher();
    const res = await request(buildApp(prisma, mcp, dispatcher))
      .post("/api/tools/alice-live/runs")
      .set("X-Nextcloud-User", "alice")
      .send({});
    expect(res.status).toBe(200);
    expect(prisma.runs[0]).toMatchObject({ triggeredBy: "alice" });
  });

  it("routine_draft for alice writes a PRIVATE draft owned by alice", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma, mcp))
      .post("/api/tools")
      .set("X-Nextcloud-User", "alice")
      .send({ slug: "assistant-made", name: "Assistant made", steps: [{ tool: "list_files", args: {} }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ visibility: "PRIVATE", ownerId: "u-alice" });
    expect(slugs((await request(buildApp(prisma, bob)).get("/api/tools")).body)).not.toContain("assistant-made");
  });
});

// ── the migration's backfill ─────────────────────────────────────
describe("the migration (backfill) and the column", () => {
  const sql = readFileSync(join(PRISMA_DIR, "migrations", "20260930120000_warp_3354_routine_visibility", "migration.sql"), "utf8");
  const schema = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8");
  const statements = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  it("adds the enum, then the column NOT NULL, then backfills, then drops the default — in that order", () => {
    expect(statements).toEqual([
      `CREATE TYPE "ToolSpecVisibility" AS ENUM ('PRIVATE', 'WORKSPACE')`,
      `ALTER TABLE "ToolSpec" ADD COLUMN "visibility" "ToolSpecVisibility" NOT NULL DEFAULT 'WORKSPACE'`,
      `UPDATE "ToolSpec" SET "visibility" = 'PRIVATE' WHERE "status" = 'draft'`,
      `ALTER TABLE "ToolSpec" ALTER COLUMN "visibility" DROP DEFAULT`,
    ]);
  });

  it("backfills live routines and suggestions to WORKSPACE (nothing vanishes on upgrade) and drafts to PRIVATE", () => {
    // Existing rows take the ADD COLUMN default, WORKSPACE; the one UPDATE
    // narrows exactly the drafts. A live or suggested row is never touched.
    const updates = statements.filter((s) => s.startsWith("UPDATE"));
    expect(updates).toHaveLength(1);
    expect(updates[0]).toContain(`WHERE "status" = 'draft'`);
    expect(updates[0]).not.toMatch(/live|suggested/);
  });

  it("the Prisma column is an explicit enum with no default — every creator must say which", () => {
    expect(schema).toMatch(/enum ToolSpecVisibility \{\s*PRIVATE\s*WORKSPACE\s*\}/);
    const model = schema.match(/model ToolSpec \{[\s\S]*?\n\}/)![0];
    const line = model.split("\n").find((l) => /^\s+visibility\s/.test(l))!;
    expect(line).toMatch(/visibility\s+ToolSpecVisibility\s*$/);
    expect(line).not.toContain("@default");
  });
});
