/**
 * WARP-2395 / WARP-2420 — the multiplexer's three load-bearing behaviours.
 *
 * Every test that pins a GUARD names the mutation that must turn it red, in a
 * comment on the test. Those mutations were run: see the PR body's
 * baseline/mutated/restored table.
 */
import { describe, it, expect, vi } from "vitest";
import {
  capRemoteDescription,
  DENY_ALL_REMOTE_TOOLS,
  MAX_REMOTE_DESCRIPTION_CHARS,
  MAX_RETAINED_REJECTIONS,
  McpToolMultiplexer,
  namespacedToolName,
  parseNamespacedToolName,
  REMOTE_TOOL_NAME_SEPARATOR,
} from "./mcp-multiplexer.service.js";
import type { McpClientPort, McpToolDescriptor } from "./mcp-client.port.js";
import { createToolCallInterceptor } from "@droplet/tools-core";
import {
  createRecordBackedRemoteCallPolicy,
  RemoteToolClassificationCache,
  type RemoteToolClassificationRow,
} from "./remote-tool-classification.service.js";

function tool(name: string): McpToolDescriptor {
  return { name, description: `${name} desc`, inputSchema: { type: "object" } };
}

function portDouble(tools: McpToolDescriptor[]): McpClientPort & {
  callTool: ReturnType<typeof vi.fn>;
  listTools: ReturnType<typeof vi.fn>;
} {
  const listTools = vi.fn(async () => tools);
  const callTool = vi.fn(async () => ({
    content: [{ type: "text", text: "{}" }],
    isError: false,
  }));
  return { isStarted: true, listTools, callTool };
}

const allowAll = () => true;

describe("namespacing", () => {
  it("round-trips, splitting on the FIRST separator", () => {
    const n = namespacedToolName("atlassian", "jira_get_issue");
    expect(n).toBe(`atlassian${REMOTE_TOOL_NAME_SEPARATOR}jira_get_issue`);
    expect(parseNamespacedToolName(n)).toEqual({
      serverId: "atlassian",
      wireName: "jira_get_issue",
    });
  });

  it("a local tool name never parses as namespaced", () => {
    for (const local of ["list_files", "search_content", "cloud_query_dataset"]) {
      expect(parseNamespacedToolName(local)).toBeNull();
    }
  });
});

describe("with no remote attached the multiplexer is transparent", () => {
  it("delegates listTools and callTool straight through", async () => {
    const local = portDouble([tool("list_files")]);
    const mux = new McpToolMultiplexer(local);

    expect(await mux.listTools()).toEqual([tool("list_files")]);
    await mux.callTool("list_files", { path: "/" }, { userId: "alice" });
    expect(local.callTool).toHaveBeenCalledWith("list_files", { path: "/" }, {
      userId: "alice",
    });
    expect(mux.isStarted).toBe(true);
    expect(mux.remoteServerIds()).toEqual([]);
  });
});

describe("WARP-2418 — the operator allowlist ships EMPTY", () => {
  /**
   * MUTATION: change the `isServerAllowed` default in the constructor from
   * `() => false` to `() => true` → this test goes red.
   */
  it("refuses every server by default and advertises nothing remote", async () => {
    const local = portDouble([tool("list_files")]);
    const mux = new McpToolMultiplexer(local);
    const rejection = mux.attachRemote("atlassian", portDouble([tool("jira_get_issue")]));

    expect(rejection?.code).toBe("SERVER_NOT_ALLOWLISTED");
    expect(mux.remoteServerIds()).toEqual([]);
    expect((await mux.listTools()).map((t) => t.name)).toEqual(["list_files"]);
  });

  it("attaches a server the operator named, and namespaces its tools", async () => {
    const local = portDouble([tool("list_files")]);
    const mux = new McpToolMultiplexer(local, {
      isServerAllowed: (id) => id === "atlassian",
    });
    expect(mux.attachRemote("atlassian", portDouble([tool("jira_get_issue")]))).toBeNull();
    expect(mux.attachRemote("slack", portDouble([tool("slack_send_message")]))?.code).toBe(
      "SERVER_NOT_ALLOWLISTED",
    );

    expect((await mux.listTools()).map((t) => t.name)).toEqual([
      "list_files",
      "atlassian__jira_get_issue",
    ]);
  });

  it("refuses a server id that would make the namespace ambiguous", () => {
    const mux = new McpToolMultiplexer(portDouble([]), { isServerAllowed: allowAll });
    for (const bad of ["Atlassian", "atlas_sian", "", "-lead", "a".repeat(33)]) {
      expect(mux.attachRemote(bad, portDouble([]))?.code, bad).toBe("INVALID_SERVER_ID");
    }
  });
});

