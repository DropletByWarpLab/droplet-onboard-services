/**
 * WARP-2896 (ADR-056 §6.2) — `/api/workspace/*` and `/api/git/*`.
 *
 *   - "run owns workspace": a workshop run's call (mcp principal +
 *     X-Droplet-Agent-Run) is served only when the run belongs to the acting
 *     person, is `running`, and is bound to THIS workspace — a run bound to
 *     another workspace is 403, a parked or finished run 409, the mcp
 *     principal with no run header 403 on every op;
 *   - the `run` allow-list is applied BEFORE the sandbox is dialled;
 *   - a person on the dashboard reads log/diff/output, creates and deletes;
 *     the write ops are a run's alone (403 for a person without a run);
 *   - create rolls the sandbox back when the row cannot be written, and
 *     delete refuses while a run is active;
 *   - propose flips the row to `proposed` with the tag;
 *   - git: the mcp principal is 403, family and guest fetch (push flag off),
 *     owner pushes (push flag on), an unknown repo 404;
 *   - WARP-2899: export is a git bundle for an owner/admin PERSON only (the
 *     mcp principal, a run, family and guest are 403), with one audit row
 *     carrying the bundle's sha256; a connector draft's readback rides the
 *     detail response and the propose activity.
 *
 * The sandbox is a recording fake: the routes are the unit, the container
 * has its own suite (services/sandbox/tests/test_workspaces.py).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { createHash } from "node:crypto";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    SANDBOX_URL: "http://sandbox:8030",
    SANDBOX_SERVICE_TOKEN: "t",
    agentRuns: { maxIter: 12 },
  },
}));
const { recordActivityMock } = vi.hoisted(() => ({ recordActivityMock: vi.fn().mockResolvedValue(null) }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));
vi.mock("../services/notifications.service.js", () => ({
  sendNotification: vi.fn().mockResolvedValue({ id: "n", channels: [], delivered: false }),
}));

import { createWorkspaceRouter, AGENT_RUN_HEADER } from "../routes/workspace.js";
import { refuseRunArgv, WorkspaceSandboxError, type WorkspaceSandboxClient } from "../services/workspace.service.js";
import type { ConnectorDraftFacts } from "../services/connector-draft.js";
import { createAgentRunPrismaMock } from "./helpers/agent-run-prisma-mock.js";
import type { AuthUser } from "../middleware/auth.js";

const mcp: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP Server", role: "service" };
const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "Romain", role: "owner" };
const admin: AuthUser = { id: "u-admin", username: "stefan", displayName: "Stefan", role: "admin" };
const family: AuthUser = { id: "u-family", username: "kid", displayName: "Kid", role: "family" };
const guest: AuthUser = { id: "u-guest", username: "guest", displayName: "Guest", role: "guest" };

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BUNDLE = Buffer.from("# v2 git bundle\n0123 PACK bytes");
const ACME: ConnectorDraftFacts = {
  provider: "acme",
  displayName: "Acme",
  host: { kind: "static", hosts: ["api.acme.example"] },
  files: {},
  problems: [],
};
const ACME_READBACK = "drafts a connector for Acme; nothing on this box will dial api.acme.example until Warp Lab ships it";

function fakeSandbox(draft: ConnectorDraftFacts | null = null) {
  const calls: Array<{ op: string; args: unknown[] }> = [];
  const rec = (op: string) => (...args: unknown[]) => {
    calls.push({ op, args });
  };
  const client: WorkspaceSandboxClient = {
    templates: vi.fn(async () => ["python-tool", "typescript-tool"]),
    create: vi.fn(async (id: string, template: string | null, author) => {
      rec("create")(id, template, author);
      return { id, branch: "work", head: "abc", dirty: false, tags: [] };
    }),
    status: vi.fn(async (id: string) => ({ id, branch: "work", head: "abc", dirty: false, tags: [] })),
    remove: vi.fn(async (id: string) => {
      rec("remove")(id);
    }),
    op: vi.fn(async (id: string, op: string, body: Record<string, unknown>) => {
      rec(op)(id, body);
      if (op === "propose" && draft) {
        return { commit: "abc", tag: `proposal/${body.version as string}`, manifest: null, kind: "connector-draft", connectorDraft: draft };
      }
      if (op === "propose") return { commit: "abc", tag: `proposal/${body.version as string}`, manifest: {}, kind: "extension" };
      if (op === "run") return { argv: body.argv, exitCode: 0, timedOut: false, durationMs: 1, stdout: "", stderr: "", truncated: false };
      return { ok: true, op };
    }),
    output: vi.fn(async () => ({ lastRun: null })),
    git: vi.fn(async (input) => {
      rec("git")(input);
      return { status: 200, headers: { "content-type": "application/x-git-upload-pack-advertisement" }, body: Buffer.from("001e# service") };
    }),
    bundle: vi.fn(async (id: string) => {
      rec("bundle")(id);
      return { body: BUNDLE, head: HEAD };
    }),
    connectorDraft: vi.fn(async (id: string, ref: string) => {
      rec("connectorDraft")(id, ref);
      return draft;
    }),
  };
  return { client, calls };
}

function buildApp(
  user: AuthUser,
  db = createAgentRunPrismaMock({ users: [owner, admin, family, guest] }),
  draft: ConnectorDraftFacts | null = null,
) {
  const sandbox = fakeSandbox(draft);
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createWorkspaceRouter(db.prisma, sandbox.client));
  return { app, db, sandbox };
}

async function seed(db: ReturnType<typeof createAgentRunPrismaMock>, id = "ws-a", userId = "u-owner") {
  await db.prisma.workshopWorkspace.create({ data: { id, userId, name: id, template: null } });
  return id;
}

async function seedRun(db: ReturnType<typeof createAgentRunPrismaMock>, workspaceId: string | null, userId = "u-owner", status = "running") {
  const row = await db.prisma.agentRun.create({
    data: { userId, goal: "g", model: "m", maxIter: 5, workspaceId },
    select: { id: true },
  });
  await db.prisma.agentRun.updateMany({ where: { id: row.id }, data: { status } });
  return row.id;
}

beforeEach(() => recordActivityMock.mockClear());

describe("the run allow-list (refuseRunArgv)", () => {
  it("is closed in shape — mirrors the sandbox's own list", () => {
    // MUTATION: return null from refuseRunArgv and every refusal below is
    // green-for-the-wrong-reason — and the route test further down proves
    // the sandbox would then be dialled.
    for (const argv of [
      ["bash", "-c", "id"],
      ["python", "evil.py"],
      ["npm", "install", "left-pad"],
      ["npm", "run", "start"],
      ["npm"],
      ["pytest", "; rm -rf /"],
      ["pytest", "../../etc"],
      ["tsc", "/etc/passwd"],
      ["ruff", "check", "$(id)"],
      [],
      "pytest",
    ]) {
      expect(refuseRunArgv(argv), JSON.stringify(argv)).not.toBeNull();
    }
    for (const argv of [["pytest", "-q"], ["ruff", "check", "."], ["npm", "test"], ["npm", "run", "build"], ["tsc", "--noEmit", "-p", "."]]) {
      expect(refuseRunArgv(argv), JSON.stringify(argv)).toBeNull();
    }
  });
});

describe("run owns workspace (WARP-2896)", () => {
  it("serves a running run bound to this workspace, as the run's person", async () => {
    const { app, db, sandbox } = buildApp(mcp);
    await seed(db);
    const runId = await seedRun(db, "ws-a");
    const res = await request(app)
      .post("/api/workspace/ws-a/write")
      .set("X-Nextcloud-User", "romain")
      .set(AGENT_RUN_HEADER, runId)
      .send({ path: "a.txt", content: "x" });
    expect(res.status).toBe(200);
    expect(sandbox.calls).toEqual([{ op: "write", args: ["ws-a", { path: "a.txt", content: "x" }] }]);
  });

  it("refuses a run bound to ANOTHER workspace, another person's run, and a run with no workspace", async () => {
    const { app, db, sandbox } = buildApp(mcp);
    await seed(db, "ws-a");
    await seed(db, "ws-b");
    const other = await seedRun(db, "ws-b");
    const someoneElses = await seedRun(db, "ws-a", "u-admin");
    const unbound = await seedRun(db, null);
    for (const runId of [other, someoneElses, unbound, "run-nope"]) {
      const res = await request(app)
        .post("/api/workspace/ws-a/read")
        .set("X-Nextcloud-User", "romain")
        .set(AGENT_RUN_HEADER, runId)
        .send({ path: "a.txt" });
      expect(res.status, runId).toBe(403);
    }
    expect(sandbox.calls).toEqual([]);
  });

  it("refuses a run that is not running (parked, finished) with 409", async () => {
    const { app, db, sandbox } = buildApp(mcp);
    await seed(db);
    for (const status of ["queued", "awaiting_confirmation", "succeeded", "cancelled"]) {
      const runId = await seedRun(db, "ws-a", "u-owner", status);
      const res = await request(app)
        .post("/api/workspace/ws-a/commit")
        .set("X-Nextcloud-User", "romain")
        .set(AGENT_RUN_HEADER, runId)
        .send({ message: "m" });
      expect(res.status, status).toBe(409);
    }
    expect(sandbox.calls).toEqual([]);
  });

  it("the mcp principal with no run header is 403 on every op — a chat turn cannot use the workshop", async () => {
    const { app, db, sandbox } = buildApp(mcp);
    await seed(db);
    for (const op of ["read", "search", "diff", "log", "write", "commit", "run", "propose"]) {
      const res = await request(app).post(`/api/workspace/ws-a/${op}`).set("X-Nextcloud-User", "romain").send({});
      expect(res.status, op).toBe(403);
    }
    expect(sandbox.calls).toEqual([]);
  });

  it("a person may read/search/diff/log without a run; write/commit/run/propose are a run's alone", async () => {
    const { app, db, sandbox } = buildApp(owner);
    await seed(db);
    expect((await request(app).post("/api/workspace/ws-a/read").send({ path: "." })).status).toBe(200);
    expect((await request(app).get("/api/workspace/ws-a/log?limit=5")).status).toBe(200);
    expect((await request(app).get("/api/workspace/ws-a/diff")).status).toBe(200);
    expect((await request(app).get("/api/workspace/ws-a/output")).status).toBe(200);
    const before = sandbox.calls.length;
    expect((await request(app).post("/api/workspace/ws-a/write").send({ path: "a", content: "x" })).status).toBe(403);
    expect((await request(app).post("/api/workspace/ws-a/commit").send({ message: "m" })).status).toBe(403);
    expect((await request(app).post("/api/workspace/ws-a/run").send({ argv: ["pytest"] })).status).toBe(403);
    expect((await request(app).post("/api/workspace/ws-a/propose").send({ name: "n", version: "0.1.0", summary: "s" })).status).toBe(403);
    expect(sandbox.calls.length).toBe(before);
  });

  it.each([
    ["family", family],
    ["guest", guest],
  ])("%s is 403 on the workspace routes", async (_label, user) => {
    const { app, db } = buildApp(user);
    await seed(db);
    expect((await request(app).get("/api/workspace")).status).toBe(403);
    expect((await request(app).get("/api/workspace/ws-a")).status).toBe(403);
    expect((await request(app).post("/api/workspace").send({ name: "x" })).status).toBe(403);
    expect((await request(app).get("/api/workspace/ws-a/log")).status).toBe(403);
  });
});

describe("the run op refuses the allow-list BEFORE the sandbox", () => {
  it("bash never reaches the sandbox; pytest does", async () => {
    // MUTATION: drop the refuseRunArgv call in opHandler("run") and the
    // first assertion fails — the fake sandbox would record a `run`.
    const { app, db, sandbox } = buildApp(mcp);
    await seed(db);
    const runId = await seedRun(db, "ws-a");
    const bad = await request(app)
      .post("/api/workspace/ws-a/run")
      .set("X-Nextcloud-User", "romain")
      .set(AGENT_RUN_HEADER, runId)
      .send({ argv: ["bash", "-c", "id"] });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("COMMAND_NOT_ALLOWED");
    expect(sandbox.calls).toEqual([]);
    const ok = await request(app)
      .post("/api/workspace/ws-a/run")
      .set("X-Nextcloud-User", "romain")
      .set(AGENT_RUN_HEADER, runId)
      .send({ argv: ["pytest", "-q"], timeoutMs: 5000 });
    expect(ok.status).toBe(200);
    expect(sandbox.calls).toEqual([{ op: "run", args: ["ws-a", { argv: ["pytest", "-q"], timeoutMs: 5000 }] }]);
  });
});

describe("create / detail / delete", () => {
  it("owner creates: sandbox first, row second, attributed author; a taken id is 409", async () => {
    const { app, db, sandbox } = buildApp(owner);
    const res = await request(app).post("/api/workspace").send({ name: "Word counter", template: "python-tool" });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^word-counter-[0-9a-f]{6}$/);
    expect(res.body.status).toBe("active");
    expect(sandbox.calls[0]).toEqual({
      op: "create",
      args: [res.body.id, "python-tool", { name: "Romain", email: "romain@droplet.local" }],
    });
    expect(db.workspaces).toHaveLength(1);
    const dup = await request(app).post("/api/workspace").send({ name: "x", id: res.body.id });
    expect(dup.status).toBe(409);
    expect((await request(app).post("/api/workspace").send({ name: "x", id: "templates" })).status).toBe(400);
  });

  it("rolls the sandbox back when the row cannot be written", async () => {
    const { app, db, sandbox } = buildApp(owner);
    (db.prisma.workshopWorkspace.create as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error("db down"));
    const res = await request(app).post("/api/workspace").send({ name: "x", id: "ws-x" });
    expect(res.status).toBe(500);
    expect(sandbox.calls.map((c) => c.op)).toEqual(["create", "remove"]);
    expect(db.workspaces).toHaveLength(0);
  });

  it("relays the sandbox's refusal (unknown template) with its status", async () => {
    const { app, sandbox } = buildApp(owner);
    const { WorkspaceSandboxError } = await import("../services/workspace.service.js");
    (sandbox.client.create as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new WorkspaceSandboxError("unknown template 'nope'", 400, "SANDBOX_ERROR"),
    );
    const res = await request(app).post("/api/workspace").send({ name: "x", template: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unknown template/);
  });

  it("detail carries the git status and the workspace's runs; delete refuses while a run is active, owner-only", async () => {
    const { app, db } = buildApp(owner);
    await seed(db);
    const runId = await seedRun(db, "ws-a");
    const detail = await request(app).get("/api/workspace/ws-a");
    expect(detail.status).toBe(200);
    expect(detail.body.git).toMatchObject({ branch: "work" });
    expect(detail.body.connectorDraft).toBeNull();
    expect(detail.body.runs.map((r: { id: string }) => r.id)).toEqual([runId]);
    expect((await request(app).delete("/api/workspace/ws-a")).status).toBe(409);
    await db.prisma.agentRun.updateMany({ where: { id: runId }, data: { status: "succeeded" } });
    expect((await request(app).delete("/api/workspace/ws-a")).status).toBe(200);
    expect(db.workspaces).toHaveLength(0);
    expect((await request(app).get("/api/workspace/ws-a")).status).toBe(404);
    const asAdmin = buildApp(admin, db);
    await seed(db, "ws-b");
    expect((await request(asAdmin.app).delete("/api/workspace/ws-b")).status).toBe(403);
  });

  it("lists templates and workspaces with the last run", async () => {
    const { app, db } = buildApp(admin);
    await seed(db);
    await seedRun(db, "ws-a", "u-owner", "succeeded");
    expect((await request(app).get("/api/workspace/templates")).body).toEqual({ templates: ["python-tool", "typescript-tool"] });
    const list = await request(app).get("/api/workspace");
    expect(list.status).toBe(200);
    expect(list.body.workspaces[0]).toMatchObject({ id: "ws-a", lastRun: { status: "succeeded" } });
  });
});

describe("propose", () => {
  it("flips the row to proposed with the tag, and a proposed workspace takes no more writes", async () => {
    const { app, db, sandbox } = buildApp(mcp);
    await seed(db);
    const runId = await seedRun(db, "ws-a");
    const res = await request(app)
      .post("/api/workspace/ws-a/propose")
      .set("X-Nextcloud-User", "romain")
      .set(AGENT_RUN_HEADER, runId)
      .send({ name: "Word counter", version: "0.1.0", summary: "Counts words." });
    expect(res.status).toBe(200);
    expect(res.body.tag).toBe("proposal/0.1.0");
    expect(sandbox.calls[0]).toEqual({
      op: "propose",
      args: ["ws-a", { name: "Word counter", version: "0.1.0", summary: "Counts words.", author: { name: "Romain", email: "romain@droplet.local" } }],
    });
    expect(db.workspaces[0]).toMatchObject({ status: "proposed", proposedTag: "proposal/0.1.0" });
    expect(recordActivityMock).toHaveBeenCalledWith(expect.objectContaining({ what: "Extension proposed" }));
    const again = await request(app)
      .post("/api/workspace/ws-a/write")
      .set("X-Nextcloud-User", "romain")
      .set(AGENT_RUN_HEADER, runId)
      .send({ path: "a", content: "x" });
    expect(again.status).toBe(409);
    // ...but reads still work, for the review.
    const read = await request(app)
      .post("/api/workspace/ws-a/read")
      .set("X-Nextcloud-User", "romain")
      .set(AGENT_RUN_HEADER, runId)
      .send({ path: "." });
    expect(read.status).toBe(200);
  });
});

describe("git smart HTTP (/api/git)", () => {
  it("the mcp principal is 403 (a tool has no business cloning); an unknown repo is 404", async () => {
    const { app: asMcp, db } = buildApp(mcp);
    await seed(db);
    expect((await request(asMcp).get("/api/git/ws-a.git/info/refs?service=git-upload-pack")).status).toBe(403);
    const { app: asOwner, sandbox } = buildApp(owner, db);
    expect((await request(asOwner).get("/api/git/nope.git/info/refs?service=git-upload-pack")).status).toBe(404);
    expect((await request(asOwner).get("/api/git/ws-a/info/refs")).status).toBe(404);
    expect(sandbox.calls).toEqual([]);
  });

  it("a guest fetches too (every human role reads), and cannot push", async () => {
    const { app, db, sandbox } = buildApp(guest);
    await seed(db);
    expect((await request(app).get("/api/git/ws-a.git/info/refs?service=git-upload-pack")).status).toBe(200);
    expect(sandbox.calls[0]).toMatchObject({ op: "git", args: [expect.objectContaining({ user: "guest", allowPush: false })] });
    expect((await request(app).get("/api/git/ws-a.git/info/refs?service=git-receive-pack")).status).toBe(403);
    expect(sandbox.calls).toHaveLength(1);
  });

  it("family fetches with the push flag OFF; family push is 403 before the sandbox", async () => {
    const { app, db, sandbox } = buildApp(family);
    await seed(db);
    const fetch = await request(app).get("/api/git/ws-a.git/info/refs?service=git-upload-pack");
    expect(fetch.status).toBe(200);
    expect(fetch.headers["content-type"]).toBe("application/x-git-upload-pack-advertisement");
    expect(sandbox.calls[0]).toMatchObject({
      op: "git",
      args: [expect.objectContaining({ method: "GET", path: "/ws-a.git/info/refs", query: "service=git-upload-pack", user: "kid", allowPush: false })],
    });
    expect((await request(app).get("/api/git/ws-a.git/info/refs?service=git-receive-pack")).status).toBe(403);
    expect((await request(app).post("/api/git/ws-a.git/git-receive-pack").send(Buffer.from("0000"))).status).toBe(403);
    expect(sandbox.calls).toHaveLength(1);
  });

  it("owner pushes with the push flag ON and the raw body forwarded; templates.git is reachable", async () => {
    // MUTATION: hard-code allowPush: false in the route and the flag
    // assertion fails; hard-code true and the family test above fails.
    const { app, db, sandbox } = buildApp(owner);
    await seed(db);
    const res = await request(app)
      .post("/api/git/ws-a.git/git-receive-pack")
      .set("Content-Type", "application/x-git-receive-pack-request")
      .send(Buffer.from("0000PACK"));
    expect(res.status).toBe(200);
    const call = sandbox.calls[0]!.args[0] as { allowPush: boolean; body: Buffer; contentType: string | null; user: string };
    expect(call.allowPush).toBe(true);
    expect(call.user).toBe("romain");
    expect(call.contentType).toBe("application/x-git-receive-pack-request");
    expect(call.body.toString()).toBe("0000PACK");
    expect(recordActivityMock).toHaveBeenCalledWith(expect.objectContaining({ what: "Workspace push" }));
    expect((await request(app).get("/api/git/templates.git/info/refs?service=git-upload-pack")).status).toBe(200);
  });
});

// ── WARP-2899: connector drafts and the export ──────────────────────────────

/** supertest's parser hook: buffer an octet-stream body (it hands over the raw IncomingMessage). */
function binary(res: request.Response, done: (err: Error | null, body: unknown) => void): void {
  const stream = res as unknown as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  stream.on("data", (c: Buffer) => chunks.push(c));
  stream.on("end", () => done(null, Buffer.concat(chunks)));
}

