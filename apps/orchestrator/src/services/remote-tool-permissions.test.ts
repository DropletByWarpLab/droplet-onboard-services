/**
 * WARP-3962 — tool permissions per MCP server, bound to the product contract
 * ("reads run automatically, writes ask for a thumbs-up, destructive actions
 * are blocked") and enforced at dispatch.
 *
 *   - the validator matrix (grade × permission) and the admin tighten-only rule;
 *   - discovery defaults per grade, and a changed definition resetting to the
 *     default for its grade while keeping a block;
 *   - dispatch through the REAL composed vendor policy and the real
 *     interceptor: ask → the existing challenge → approve runs once; block →
 *     REMOTE_TOOL_DENIED; destructive never runs; a read-ask says it reads;
 *   - the role gates are unchanged: a member loses writes, a guest gets nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createToolCallInterceptor } from "@droplet/tools-core";
import { McpToolMultiplexer } from "./mcp-multiplexer.service.js";
import type { McpClientPort, McpToolDescriptor } from "./mcp-client.port.js";
import {
  composeRemoteCallPolicy,
  DEFAULT_PERMISSION,
  permissionOf,
  RemoteToolClassificationCache,
  remoteToolClassificationCache,
  recordDiscoveredRemoteTools,
  setRemoteToolGroupPermission,
  setRemoteToolPermission,
  withRemoteAllowlist,
  type RemoteToolPermission,
} from "./remote-tool-classification.service.js";
import { remoteToolGradeOf, remoteToolTableExists, remoteToolTablePolicy } from "./remote-tool-tables.js";
import { toolAllowedForTier } from "./tool-access.service.js";
import { fakeClassificationPrisma } from "../__tests__/helpers/remote-tool-fake-prisma.js";

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

const T0 = new Date("2026-10-10T10:00:00Z");
const READ = "getJiraIssue"; // an Atlassian read
const WRITE = "createJiraIssue"; // an Atlassian write
const DESTRUCTIVE = "updateConfluencePage"; // the one destructive Atlassian tool
const owner = { id: "romain", role: "owner" };
const admin = { id: "stefan", role: "admin" };

async function discovered(extra: { serverId?: string; tools?: string[]; hash?: string } = {}) {
  const f = fakeClassificationPrisma();
  const serverId = extra.serverId ?? "atlassian";
  await recordDiscoveredRemoteTools(
    f.prisma,
    serverId,
    (extra.tools ?? [READ, WRITE, DESTRUCTIVE]).map((wireName) => ({
      wireName,
      description: `${wireName} desc`,
      ...(extra.hash ? { inputSchemaHash: extra.hash } : {}),
    })),
    T0,
    { gradeOf: remoteToolGradeOf },
  );
  return f;
}

describe("discovery defaults are the contract, per grade", () => {
  it("read → always, write → ask, destructive → block (unknown grade is a write)", async () => {
    const { rows } = await discovered({ tools: [READ, WRITE, DESTRUCTIVE, "someNewAtlassianTool"] });
    expect(rows.get(`atlassian|${READ}`)).toMatchObject({
      grade: "READ", requiresWrite: false, requiresConfirmation: false, denied: false, allowlisted: true, reviewedAt: null,
    });
    expect(rows.get(`atlassian|${WRITE}`)).toMatchObject({
      grade: "WRITE", requiresWrite: true, requiresConfirmation: true, denied: false, allowlisted: true,
    });
    expect(rows.get(`atlassian|${DESTRUCTIVE}`)).toMatchObject({
      grade: "DESTRUCTIVE", denied: true, allowlisted: false,
    });
    // a tool the reviewed table does not list (a vendor adds deleteJiraIssue later) is blocked, never ask
    expect(rows.get("atlassian|someNewAtlassianTool")).toMatchObject({ grade: "WRITE", denied: true, allowlisted: false });
    expect(permissionOf(rows.get("atlassian|someNewAtlassianTool")!)).toBe("block");
    expect(DEFAULT_PERMISSION).toEqual({ read: "always", write: "ask", destructive: "block" });
    for (const [k, r] of rows) {
      if (k.endsWith("someNewAtlassianTool")) continue;
      expect(permissionOf(r)).toBe(r.grade === "READ" ? "always" : r.grade === "WRITE" ? "ask" : "block");
    }
  });

  it("an owner-added server (no table) discovers every tool as a write that starts BLOCKED; the owner choosing Ask is the review", async () => {
    const f = await discovered({ serverId: "acme", tools: ["list_things"] });
    expect(f.rows.get("acme|list_things")).toMatchObject({
      grade: "WRITE", requiresWrite: true, requiresConfirmation: true, denied: false, allowlisted: false,
    });
    expect(permissionOf(f.rows.get("acme|list_things")!)).toBe("block");
    // an admin cannot open it; an owner can, and only to ask
    expect(await setRemoteToolPermission(f.prisma, { serverId: "acme", toolName: "list_things", permission: "ask", actor: admin })).toMatchObject({
      ok: false, code: "ADMIN_CAN_ONLY_TIGHTEN",
    });
    expect(await setRemoteToolPermission(f.prisma, { serverId: "acme", toolName: "list_things", permission: "always", actor: owner })).toMatchObject({
      ok: false, code: "PERMISSION_NOT_ALLOWED_FOR_GRADE",
    });
    expect(await setRemoteToolPermission(f.prisma, { serverId: "acme", toolName: "list_things", permission: "ask", actor: owner })).toMatchObject({ ok: true });
    expect(f.rows.get("acme|list_things")).toMatchObject({ allowlisted: true, requiresConfirmation: true });
  });

  it("a tool the table excludes (or does not list) can only be block via the permission writer, and is re-blocked on re-discovery", async () => {
    const f = await discovered({ tools: ["someNewAtlassianTool"] });
    expect(
      await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: "someNewAtlassianTool", permission: "ask", actor: owner, classOf: remoteToolGradeOf }),
    ).toMatchObject({ ok: false, code: "PERMISSION_NOT_ALLOWED_FOR_GRADE" });
    // a stored row that drifted open is tightened by the next discovery
    f.rows.set("atlassian|someNewAtlassianTool", { ...f.rows.get("atlassian|someNewAtlassianTool")!, denied: false, allowlisted: true });
    await recordDiscoveredRemoteTools(f.prisma, "atlassian", [{ wireName: "someNewAtlassianTool" }], T0, { gradeOf: remoteToolGradeOf });
    expect(f.rows.get("atlassian|someNewAtlassianTool")).toMatchObject({ denied: true, allowlisted: false });
  });

  it("the group writer leaves tools the table does not grade (and excluded ones) for their own review", async () => {
    const f = await discovered({ tools: [READ, "someNewAtlassianTool"] });
    const out = await setRemoteToolGroupPermission(f.prisma, { serverId: "atlassian", group: "write", permission: "ask", actor: owner, classOf: remoteToolGradeOf }, T0);
    expect(out).toMatchObject({ ok: true, changed: [], skipped: ["someNewAtlassianTool"] });
    expect(permissionOf(f.rows.get("atlassian|someNewAtlassianTool")!)).toBe("block");
  });

  it("without gradeOf (an extension) the import default stands and is not allowlisted", async () => {
    const f = fakeClassificationPrisma();
    await recordDiscoveredRemoteTools(f.prisma, "ext-wc", [{ wireName: "word_count" }], T0);
    expect(f.rows.get("ext-wc|word_count")).toMatchObject({ requiresWrite: true, requiresConfirmation: true, denied: false });
    expect(f.rows.get("ext-wc|word_count")?.allowlisted).toBeUndefined();
  });

  it("re-discovery keeps a person's decision", async () => {
    const f = await discovered();
    await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: READ, permission: "block", actor: owner }, T0);
    await recordDiscoveredRemoteTools(f.prisma, "atlassian", [{ wireName: READ }], T0, { gradeOf: remoteToolGradeOf });
    expect(permissionOf(f.rows.get(`atlassian|${READ}`)!)).toBe("block");
  });
});

describe("the validator matrix (grade x permission)", () => {
  const legal: Record<string, RemoteToolPermission[]> = {
    [READ]: ["always", "ask", "block"],
    [WRITE]: ["ask", "block"],
    [DESTRUCTIVE]: ["block"],
  };
  for (const tool of [READ, WRITE, DESTRUCTIVE]) {
    for (const permission of ["always", "ask", "block"] as const) {
      const ok = legal[tool]!.includes(permission);
      it(`owner sets ${tool} (${tool === READ ? "read" : tool === WRITE ? "write" : "destructive"}) to ${permission}: ${ok ? "accepted" : "refused"}`, async () => {
        const f = await discovered();
        const out = await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: tool, permission, actor: owner }, T0);
        if (ok) {
          expect(out).toMatchObject({ ok: true });
          expect(permissionOf(f.rows.get(`atlassian|${tool}`)!)).toBe(permission);
          expect(f.rows.get(`atlassian|${tool}`)).toMatchObject({ reviewedBy: "romain", reviewedAt: T0, definitionStatus: "CURRENT" });
        } else {
          expect(out).toMatchObject({ ok: false, code: "PERMISSION_NOT_ALLOWED_FOR_GRADE" });
        }
      });
    }
  }

  it("a write set to ask or block keeps requiresWrite; a read set to ask is not a write", async () => {
    const f = await discovered();
    await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: READ, permission: "ask", actor: owner }, T0);
    expect(f.rows.get(`atlassian|${READ}`)).toMatchObject({ requiresWrite: false, requiresConfirmation: true, denied: false });
    await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: WRITE, permission: "block", actor: owner }, T0);
    expect(f.rows.get(`atlassian|${WRITE}`)).toMatchObject({ requiresWrite: true, denied: true, allowlisted: false });
    // never the unconfirmed-write state
    for (const r of f.rows.values()) expect(r.requiresWrite && !r.requiresConfirmation).toBe(false);
  });

  it("a tool the server never advertised is NOT_FOUND", async () => {
    const f = await discovered();
    expect(await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: "ghost", permission: "ask", actor: owner })).toMatchObject({
      ok: false, code: "NOT_FOUND",
    });
  });

  it("a hash that is no longer the row's is STALE_REVIEW and changes nothing", async () => {
    const f = await discovered({ hash: "a".repeat(64) });
    const stored = f.rows.get(`atlassian|${WRITE}`)!.inputSchemaHash!;
    expect(
      await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: WRITE, permission: "block", actor: owner, inputSchemaHash: "b".repeat(64) }),
    ).toMatchObject({ ok: false, code: "STALE_REVIEW" });
    expect(permissionOf(f.rows.get(`atlassian|${WRITE}`)!)).toBe("ask");
    expect(
      await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: WRITE, permission: "block", actor: owner, inputSchemaHash: stored }),
    ).toMatchObject({ ok: true });
  });
});

describe("an admin may only tighten", () => {
  async function at(tool: string, start: RemoteToolPermission) {
    const f = await discovered();
    if (start !== DEFAULT_PERMISSION.read || tool !== READ) {
      await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: tool, permission: start, actor: owner }, T0);
    }
    return f;
  }
  const asAdmin = (f: Awaited<ReturnType<typeof discovered>>, tool: string, permission: RemoteToolPermission) =>
    setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: tool, permission, actor: admin }, T0);

  it("always → ask and ask → block are accepted", async () => {
    expect(await asAdmin(await at(READ, "always"), READ, "ask")).toMatchObject({ ok: true });
    expect(await asAdmin(await at(READ, "ask"), READ, "block")).toMatchObject({ ok: true });
  });
  it("ask → always, block → ask and block → always are refused", async () => {
    expect(await asAdmin(await at(READ, "ask"), READ, "always")).toMatchObject({ ok: false, code: "ADMIN_CAN_ONLY_TIGHTEN" });
    expect(await asAdmin(await at(WRITE, "block"), WRITE, "ask")).toMatchObject({ ok: false, code: "ADMIN_CAN_ONLY_TIGHTEN" });
    expect(await asAdmin(await at(READ, "block"), READ, "always")).toMatchObject({ ok: false, code: "ADMIN_CAN_ONLY_TIGHTEN" });
  });
  it("the same value is accepted (no change), and a refusal changes nothing", async () => {
    const f = await at(WRITE, "ask");
    expect(await asAdmin(f, WRITE, "ask")).toMatchObject({ ok: true, before: "ask" });
    const g = await at(WRITE, "block");
    await asAdmin(g, WRITE, "ask");
    expect(permissionOf(g.rows.get(`atlassian|${WRITE}`)!)).toBe("block");
  });
  it("the contract check runs before the role check (an admin cannot make a write 'always' either)", async () => {
    expect(await asAdmin(await discovered(), WRITE, "always")).toMatchObject({ ok: false, code: "PERMISSION_NOT_ALLOWED_FOR_GRADE" });
  });
});

describe("the group permission is all-or-nothing", () => {
  it("applies to every tool of the grade and skips a CHANGED one", async () => {
    const f = await discovered({ tools: [READ, "getVisibleJiraProjects", "getConfluencePage"] });
    f.rows.set("atlassian|getConfluencePage", { ...f.rows.get("atlassian|getConfluencePage")!, definitionStatus: "CHANGED" });
    const out = await setRemoteToolGroupPermission(f.prisma, { serverId: "atlassian", group: "read", permission: "ask", actor: owner }, T0);
    expect(out).toMatchObject({ ok: true, skipped: ["getConfluencePage"] });
    expect(permissionOf(f.rows.get(`atlassian|${READ}`)!)).toBe("ask");
    expect(permissionOf(f.rows.get("atlassian|getVisibleJiraProjects")!)).toBe("ask");
    expect(permissionOf(f.rows.get("atlassian|getConfluencePage")!)).toBe("always");
  });

  it("an admin loosening any one tool refuses the whole group", async () => {
    const f = await discovered({ tools: [READ, "getVisibleJiraProjects"] });
    await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: READ, permission: "block", actor: owner }, T0);
    const out = await setRemoteToolGroupPermission(f.prisma, { serverId: "atlassian", group: "read", permission: "ask", actor: admin }, T0);
    expect(out).toMatchObject({ ok: false, code: "ADMIN_CAN_ONLY_TIGHTEN" });
    expect(permissionOf(f.rows.get("atlassian|getVisibleJiraProjects")!)).toBe("always");
  });

  it("a write group cannot be 'always'", async () => {
    const f = await discovered();
    expect(await setRemoteToolGroupPermission(f.prisma, { serverId: "atlassian", group: "write", permission: "always", actor: owner })).toMatchObject({
      ok: false, code: "PERMISSION_NOT_ALLOWED_FOR_GRADE",
    });
  });
});

describe("a changed definition resets to the grade default and keeps a block", () => {
  it("per grade; a blocked tool stays blocked", async () => {
    const f = await discovered({ hash: "1".repeat(64) });
    // people have decided: the read is 'ask', the write is blocked
    await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: READ, permission: "ask", actor: owner }, T0);
    await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: WRITE, permission: "block", actor: owner }, T0);
    const out = await recordDiscoveredRemoteTools(
      f.prisma,
      "atlassian",
      [READ, WRITE, DESTRUCTIVE].map((wireName) => ({ wireName, description: `${wireName} desc`, inputSchemaHash: "2".repeat(64) })),
      T0,
      { gradeOf: remoteToolGradeOf },
    );
    expect(out.reset.sort()).toEqual([READ, WRITE, DESTRUCTIVE].sort());
    // read: the grade default (no thumbs-up), review cleared, switched off until re-reviewed
    expect(f.rows.get(`atlassian|${READ}`)).toMatchObject({
      grade: "READ", requiresWrite: false, requiresConfirmation: false, allowlisted: false, definitionStatus: "CHANGED", reviewedBy: null,
    });
    // the block is final
    expect(f.rows.get(`atlassian|${WRITE}`)).toMatchObject({ denied: true, definitionStatus: "CHANGED", reviewedBy: "romain" });
    expect(f.rows.get(`atlassian|${DESTRUCTIVE}`)).toMatchObject({ denied: true });
  });

  it("a write that was asking goes back to ask, still off until a person sets it again", async () => {
    const f = await discovered({ hash: "1".repeat(64) });
    await recordDiscoveredRemoteTools(f.prisma, "atlassian", [{ wireName: WRITE, description: `${WRITE} desc`, inputSchemaHash: "2".repeat(64) }], T0, {
      gradeOf: remoteToolGradeOf,
    });
    expect(f.rows.get(`atlassian|${WRITE}`)).toMatchObject({ requiresWrite: true, requiresConfirmation: true, allowlisted: false, definitionStatus: "CHANGED" });
    const again = await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: WRITE, permission: "ask", actor: owner }, T0);
    expect(again).toMatchObject({ ok: true });
    expect(f.rows.get(`atlassian|${WRITE}`)).toMatchObject({ definitionStatus: "CURRENT", allowlisted: true });
  });
});

// ── dispatch through the real vendor policy and the real interceptor ────────────

function tool(name: string): McpToolDescriptor {
  return { name, description: `${name} desc`, inputSchema: { type: "object" } };
}
const remotePort = (): McpClientPort & { callTool: ReturnType<typeof vi.fn> } => ({
  isStarted: true,
  listTools: vi.fn(async () => [tool(READ), tool(WRITE), tool(DESTRUCTIVE)]),
  callTool: vi.fn(async () => ({ content: [{ type: "text", text: "{}" }], isError: false })),
});
const parse = (res: { content: { text?: string }[] }) => JSON.parse(res.content[0]!.text ?? "{}");

async function dispatchRig() {
  const f = await discovered();
  const cache = new RemoteToolClassificationCache();
  await cache.refresh(f.prisma);
  const policy = withRemoteAllowlist(
    cache.lookup,
    composeRemoteCallPolicy({ lookup: cache.lookup, table: remoteToolTablePolicy, tableSpeaksFor: remoteToolTableExists }),
  );
  const mux = new McpToolMultiplexer(
    { isStarted: true, listTools: async () => [], callTool: vi.fn() } as unknown as McpClientPort,
    { isServerAllowed: () => true, remoteCallPolicy: policy, writeInterceptor: createToolCallInterceptor() },
  );
  const remote = remotePort();
  mux.attachRemote("atlassian", remote);
  await mux.listTools();
  const set = async (toolName: string, permission: RemoteToolPermission) => {
    await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName, permission, actor: owner }, T0);
    await cache.refresh(f.prisma);
  };
  return { mux, remote, set };
}

describe("dispatch", () => {
  it("a read runs automatically (the default)", async () => {
    const { mux, remote } = await dispatchRig();
    expect((await mux.callTool(`atlassian__${READ}`, { key: "A-1" })).isError).toBe(false);
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("ask on a write: the existing approval challenge, then approve runs the call ONCE with the same args", async () => {
    const { mux, remote } = await dispatchRig();
    const args = { summary: "x" };
    const first = parse(await mux.callTool(`atlassian__${WRITE}`, args));
    expect(first.status).toBe("confirmation_required");
    expect(first.error.message).toContain("writes");
    expect(remote.callTool).not.toHaveBeenCalled();
    const token = first.error.details.interceptor.confirmationToken as string;

    const ok = await mux.callTool(`atlassian__${WRITE}`, args, { confirmationToken: token });
    expect(ok.isError).toBe(false);
    expect(remote.callTool).toHaveBeenCalledTimes(1);
    expect(remote.callTool).toHaveBeenCalledWith(WRITE, args);
    // the token is spent: a replay is refused and nothing runs twice
    expect(parse(await mux.callTool(`atlassian__${WRITE}`, args, { confirmationToken: token })).error.code).toBe("CONFIRMATION_REJECTED");
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("block: REMOTE_TOOL_DENIED with status blocked, and nothing is dialed", async () => {
    const { mux, remote, set } = await dispatchRig();
    await set(WRITE, "block");
    await set(READ, "block");
    for (const name of [WRITE, READ]) {
      const res = await mux.callTool(`atlassian__${name}`, {});
      expect(res.isError).toBe(true);
      expect(parse(res)).toMatchObject({ status: "blocked", error: "REMOTE_TOOL_DENIED" });
    }
    expect(remote.callTool).not.toHaveBeenCalled();
  });

  it("a destructive tool is blocked by default and cannot be set to ask", async () => {
    const { mux, remote, set } = await dispatchRig();
    expect(parse(await mux.callTool(`atlassian__${DESTRUCTIVE}`, {}))).toMatchObject({ status: "blocked" });
    const f = await discovered();
    expect(await setRemoteToolPermission(f.prisma, { serverId: "atlassian", toolName: DESTRUCTIVE, permission: "ask", actor: owner })).toMatchObject({
      ok: false, code: "PERMISSION_NOT_ALLOWED_FOR_GRADE",
    });
    await set(DESTRUCTIVE, "block");
    expect(remote.callTool).not.toHaveBeenCalled();
  });

  it("a destructive row that somehow lost its block still never runs (grade is the floor)", () => {
    const cache = new RemoteToolClassificationCache();
    cache.seed([
      {
        serverId: "atlassian", toolName: DESTRUCTIVE, grade: "DESTRUCTIVE", requiresWrite: true, requiresConfirmation: true,
        denied: false, allowlisted: true, reviewedBy: "x", reviewedAt: T0, wireDescription: null, firstSeenAt: T0, lastSeenAt: T0,
      },
    ]);
    const policy = composeRemoteCallPolicy({ lookup: cache.lookup, table: () => ({ kind: "allow" }) });
    expect(policy({ serverId: "atlassian", wireName: DESTRUCTIVE, namespacedName: `atlassian__${DESTRUCTIVE}`, args: {} })).toMatchObject({
      kind: "deny", code: "REMOTE_WRITE_NOT_PERMITTED",
    });
  });

  it("a read set to ask uses the same card, and says it reads", async () => {
    const { mux, remote, set } = await dispatchRig();
    await set(READ, "ask");
    const first = parse(await mux.callTool(`atlassian__${READ}`, { key: "A-1" }));
    expect(first.status).toBe("confirmation_required");
    expect(first.error.message).toContain("reads");
    expect(first.error.message).not.toContain("writes");
    expect(remote.callTool).not.toHaveBeenCalled();
  });

  it("'always' on a write is not a state: even a hand-edited row cannot run a table write unconfirmed", () => {
    const cache = new RemoteToolClassificationCache();
    cache.seed([
      {
        serverId: "atlassian", toolName: WRITE, grade: "WRITE", requiresWrite: false, requiresConfirmation: false,
        denied: false, allowlisted: true, reviewedBy: "x", reviewedAt: T0, wireDescription: null, firstSeenAt: T0, lastSeenAt: T0,
      },
    ]);
    const policy = composeRemoteCallPolicy({ lookup: cache.lookup, table: remoteToolTablePolicy, tableSpeaksFor: remoteToolTableExists });
    expect(policy({ serverId: "atlassian", wireName: WRITE, namespacedName: `atlassian__${WRITE}`, args: {} })).toMatchObject({
      kind: "deny", code: "REMOTE_WRITE_NOT_PERMITTED",
    });
  });

  it("a tool the server's table does not list stays denied, even with an 'ask' row", () => {
    const cache = new RemoteToolClassificationCache();
    cache.seed([
      {
        serverId: "atlassian", toolName: "someNewAtlassianTool", grade: "WRITE", requiresWrite: true, requiresConfirmation: true,
        denied: false, allowlisted: true, reviewedBy: null, reviewedAt: null, wireDescription: null, firstSeenAt: T0, lastSeenAt: T0,
      },
    ]);
    const policy = composeRemoteCallPolicy({ lookup: cache.lookup, table: remoteToolTablePolicy, tableSpeaksFor: remoteToolTableExists });
    expect(policy({ serverId: "atlassian", wireName: "someNewAtlassianTool", namespacedName: "atlassian__someNewAtlassianTool", args: {} })).toMatchObject({
      kind: "deny", code: "REMOTE_TOOL_NOT_CLASSIFIED",
    });
  });
});

describe("role gates are unchanged by a permission", () => {
  beforeEach(() => remoteToolClassificationCache.seed([]));
  const row = (toolName: string, over: Record<string, unknown>) => ({
    serverId: "atlassian", toolName, requiresWrite: false, requiresConfirmation: false, denied: false, allowlisted: true,
    reviewedBy: null, reviewedAt: null, wireDescription: null, firstSeenAt: T0, lastSeenAt: T0, ...over,
  });

  it("a member still loses a write that asks; the owner and admin keep it; a guest gets no remote tool at all", () => {
    remoteToolClassificationCache.seed([
      row(WRITE, { grade: "WRITE", requiresWrite: true, requiresConfirmation: true }),
      row(READ, { grade: "READ" }),
    ] as never);
    const w = `atlassian__${WRITE}`;
    const r = `atlassian__${READ}`;
    expect(toolAllowedForTier(w, "family")).toBe(false);
    expect(toolAllowedForTier(w, "owner")).toBe(true);
    expect(toolAllowedForTier(w, "admin")).toBe(true);
    expect(toolAllowedForTier(r, "family")).toBe(true);
    expect(toolAllowedForTier(w, "guest")).toBe(false);
    expect(toolAllowedForTier(r, "guest")).toBe(false);
    remoteToolClassificationCache.seed([]);
  });
});