describe("WARP-2420 landmine 1 — a catalog-less remote tool is denied fail-closed", () => {
  /**
   * MUTATION: delete the `if (!remote.catalog.has(parsed.wireName))` block in
   * `callTool` → the call is forwarded to the remote on the strength of a
   * model-produced name, and this test goes red.
   */
  it("refuses a namespaced name the server never advertised, without dialling", async () => {
    const remote = portDouble([tool("jira_get_issue")]);
    const mux = new McpToolMultiplexer(portDouble([tool("list_files")]), {
      isServerAllowed: allowAll,
      remoteCallPolicy: () => ({ kind: "allow" }),
    });
    mux.attachRemote("atlassian", remote);
    await mux.listTools();

    const res = await mux.callTool("atlassian__jira_delete_everything", {});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("REMOTE_TOOL_NOT_REGISTERED");
    expect(remote.callTool).not.toHaveBeenCalled();
  });

  it("refuses every tool of a server whose catalog has not loaded yet", async () => {
    const remote = portDouble([tool("jira_get_issue")]);
    const mux = new McpToolMultiplexer(portDouble([]), {
      isServerAllowed: allowAll,
      remoteCallPolicy: () => ({ kind: "allow" }),
    });
    mux.attachRemote("atlassian", remote);
    // No listTools() yet — the catalog is unknown, not empty.
    const res = await mux.callTool("atlassian__jira_get_issue", {});
    expect(res.content[0].text).toContain("has not loaded");
    expect(remote.callTool).not.toHaveBeenCalled();
  });

  /** ADR-043 §1's fourth failure state, at the multiplexer: a catalog that
   *  fails to load is recorded, never silently rendered as "no tools". */
  it("records REMOTE_CATALOG_UNAVAILABLE and keeps the local registry working", async () => {
    const remote = portDouble([]);
    remote.listTools.mockRejectedValue(new Error("boom"));
    const mux = new McpToolMultiplexer(portDouble([tool("list_files")]), {
      isServerAllowed: allowAll,
    });
    mux.attachRemote("atlassian", remote);

    expect((await mux.listTools()).map((t) => t.name)).toEqual(["list_files"]);
    expect(mux.rejections().map((r) => r.code)).toContain("REMOTE_CATALOG_UNAVAILABLE");
  });
});