describe("the connector-draft readback (WARP-2899)", () => {
  it("detail carries the readback, asked at the proposed tag when there is one, else at work", async () => {
    const { app, db, sandbox } = buildApp(owner, undefined, ACME);
    await seed(db);
    const first = await request(app).get("/api/workspace/ws-a");
    expect(first.body.connectorDraft).toEqual({ provider: "acme", displayName: "Acme", readback: ACME_READBACK, problems: [] });
    expect(sandbox.calls.find((c) => c.op === "connectorDraft")?.args).toEqual(["ws-a", "work"]);
    await db.prisma.workshopWorkspace.update({ where: { id: "ws-a" }, data: { status: "proposed", proposedTag: "proposal/0.2.0" } });
    await request(app).get("/api/workspace/ws-a");
    expect(sandbox.calls.filter((c) => c.op === "connectorDraft").at(-1)?.args).toEqual(["ws-a", "proposal/0.2.0"]);
  });

  it("a sandbox error reads as an error on the field, never fails the detail", async () => {
    const { app, db, sandbox } = buildApp(owner, undefined, ACME);
    await seed(db);
    (sandbox.client.connectorDraft as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new WorkspaceSandboxError("the sandbox could not be reached", 502, "UNREACHABLE"),
    );
    const detail = await request(app).get("/api/workspace/ws-a");
    expect(detail.status).toBe(200);
    expect(detail.body.connectorDraft).toEqual({ error: "the sandbox could not be reached", code: "UNREACHABLE" });
  });

  it("propose of a connector draft records 'Connector draft proposed' with the readback, and still ends the workspace", async () => {
    const { app, db } = buildApp(mcp, undefined, ACME);
    await seed(db);
    const runId = await seedRun(db, "ws-a");
    const res = await request(app)
      .post("/api/workspace/ws-a/propose")
      .set("X-Nextcloud-User", "romain")
      .set(AGENT_RUN_HEADER, runId)
      .send({ name: "Acme draft", version: "0.1.0", summary: "Drafts Acme." });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ kind: "connector-draft", manifest: null, readback: ACME_READBACK });
    expect(db.workspaces[0]).toMatchObject({ status: "proposed", proposedTag: "proposal/0.1.0" });
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "Connector draft proposed",
        sub: ACME_READBACK,
        refs: expect.objectContaining({ provider: "acme", tag: "proposal/0.1.0" }),
      }),
    );
  });

  it("an extension proposes exactly as before — no readback", async () => {
    const { app, db } = buildApp(mcp);
    await seed(db);
    const runId = await seedRun(db, "ws-a");
    const res = await request(app)
      .post("/api/workspace/ws-a/propose")
      .set("X-Nextcloud-User", "romain")
      .set(AGENT_RUN_HEADER, runId)
      .send({ name: "Word counter", version: "0.1.0", summary: "Counts." });
    expect(res.body.readback).toBeUndefined();
    expect(recordActivityMock).toHaveBeenCalledWith(expect.objectContaining({ what: "Extension proposed", sub: "Word counter 0.1.0" }));
  });
});

