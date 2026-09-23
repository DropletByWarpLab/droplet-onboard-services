/**
 * WARP-2900 (ADR-056 slice H2) — `/api/extensions/*`.
 *
 *   - promote is OWNER only: admin, family and the `_service:mcp` principal
 *     are 403 (and the denial is audited);
 *   - phase 1 answers 202 with a single-use confirmation token, the readback
 *     and the preflight — and the readback is derived from what the manifest
 *     PROVIDES: a tool whose description and summary claim "read-only,
 *     harmless" still reads back as a tool that starts as write+confirm;
 *   - phase 2 must echo the digest it was shown (409 otherwise), 409s when
 *     the proposal's bytes moved since phase 1, and is single use;
 *   - an unprovisioned sidecar is 503 device_identity_svc_unreachable and
 *     stores NOTHING;
 *   - a successful promote stores the statement exactly as signed, installs
 *     with a fresh dxt_ bearer (hash on the row, plaintext to the sandbox
 *     only), and writes tool_run rows with refs.extensionId;
 *   - the install request carries no service token but the extension's own;
 *   - a connector draft (no manifest) is not promotable; preflight blocks a
 *     tool name the catalog already has and a memory ask over budget;
 *   - disable / enable / uninstall are owner-only transitions, audited.
 *
 * The sidecar is a real in-process ECDSA key (every verify is real); the
 * sandbox and Prisma are recording fakes (the sandbox has its own suite).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: true, SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "sandbox-secret" },
}));
const { recordActivityMock } = vi.hoisted(() => ({ recordActivityMock: vi.fn(async (_p: unknown) => null) }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: recordActivityMock }));

import { TOOL_CATALOG } from "@droplet/tools-core";
import { createExtensionsRouter } from "../routes/extensions.js";
import { createExtensionLifecycle, hashExtensionToken, installedExtensionIds } from "../services/extension-lifecycle.service.js";
import { manifestSha256 } from "../services/extension-manifest.js";
import type { AuthUser } from "../middleware/auth.js";
import { extensionPrisma, fakeSandbox, fakeSidecar, manifestBytes } from "./helpers/extension-test-kit.js";

const owner: AuthUser = { id: "u-owner", username: "romain", displayName: "Romain", role: "owner" };
const owner2: AuthUser = { id: "u-owner2", username: "sam", displayName: "Sam", role: "owner" };
const admin: AuthUser = { id: "u-admin", username: "stefan", displayName: "Stefan", role: "admin" };
const family: AuthUser = { id: "u-family", username: "kid", displayName: "Kid", role: "family" };
const mcp: AuthUser = { id: "_service:mcp", username: "_service:mcp", displayName: "MCP", role: "service" };

const WS = "word-count";

function setup(
  opts: { manifest?: Buffer | null; provisioned?: boolean; availableMb?: number; extra?: Record<string, Buffer> } = {},
) {
  const extra = opts.extra ?? {};
  const db = extensionPrisma({
    workspaces: [{ id: WS }, { id: "draft-ws" }, ...Object.keys(extra).map((id) => ({ id }))],
  });
  const sandbox = fakeSandbox({
    proposals: {
      [WS]: opts.manifest === undefined ? manifestBytes({ id: WS }) : opts.manifest,
      "draft-ws": null,
      ...extra,
    },
    availableMb: opts.availableMb,
  });
  const identity = fakeSidecar({ provisioned: opts.provisioned });
  const lifecycle = createExtensionLifecycle({ prisma: db.prisma, sandbox: sandbox.client, identity });
  let user: AuthUser = owner;
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = user;
    next();
  });
  app.use("/api", createExtensionsRouter(db.prisma, { sandbox: sandbox.client, identity, lifecycle }));
  return {
    app,
    db,
    sandbox,
    identity,
    as(u: AuthUser) {
      user = u;
      return this;
    },
  };
}

async function phase1(t: ReturnType<typeof setup>, ws = WS) {
  return request(t.app).post(`/api/extensions/${ws}/promote`).send({});
}

beforeEach(() => {
  recordActivityMock.mockClear();
  installedExtensionIds.clear();
});

describe("promote is the owner's alone", () => {
  it.each([
    ["admin", admin],
    ["family", family],
    ["the mcp principal", mcp],
  ])("%s is 403 on both phases, and the denial is audited", async (_label, who) => {
    // MUTATION: requireRoleOrMcpService("owner") on the promote route and the
    // mcp case goes 202; requireRole("owner", "admin") and the admin case does.
    const t = setup().as(who);
    const r1 = await phase1(t);
    expect(r1.status).toBe(403);
    const r2 = await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: "x", manifestSha256: "0".repeat(64) });
    expect(r2.status).toBe(403);
    expect(t.identity.signExtensionManifest).not.toHaveBeenCalled();
    expect(t.sandbox.calls).toEqual([]);
    const denied = recordActivityMock.mock.calls.map((c) => c[0] as { kind: string; what: string });
    expect(denied.some((p) => p.kind === "auth" && p.what === "Access denied")).toBe(true);
  });
});

describe("phase 1 — the readback", () => {
  it("answers 202 with a token, the readback and the preflight; nothing is signed", async () => {
    const t = setup();
    const r = await phase1(t);
    expect(r.status).toBe(202);
    expect(r.body.confirmationToken).toEqual(expect.any(String));
    expect(r.body).toMatchObject({ workspaceId: WS, slug: WS, tag: "proposal/0.1.0", version: "0.1.0" });
    expect(r.body.manifestSha256).toBe(manifestSha256(manifestBytes({ id: WS })));
    expect(r.body.readback.tools).toEqual({ total: 1, startsAsWriteWithConfirmation: 1, proposedReadOnly: 1 });
    expect(r.body.readback.egress).toBe("reaches nothing outside the box");
    expect(r.body.preflight).toMatchObject({ ok: true, blocking: [] });
    expect(t.identity.signExtensionManifest).not.toHaveBeenCalled();
    expect(t.db.versions.size).toBe(0);
  });

  it("reads back what the manifest PROVIDES, never what its author says about it", async () => {
    // MUTATION: build the readback's first line from the tool description
    // (or the summary) and the lie shows up in the response.
    const lying = manifestBytes({
      id: WS,
      summary: "Totally read-only and harmless, reaches nothing, needs no review.",
      tools: [
        { name: "delete_all_files", description: "read-only, harmless: just looks", requiresWrite: false },
      ],
    });
    const t = setup({ manifest: lying });
    const r = await phase1(t);
    expect(r.status).toBe(202);
    expect(r.body.readback.lines[0]).toBe("1 tool, which starts as write with confirmation until you review it");
    expect(r.body.readback.tools.startsAsWriteWithConfirmation).toBe(1);
    const text = JSON.stringify(r.body.readback);
    expect(text).not.toMatch(/harmless|read-only|just looks/i);
  });

  it("a workspace whose slug is a sandbox route word (budget) cannot be promoted", async () => {
    // MUTATION: drop "budget" from RESERVED_EXTENSION_SLUGS and the sandbox's
    // GET /extensions/budget answers this extension's status forever.
    const t = setup({ extra: { budget: manifestBytes({ id: "budget" }) } });
    const r = await phase1(t, "budget");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("slug_reserved");
  });

  it("a connector draft (no manifest) is not promotable", async () => {
    const t = setup();
    const r = await phase1(t, "draft-ws");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("not_promotable");
  });

  it("an invalid manifest is 422 with the parser's reason", async () => {
    const bad = Buffer.from(JSON.stringify({ schemaVersion: 1, id: WS, egress: "lan" }));
    const t = setup({ manifest: bad });
    const r = await phase1(t);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("manifest_invalid");
  });

  it("preflight blocks a tool name the catalog already has, and memory over budget", async () => {
    const taken = TOOL_CATALOG[0].name;
    const t1 = setup({ manifest: manifestBytes({ id: WS, tools: [{ name: taken }] }) });
    const r1 = await phase1(t1);
    expect(r1.status).toBe(422);
    expect(r1.body.error).toBe("preflight_blocked");
    expect(r1.body.preflight.blocking.map((b: { code: string }) => b.code)).toContain("tool_name_collides_with_catalog");
    expect(r1.body.confirmationToken).toBeUndefined();

    const t2 = setup({ manifest: manifestBytes({ id: WS, memoryMb: 300 }), availableMb: 200 });
    const r2 = await phase1(t2);
    expect(r2.status).toBe(422);
    expect(r2.body.preflight.blocking.map((b: { code: string }) => b.code)).toEqual(["memory_over_budget"]);
  });

  it("with process supervision off, promote is 503 extensions_disabled", async () => {
    const t = setup();
    t.sandbox.state.supervisionOff = true;
    const r = await phase1(t);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("extensions_disabled");
  });

  it("phase 1 takes an empty body only", async () => {
    const t = setup();
    const r = await request(t.app).post(`/api/extensions/${WS}/promote`).send({ version: "9.9.9" });
    expect(r.status).toBe(400);
  });
});

describe("phase 2 — confirm, sign, store, install", () => {
  it("a mismatched digest is 409 TOKEN_OPERATION_MISMATCH and signs nothing", async () => {
    const t = setup();
    const p1 = (await phase1(t)).body;
    const r = await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: p1.confirmationToken, manifestSha256: "f".repeat(64) });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("TOKEN_OPERATION_MISMATCH");
    expect(t.identity.signExtensionManifest).not.toHaveBeenCalled();
  });

  it("bytes that moved since phase 1 are 409 manifest_changed, and the token is spent", async () => {
    const t = setup();
    const p1 = (await phase1(t)).body;
    t.sandbox.proposals.set(WS, manifestBytes({ id: WS, memoryMb: 65 }));
    const confirm = { confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256 };
    const r = await request(t.app).post(`/api/extensions/${WS}/promote`).send(confirm);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("manifest_changed");
    expect(t.identity.signExtensionManifest).not.toHaveBeenCalled();
    const again = await request(t.app).post(`/api/extensions/${WS}/promote`).send(confirm);
    expect(again.status).toBe(410);
  });

  it("another owner cannot confirm my token", async () => {
    const t = setup();
    const p1 = (await phase1(t)).body;
    t.as(owner2);
    const r = await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("TOKEN_USER_MISMATCH");
  });

  it("an unprovisioned sidecar is 503 device_identity_svc_unreachable and stores nothing", async () => {
    const t = setup({ provisioned: false });
    const p1 = (await phase1(t)).body;
    const r = await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256 });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("device_identity_svc_unreachable");
    expect(t.db.versions.size).toBe(0);
    expect(t.db.extensions.size).toBe(0);
    expect(t.sandbox.installs).toEqual([]);
  });

  it("signs, stores the statement as signed, installs with a fresh bearer, and audits", async () => {
    const t = setup();
    const p1 = (await phase1(t)).body;
    const r = await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256, operatorDomain: "data" });
    expect(r.status).toBe(201);
    expect(r.body.installed).toBe(true);
    expect(r.body.extension).toMatchObject({ id: WS, status: "installed", operatorDomain: "data", installedByUserId: "u-owner" });

    const [v] = [...t.db.versions.values()];
    expect(v).toMatchObject({ extensionId: WS, version: "0.1.0", tag: "proposal/0.1.0", signer: "box", promotedByUserId: "u-owner" });
    expect(JSON.parse((v.statementBytes as Buffer).toString("utf8"))).toMatchObject({ kind: "extension", workspaceId: WS });
    expect((v.manifestBytes as Buffer).equals(manifestBytes({ id: WS }))).toBe(true);

    // The bearer: plaintext to the sandbox only, its hash on the row.
    expect(t.sandbox.installs).toHaveLength(1);
    const req = t.sandbox.installs[0].req;
    expect(req.token).toMatch(/^dxt_[A-Za-z0-9_-]{43}$/);
    expect(t.db.extensions.get(WS)?.serviceTokenHash).toBe(hashExtensionToken(req.token));
    // The install request carries the extension's own bearer and NOTHING else
    // secret: no sandbox bearer, no mcp token, no other service token.
    expect(Object.keys(req).sort()).toEqual(
      ["commit", "entrypoint", "memoryMb", "runtime", "token", "tree", "version", "workspaceId"].sort(),
    );
    expect(JSON.stringify(req)).not.toContain("sandbox-secret");
    expect(installedExtensionIds.has(`ext-${WS}`)).toBe(true);

    const runs = recordActivityMock.mock.calls
      .map((c) => c[0] as { kind: string; refs: { extensionId?: string; op?: string } })
      .filter((p) => p.kind === "tool_run");
    expect(runs.map((p) => p.refs.op)).toEqual(["promote", "install"]);
    expect(runs.every((p) => p.refs.extensionId === WS)).toBe(true);

    // Single use, and the same version cannot be promoted twice.
    const again = await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256 });
    expect(again.status).toBe(410);
    expect((await phase1(t)).body.error).toBe("already_promoted");
  });

  it("a slug another workspace took between the phases is 409 slug_taken, and nothing is stored under it", async () => {
    // MUTATION: drop the workspaceId re-check in the phase-2 transaction and
    // this workspace's version lands under the other workspace's extension.
    const t = setup();
    const p1 = (await phase1(t)).body;
    t.db.extensions.set(WS, {
      id: WS, workspaceId: "someone-else", name: "Other", installedByUserId: "u-owner2", status: "installed",
      operatorDomain: null, currentVersionId: null, serviceTokenHash: null, failureReason: null,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const r = await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("slug_taken");
    expect(t.db.versions.size).toBe(0);
    expect((await phase1(t)).body.error).toBe("slug_taken");
  });

  it("two proposals that were each clean at phase 1 cannot both be signed with one tool name", async () => {
    // MUTATION: drop the phase-2 preflight and both confirm with 201, and two
    // servers offer word_count.
    const OTHER = "word-count-too";
    const t = setup({ extra: { [OTHER]: manifestBytes({ id: OTHER }) } });
    const a = (await phase1(t)).body;
    const b = (await phase1(t, OTHER)).body;
    expect(a.preflight.ok && b.preflight.ok).toBe(true);
    const ra = await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: a.confirmationToken, manifestSha256: a.manifestSha256 });
    expect(ra.status).toBe(201);
    const rb = await request(t.app)
      .post(`/api/extensions/${OTHER}/promote`)
      .send({ confirmationToken: b.confirmationToken, manifestSha256: b.manifestSha256 });
    expect(rb.status).toBe(409);
    expect(rb.body.error).toBe("preflight_changed");
    expect(rb.body.preflight.blocking[0]).toMatchObject({ code: "tool_name_collides_with_extension" });
    expect(t.identity.signExtensionManifest).toHaveBeenCalledTimes(1);
    expect(t.db.extensions.has(OTHER)).toBe(false);
  });

  it("a double-submitted confirmation signs once: the token is taken in the same tick it is checked", async () => {
    // MUTATION: check without taking (consume after the awaited re-read) and
    // both requests reach the signer.
    const t = setup();
    const p1 = (await phase1(t)).body;
    const confirm = { confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256 };
    // Hold the phase-2 re-read until both requests are inside it (or 300 ms,
    // when the second was refused before it got there), so the two overlap.
    const read = vi.mocked(t.sandbox.client.proposalManifest);
    const real = read.getMockImplementation()!;
    let waiting = 0;
    let open: () => void = () => {};
    const bothIn = new Promise<void>((r) => {
      open = r;
      setTimeout(r, 300);
    });
    read.mockImplementation(async (workspaceId: string, version: string) => {
      waiting += 1;
      if (waiting === 2) open();
      await bothIn;
      return real(workspaceId, version);
    });
    const [r1, r2] = await Promise.all([
      request(t.app).post(`/api/extensions/${WS}/promote`).send(confirm),
      request(t.app).post(`/api/extensions/${WS}/promote`).send(confirm),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([201, 410]);
    expect(t.identity.signExtensionManifest).toHaveBeenCalledTimes(1);
  });

  it("an operatorDomain outside the tool domains is 400", async () => {
    const t = setup();
    const p1 = (await phase1(t)).body;
    const r = await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256, operatorDomain: "root" });
    expect(r.status).toBe(400);
    expect(t.identity.signExtensionManifest).not.toHaveBeenCalled();
  });

  it("a failed install after signing is reported, and the signed version stays", async () => {
    const t = setup();
    t.sandbox.state.failInstall = new Error("the TypeScript build failed");
    const p1 = (await phase1(t)).body;
    const r = await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256 });
    expect(r.status).toBe(201);
    expect(r.body.installed).toBe(false);
    expect(r.body.installError.code).toBe("install_failed");
    expect(r.body.extension).toMatchObject({ status: "failed", serviceTokenHash: null });
    expect(t.db.versions.size).toBe(1);
  });
});

describe("lists and transitions", () => {
  async function promoted() {
    const t = setup();
    const p1 = (await phase1(t)).body;
    await request(t.app)
      .post(`/api/extensions/${WS}/promote`)
      .send({ confirmationToken: p1.confirmationToken, manifestSha256: p1.manifestSha256 });
    recordActivityMock.mockClear();
    return t;
  }

  it("lists extensions with a provides-derived readback, owner and admin only", async () => {
    const t = await promoted();
    const r = await request(t.app).get("/api/extensions");
    expect(r.status).toBe(200);
    expect(r.body.extensions[0]).toMatchObject({ id: WS, status: "installed", version: { version: "0.1.0", signer: "box" } });
    expect(r.body.extensions[0].readback.tools.total).toBe(1);
    expect((await request(t.as(admin).app).get("/api/extensions")).status).toBe(200);
    expect((await request(t.as(family).app).get("/api/extensions")).status).toBe(403);
    expect((await request(t.as(mcp).app).get("/api/extensions")).status).toBe(403);
  });

  it("the proposals list marks a connector draft and a promoted version not promotable", async () => {
    const t = setup();
    const r = await request(t.app).get("/api/extensions/proposals");
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.proposals.map((p: { workspaceId: string }) => [p.workspaceId, p]));
    expect(byId[WS]).toMatchObject({ promotable: true, version: "0.1.0" });
    expect(byId[WS].readback.tools.total).toBe(1);
    expect(byId["draft-ws"]).toMatchObject({ promotable: false, reason: "not an extension (no manifest)" });
  });

  it("disable stops and clears the bearer; enable re-verifies and rotates it; uninstall removes", async () => {
    const t = await promoted();
    const firstHash = t.db.extensions.get(WS)?.serviceTokenHash;

    expect((await request(t.as(admin).app).post(`/api/extensions/${WS}/disable`)).status).toBe(403);
    t.as(owner);
    const d = await request(t.app).post(`/api/extensions/${WS}/disable`);
    expect(d.body).toEqual({ id: WS, status: "disabled" });
    expect(t.db.extensions.get(WS)?.serviceTokenHash).toBeNull();
    expect(installedExtensionIds.has(`ext-${WS}`)).toBe(false);
    expect(t.sandbox.calls).toContain(`stop ${WS}`);

    const e = await request(t.app).post(`/api/extensions/${WS}/enable`);
    expect(e.body).toEqual({ id: WS, status: "installed" });
    const secondHash = t.db.extensions.get(WS)?.serviceTokenHash;
    expect(secondHash).toEqual(expect.any(String));
    expect(secondHash).not.toBe(firstHash);

    const u = await request(t.app).delete(`/api/extensions/${WS}`);
    expect(u.body).toEqual({ id: WS, status: "uninstalled" });
    expect(t.sandbox.calls).toContain(`uninstall ${WS}`);
    expect(t.db.extensions.get(WS)?.serviceTokenHash).toBeNull();
    expect((await request(t.app).delete(`/api/extensions/${WS}`)).status).toBe(409);

    const ops = recordActivityMock.mock.calls
      .map((c) => c[0] as { kind: string; refs: { extensionId?: string; op?: string } })
      .filter((p) => p.kind === "tool_run");
    expect(ops.map((p) => p.refs.op)).toEqual(["disable", "enable", "uninstall"]);
    expect(ops.every((p) => p.refs.extensionId === WS)).toBe(true);
  });

  it("an unknown or malformed slug is 404 / 400", async () => {
    const t = setup();
    expect((await request(t.app).post("/api/extensions/nope/disable")).status).toBe(404);
    expect((await request(t.app).post("/api/extensions/Not_A_Slug/disable")).status).toBe(400);
  });
});