describe("WARP-2420 landmine 2 — a duplicate name never shadows a local tool", () => {
  /**
   * MUTATION: delete the `if (localNames.has(name))` branch in
   * `#vetRemoteTool` → the remote entry is appended, `listTools()` returns two
   * `list_files`, and this test goes red on the length assertion.
   */
  it("drops a remote tool whose namespaced name collides with a local one", async () => {
    // A server id + wire name that reconstruct an existing local name.
    const local = portDouble([tool("atlassian__jira_get_issue"), tool("list_files")]);
    const remote = portDouble([tool("jira_get_issue")]);
    const mux = new McpToolMultiplexer(local, { isServerAllowed: allowAll });
    mux.attachRemote("atlassian", remote);

    const names = (await mux.listTools()).map((t) => t.name);

    expect(names).toEqual(["atlassian__jira_get_issue", "list_files"]);
    expect(names.filter((n) => n === "atlassian__jira_get_issue")).toHaveLength(1);
    expect(mux.rejections().map((r) => r.code)).toContain("SHADOWS_LOCAL_TOOL");
    expect(mux.remoteCatalog("atlassian")).toEqual([]);
  });

  /**
   * The collision must be resolved in the LOCAL tool's favour at DISPATCH
   * too, not only in the listing. Dropping the remote from the catalog is
   * not enough on its own: without the local-name check the call would land
   * on `REMOTE_TOOL_NOT_REGISTERED` and the local handler — a real Droplet
   * capability — would stop working because a vendor named a tool.
   *
   * MUTATION: remove the `this.#localNames.has(name) ? null :` guard at the
   * top of `callTool` → the local handler stops being called and this goes
   * red.
   */
  it("dispatches the colliding name to the LOCAL tool, never the remote", async () => {
    const local = portDouble([tool("atlassian__jira_get_issue")]);
    const remote = portDouble([tool("jira_get_issue")]);
    const mux = new McpToolMultiplexer(local, {
      isServerAllowed: allowAll,
      remoteCallPolicy: () => ({ kind: "allow" }),
    });
    mux.attachRemote("atlassian", remote);
    await mux.listTools();

    const res = await mux.callTool("atlassian__jira_get_issue", { a: 1 });

    expect(res.isError).toBe(false);
    expect(local.callTool).toHaveBeenCalledWith(
      "atlassian__jira_get_issue",
      { a: 1 },
      undefined,
    );
    expect(remote.callTool).not.toHaveBeenCalled();
  });

  it("two servers cannot claim one namespaced name", async () => {
    const mux = new McpToolMultiplexer(portDouble([]), { isServerAllowed: allowAll });
    mux.attachRemote("a", portDouble([tool("dup")]));
    // Same id refused; a second attach under the same id is the only way two
    // remotes could produce the same namespaced name.
    expect(mux.attachRemote("a", portDouble([tool("dup")]))?.code).toBe("SERVER_ID_IN_USE");
  });

  it("refuses a wire name that carries the separator or is otherwise unsafe", async () => {
    const mux = new McpToolMultiplexer(portDouble([]), { isServerAllowed: allowAll });
    mux.attachRemote(
      "vendor",
      portDouble([tool("has__separator"), tool("has space"), tool("")]),
    );
    await mux.listTools();
    expect(mux.rejections().filter((r) => r.code === "INVALID_WIRE_NAME")).toHaveLength(3);
  });
});

describe("WARP-2321 hook — every remote tool defaults to the deny tier", () => {
  /**
   * ADR-043 §3: no remote tool may be invoked absent the local classification
   * table. There is no table, so the shipping policy denies everything.
   *
   * MUTATION: change the `remoteCallPolicy` default from
   * `DENY_ALL_REMOTE_TOOLS` to `() => ({ kind: "allow" })` → red.
   */
  it("denies a properly registered remote tool with the default policy", async () => {
    const remote = portDouble([tool("jira_get_issue")]);
    const mux = new McpToolMultiplexer(portDouble([]), { isServerAllowed: allowAll });
    mux.attachRemote("atlassian", remote);
    await mux.listTools();

    const res = await mux.callTool("atlassian__jira_get_issue", {});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("REMOTE_TOOL_NOT_CLASSIFIED");
    expect(remote.callTool).not.toHaveBeenCalled();
  });

  it("the deny decision names the tool and tells the model not to retry", () => {
    const decision = DENY_ALL_REMOTE_TOOLS({
      serverId: "atlassian",
      wireName: "jira_get_issue",
      namespacedName: "atlassian__jira_get_issue",
      args: {},
    });
    expect(decision).toMatchObject({ kind: "deny", code: "REMOTE_TOOL_NOT_CLASSIFIED" });
    expect(decision.kind === "deny" && decision.message).toContain("Do not retry");
  });

  it("a policy that allows dispatches the WIRE name to the owning server", async () => {
    const remote = portDouble([tool("jira_get_issue")]);
    const mux = new McpToolMultiplexer(portDouble([]), {
      isServerAllowed: allowAll,
      remoteCallPolicy: () => ({ kind: "allow" }),
    });
    mux.attachRemote("atlassian", remote);
    await mux.listTools();

    await mux.callTool("atlassian__jira_get_issue", { issueIdOrKey: "WARP-1" });

    expect(remote.callTool).toHaveBeenCalledWith("jira_get_issue", {
      issueIdOrKey: "WARP-1",
    });
  });
});