describe("GET /api/workspace/:id/export (WARP-2899)", () => {
  it.each([
    ["owner", owner],
    ["admin", admin],
  ])("%s downloads the bundle as an attachment, and one audit row carries its sha256", async (_label, user) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const { app, db, sandbox } = buildApp(user, undefined, ACME);
      await seed(db);
      const res = await request(app).get("/api/workspace/ws-a/export").buffer(true).parse(binary);
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toBe("application/octet-stream");
      expect(res.headers["content-disposition"]).toBe('attachment; filename="ws-a-0123456.bundle"');
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(Buffer.compare(res.body as Buffer, BUNDLE)).toBe(0);
      // MUTATION: drop the recordActivity call → red.
      const rows = recordActivityMock.mock.calls.filter((c) => (c[0] as { what?: string }).what === "Workspace exported");
      expect(rows).toHaveLength(1);
      expect(rows[0]![0]).toMatchObject({
        kind: "tool_run",
        sub: "ws-a",
        refs: {
          workspaceId: "ws-a",
          head: HEAD,
          sha256: createHash("sha256").update(BUNDLE).digest("hex"),
          bytes: BUNDLE.length,
          proposedTag: null,
          provider: "acme",
        },
      });
      expect(sandbox.calls.filter((c) => c.op === "bundle")).toEqual([{ op: "bundle", args: ["ws-a"] }]);
      // The orchestrator dials nothing but the sandbox — and the fake is the sandbox.
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it.each([
    ["family", family],
    ["guest", guest],
    ["the mcp principal", mcp],
  ])("%s is 403 and the sandbox is never asked", async (_label, user) => {
    // MUTATION: guard the route with `gate` (requireRoleOrMcpService) instead
    // of requireRole + the human check → the mcp case goes 200.
    const { app, db, sandbox } = buildApp(user);
    await seed(db);
    const res = await request(app).get("/api/workspace/ws-a/export").set("X-Nextcloud-User", "romain");
    expect(res.status).toBe(403);
    expect(sandbox.calls).toEqual([]);
    // (the denial itself is recorded — recordAccessDenied — but no export row)
    expect(recordActivityMock).not.toHaveBeenCalledWith(expect.objectContaining({ what: "Workspace exported" }));
  });

  it("an owner's request carrying a run header is 403 — a run does not export", async () => {
    // MUTATION: drop the AGENT_RUN_HEADER check → 200.
    const { app, db, sandbox } = buildApp(owner);
    await seed(db);
    const runId = await seedRun(db, "ws-a");
    const res = await request(app).get("/api/workspace/ws-a/export").set(AGENT_RUN_HEADER, runId);
    expect(res.status).toBe(403);
    expect(sandbox.calls).toEqual([]);
  });

  it("an unknown workspace is 404 and a malformed id 400, without dialling the sandbox", async () => {
    const { app, sandbox } = buildApp(owner);
    expect((await request(app).get("/api/workspace/ws-nope/export")).status).toBe(404);
    expect((await request(app).get("/api/workspace/Bad_Id/export")).status).toBe(400);
    expect(sandbox.calls).toEqual([]);
  });

  it("a failed draft lookup never blocks the download; the provider is then null", async () => {
    const { app, db, sandbox } = buildApp(owner, undefined, ACME);
    await seed(db);
    (sandbox.client.connectorDraft as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new WorkspaceSandboxError("boom", 502, "SANDBOX_ERROR"),
    );
    const res = await request(app).get("/api/workspace/ws-a/export").buffer(true).parse(binary);
    expect(res.status).toBe(200);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({ what: "Workspace exported", refs: expect.objectContaining({ provider: null }) }),
    );
  });

  it("asks for the draft at the proposed tag, and relays a sandbox refusal (413) with its status", async () => {
    const { app, db, sandbox } = buildApp(owner, undefined, ACME);
    await seed(db);
    await db.prisma.workshopWorkspace.update({ where: { id: "ws-a" }, data: { status: "proposed", proposedTag: "proposal/0.1.0" } });
    await request(app).get("/api/workspace/ws-a/export").buffer(true).parse(binary);
    expect(sandbox.calls.find((c) => c.op === "connectorDraft")?.args).toEqual(["ws-a", "proposal/0.1.0"]);
    recordActivityMock.mockClear();
    (sandbox.client.bundle as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(
      new WorkspaceSandboxError("the workspace exceeds the 64 MB export ceiling", 413, "SANDBOX_ERROR"),
    );
    const res = await request(app).get("/api/workspace/ws-a/export");
    expect(res.status).toBe(413);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});