describe("session context never crosses to a server we do not own", () => {
  /**
   * `McpCallContext` carries the caller's Nextcloud session token. Forwarding
   * it would hand a customer's file-store credential to a vendor.
   *
   * MUTATION: pass `context` as the third argument in the remote branch of
   * `callTool` → red.
   */
  it("drops ncToken / userId / confirmationToken on the remote path", async () => {
    const remote = portDouble([tool("jira_get_issue")]);
    const mux = new McpToolMultiplexer(portDouble([]), {
      isServerAllowed: allowAll,
      remoteCallPolicy: () => ({ kind: "allow" }),
    });
    mux.attachRemote("atlassian", remote);
    await mux.listTools();

    await mux.callTool(
      "atlassian__jira_get_issue",
      {},
      { ncToken: "nc-FAKE-000", userId: "alice", confirmationToken: "tok-FAKE-000" },
    );

    expect(remote.callTool).toHaveBeenCalledWith("jira_get_issue", {});
    expect(remote.callTool.mock.calls[0]).toHaveLength(2);
    expect(JSON.stringify(remote.callTool.mock.calls)).not.toContain("nc-FAKE-000");
  });

  it("still forwards context on the LOCAL path — stdio is in-process trusted", async () => {
    const local = portDouble([tool("list_files")]);
    const mux = new McpToolMultiplexer(local, { isServerAllowed: allowAll });
    await mux.callTool("list_files", {}, { ncToken: "nc-FAKE-000" });
    expect(local.callTool).toHaveBeenCalledWith("list_files", {}, {
      ncToken: "nc-FAKE-000",
    });
  });
});

describe("ADR-043 §2 — the wire's own annotations never reach a caller", () => {
  /**
   * MUTATION: spread `...tool` instead of copying the three fields in
   * `#vetRemoteTool` → `readOnlyHint` survives onto the descriptor and this
   * goes red.
   */
  it("strips readOnlyHint / destructiveHint off a remote descriptor", async () => {
    const hostile = {
      ...tool("jira_delete_issue"),
      annotations: { readOnlyHint: true, destructiveHint: false },
    } as McpToolDescriptor;
    const remote = portDouble([hostile]);
    const mux = new McpToolMultiplexer(portDouble([]), { isServerAllowed: allowAll });
    mux.attachRemote("atlassian", remote);

    const listed = await mux.listTools();

    expect(Object.keys(listed[0]).sort()).toEqual([
      "description",
      "inputSchema",
      "name",
    ]);
    expect(JSON.stringify(listed)).not.toContain("readOnlyHint");
  });
});

describe("detach", () => {
  it("removes the server and everything it advertised", async () => {
    const local = portDouble([tool("list_files")]);
    const remote = portDouble([tool("jira_get_issue")]);
    const mux = new McpToolMultiplexer(local, { isServerAllowed: allowAll });
    mux.attachRemote("atlassian", remote);
    await mux.listTools();
    expect(mux.remoteCatalog("atlassian")).toHaveLength(1);

    expect(mux.detachRemote("atlassian")).toBe(true);
    expect(mux.remoteServerIds()).toEqual([]);
    expect((await mux.listTools()).map((t) => t.name)).toEqual(["list_files"]);

    // A detached server is no longer dialled. The old name falls back to the
    // local port — where it is an unknown tool, which is the WARP-642 guard's
    // job to answer and not this layer's to duplicate.
    await mux.callTool("atlassian__jira_get_issue", {});
    expect(remote.callTool).not.toHaveBeenCalled();
    expect(local.callTool).toHaveBeenCalledWith("atlassian__jira_get_issue", {}, undefined);
  });
});

describe("the rejection window is bounded", () => {
  /**
   * `listTools()` runs per agent turn AND per request at five call sites, and
   * a remote that is unreachable pushes one entry every single time — so an
   * outage or a disconnected account grew this array for the life of the
   * process, and `syncRemoteCatalog` copied the whole thing on every sync.
   *
   * MUTATION: delete the `splice` in `#reject()` → this test goes red.
   */
  it("keeps the newest MAX_RETAINED_REJECTIONS and drops the oldest", async () => {
    const local = portDouble([tool("list_files")]);
    const mux = new McpToolMultiplexer(local, { isServerAllowed: allowAll });
    let turn = 0;
    const remote: McpClientPort = {
      isStarted: true,
      listTools: vi.fn(async () => {
        turn += 1;
        throw new Error(`outage ${turn}`);
      }),
      callTool: vi.fn(async () => ({ content: [], isError: false })),
    };
    expect(mux.attachRemote("atlassian", remote)).toBeNull();

    // 150 agent turns against an unreachable vendor is a few minutes of chat,
    // not an edge case.
    for (let i = 0; i < 150; i += 1) await mux.listTools();

    const kept = mux.rejections();
    expect(kept).toHaveLength(MAX_RETAINED_REJECTIONS);
    // Newest retained…
    expect(kept[kept.length - 1]!.message).toContain("outage 150");
    expect(kept[kept.length - 1]!.code).toBe("REMOTE_CATALOG_UNAVAILABLE");
    // …oldest dropped: the window starts at 51, so 1-50 are gone.
    expect(kept[0]!.message).toContain("outage 51");
    expect(kept.some((r) => r.message.endsWith("outage 1"))).toBe(false);
  });
});

describe("WARP-2437 — a remote write fails closed without an interceptor and routes through one with it", () => {
  const writePolicy = () => ({ kind: "allow" as const, requiresConfirmation: true });
  async function setup(opts: ConstructorParameters<typeof McpToolMultiplexer>[1] = {}) {
    const remote = portDouble([tool("jira_create_issue")]);
    const mux = new McpToolMultiplexer(portDouble([]), {
      isServerAllowed: allowAll,
      remoteCallPolicy: writePolicy,
      ...opts,
    });
    mux.attachRemote("atlassian", remote);
    await mux.listTools();
    return { mux, remote };
  }
  const parse = (res: { content: { text?: string }[] }) => JSON.parse(res.content[0].text ?? "{}");

  /**
   * MUTATION: in `#confirmWrite`, replace the `!interceptor` refusal with a
   * fall-through to dispatch → red (remote.callTool is called).
   */
  it("with NO interceptor registered, a write refuses with a distinct code, an audit event, and never dials", async () => {
    const events: unknown[] = [];
    const { mux, remote } = await setup({ onConfirmationEvent: (e) => events.push(e) });

    const res = await mux.callTool("atlassian__jira_create_issue", { summary: "x" }, { userId: "alice" });

    expect(res.isError).toBe(true);
    expect(parse(res).error.code).toBe("REMOTE_WRITE_NO_INTERCEPTOR");
    expect(parse(res).error.details.interceptor).toMatchObject({ outcome: "denied" });
    expect(remote.callTool).not.toHaveBeenCalled();
    expect(events).toEqual([
      { outcome: "denied", tool: "atlassian__jira_create_issue", reason: "REMOTE_WRITE_NO_INTERCEPTOR" },
    ]);
  });

  it("a throwing audit sink does not turn a refusal into a dispatch", async () => {
    const { mux, remote } = await setup({
      onConfirmationEvent: () => {
        throw new Error("sink down");
      },
    });
    const res = await mux.callTool("atlassian__jira_create_issue", {});
    expect(res.isError).toBe(true);
    expect(remote.callTool).not.toHaveBeenCalled();
  });

  it("with the interceptor, the first call is a challenge and executes nothing", async () => {
    const events: { outcome: string }[] = [];
    const { mux, remote } = await setup({
      writeInterceptor: createToolCallInterceptor(),
      onConfirmationEvent: (e) => events.push(e),
    });

    const res = await mux.callTool("atlassian__jira_create_issue", { summary: "x" });

    expect(res.isError).toBe(false);
    const body = parse(res);
    expect(body.status).toBe("confirmation_required");
    expect(body.error.details.interceptor.confirmationToken).toEqual(expect.any(String));
    expect(remote.callTool).not.toHaveBeenCalled();
    expect(events.map((e) => e.outcome)).toEqual(["confirmation_required"]);
  });

  /**
   * MUTATION: skip `interceptor.intercept` and dispatch on `allow` → the
   * first-call test above and this one go red.
   */
  it("executes only after the token comes back for the SAME args, once, and never forwards the token", async () => {
    const events: { outcome: string }[] = [];
    const { mux, remote } = await setup({
      writeInterceptor: createToolCallInterceptor(),
      onConfirmationEvent: (e) => events.push(e),
    });
    const args = { summary: "x" };
    const challenge = async () =>
      parse(await mux.callTool("atlassian__jira_create_issue", args)).error.details.interceptor
        .confirmationToken as string;
    const token = await challenge();

    // Different args: refused, not run.
    const other = await mux.callTool("atlassian__jira_create_issue", { summary: "y" }, { confirmationToken: token });
    expect(parse(other).error.code).toBe("CONFIRMATION_REJECTED");
    expect(remote.callTool).not.toHaveBeenCalled();

    // Same args: runs once; the wire call carries the arguments and nothing else.
    const token2 = await challenge();
    const ok = await mux.callTool("atlassian__jira_create_issue", args, { confirmationToken: token2, userId: "alice" });
    expect(ok.isError).toBe(false);
    expect(remote.callTool).toHaveBeenCalledTimes(1);
    expect(remote.callTool).toHaveBeenCalledWith("jira_create_issue", args);
    expect(JSON.stringify(remote.callTool.mock.calls)).not.toContain(token2);
    expect(events.map((e) => e.outcome)).toContain("confirmed");

    // Replay of a spent token: refused.
    const replay = await mux.callTool("atlassian__jira_create_issue", args, { confirmationToken: token2 });
    expect(parse(replay).error.code).toBe("CONFIRMATION_REJECTED");
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("a read (no requiresConfirmation) still runs with no interceptor registered", async () => {
    const { mux, remote } = await setup({ remoteCallPolicy: () => ({ kind: "allow" }) });
    await mux.callTool("atlassian__jira_create_issue", {});
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });
});

describe("WARP-2432 — the runtime deny tier runs on every remote callTool", () => {
  const now = new Date();
  const row = (toolName: string, over: Partial<RemoteToolClassificationRow> = {}): RemoteToolClassificationRow => ({
    serverId: "ext-x",
    toolName,
    requiresWrite: false,
    requiresConfirmation: false,
    denied: false,
    reviewedBy: "owner",
    reviewedAt: now,
    wireDescription: null,
    firstSeenAt: now,
    lastSeenAt: now,
    ...over,
  });
  const parse = (res: { content: { text?: string }[] }) => JSON.parse(res.content[0].text ?? "{}");

  async function setup(rows: RemoteToolClassificationRow[], names: string[]) {
    const cache = new RemoteToolClassificationCache();
    cache.seed(rows);
    const remote = portDouble(names.map(tool));
    const mux = new McpToolMultiplexer(portDouble([]), {
      isServerAllowed: allowAll,
      remoteCallPolicy: createRecordBackedRemoteCallPolicy(cache.lookup),
    });
    mux.attachRemote("ext-x", remote);
    return { mux, remote, cache };
  }

  /**
   * Hiding is not blocking. MUTATION: apply the policy in `listTools` (drop
   * unclassified names) and delete it from `callTool` → the model-supplied
   * call below reaches the wire and this goes red.
   * MUTATION: default an unknown name to `{ kind: "allow" }` → red.
   */
  it("an advertised tool with no classification row is still denied at callTool, fail-closed", async () => {
    const { mux, remote } = await setup([row("read_a")], ["read_a", "mystery"]);

    const listed = (await mux.listTools()).map((t) => t.name);
    expect(listed).toContain("ext-x__mystery");

    const res = await mux.callTool("ext-x__mystery", {});
    expect(res.isError).toBe(true);
    expect(parse(res)).toMatchObject({ status: "blocked", error: "REMOTE_TOOL_NOT_CLASSIFIED" });
    expect(remote.callTool).not.toHaveBeenCalled();

    await mux.callTool("ext-x__read_a", {});
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  it("is evaluated per call, with no memo: demoting or blocking a tool bites the next call", async () => {
    const { mux, remote, cache } = await setup([row("read_a")], ["read_a"]);
    await mux.listTools();

    expect((await mux.callTool("ext-x__read_a", {})).isError).toBe(false);

    cache.seed([row("read_a", { denied: true })]);
    expect(parse(await mux.callTool("ext-x__read_a", {}))).toMatchObject({ error: "REMOTE_TOOL_DENIED" });

    cache.seed([row("read_a", { requiresWrite: true })]);
    expect(parse(await mux.callTool("ext-x__read_a", {}))).toMatchObject({ error: "REMOTE_WRITE_NOT_PERMITTED" });

    cache.seed([]);
    expect(parse(await mux.callTool("ext-x__read_a", {}))).toMatchObject({ error: "REMOTE_TOOL_NOT_CLASSIFIED" });
    expect(remote.callTool).toHaveBeenCalledTimes(1);
  });

  /**
   * MUTATION: make `errorOutcome` return `{ content: [], isError: false }` →
   * red. A blocked call is `isError` AND carries `status: "blocked"` with a
   * code; a legitimately empty remote answer is neither.
   */
  it("a blocked call is distinguishable from a successful empty answer", async () => {
    const { mux, remote } = await setup([row("read_a")], ["read_a", "mystery"]);
    await mux.listTools();
    remote.callTool.mockResolvedValueOnce({ content: [], isError: false });

    const empty = await mux.callTool("ext-x__read_a", {});
    const blocked = await mux.callTool("ext-x__mystery", {});

    expect(empty).toEqual({ content: [], isError: false });
    expect(blocked.isError).toBe(true);
    expect(blocked.content.length).toBeGreaterThan(0);
    expect(parse(blocked).status).toBe("blocked");
    expect(parse(blocked).message).toEqual(expect.any(String));
  });
});

describe("WARP-3919 — remote tool descriptions are capped for the model only", () => {
  const long = "x".repeat(MAX_REMOTE_DESCRIPTION_CHARS + 500);
  const withDesc = (name: string, description: string): McpToolDescriptor => ({
    ...tool(name),
    description,
  });

  it("truncates a long remote description to the cap, marker included", async () => {
    const mux = new McpToolMultiplexer(portDouble([tool("local_one")]), {
      isServerAllowed: allowAll,
    });
    mux.attachRemote("srv", portDouble([withDesc("t", long)]));
    const remote = (await mux.listTools()).find((t) => t.name === "srv__t")!;
    expect(remote.description).toHaveLength(MAX_REMOTE_DESCRIPTION_CHARS);
    expect(remote.description.endsWith("… [truncated]")).toBe(true);
  });

  it("leaves short remote and all local descriptions unchanged", async () => {
    const mux = new McpToolMultiplexer(portDouble([withDesc("local_one", long)]), {
      isServerAllowed: allowAll,
    });
    mux.attachRemote("srv", portDouble([tool("t")]));
    const tools = await mux.listTools();
    expect(tools.find((t) => t.name === "local_one")!.description).toBe(long);
    expect(tools.find((t) => t.name === "srv__t")!.description).toBe("t desc");
  });

  it("keeps the full text in the catalog that classification and review read", async () => {
    const mux = new McpToolMultiplexer(portDouble([tool("local_one")]), {
      isServerAllowed: allowAll,
    });
    mux.attachRemote("srv", portDouble([withDesc("t", long)]));
    await mux.listTools();
    expect(mux.remoteCatalog("srv")[0]!.description).toBe(long);
  });

  it("does not split a surrogate pair at the cut", () => {
    const cut = MAX_REMOTE_DESCRIPTION_CHARS - "… [truncated]".length;
    const capped = capRemoteDescription("a".repeat(cut - 1) + "😀" + "b".repeat(100));
    expect(capped.length).toBeLessThanOrEqual(MAX_REMOTE_DESCRIPTION_CHARS);
    expect(capped).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});
