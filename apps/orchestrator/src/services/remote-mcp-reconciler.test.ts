/**
 * WARP-2651 — both restart directions reconcile, through the REAL objects.
 *
 * Everything below the injected `fetch` is shipped code: the real
 * `McpBridgeClient`, the real gate, the real `McpToolMultiplexer`, the real
 * `attachAtlassianRemote`, the real `RemoteMcpLifecycleRegistry`. The only
 * double is the bridge container itself — and it is a MODEL of the bridge, not
 * a canned response: it holds a session map, replaces on `open`, seeds the
 * drift baseline from `knownTools` and flips to `catalog_changed` on a listing
 * that disagrees with it, exactly as `remote-session.ts` does. A fixture that
 * always answered `ready` could not tell a working reconciler from a broken one.
 *
 * Credential fixtures are obviously fake (`ATATT-FAKE-000000000000`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpBridgeClient } from "./mcp-bridge.client.js";
import { McpToolMultiplexer, type RemoteCallPolicy } from "./mcp-multiplexer.service.js";
import type { McpClientPort, McpToolDescriptor } from "./mcp-client.port.js";
import {
  ATLASSIAN_REMOTE_SERVER_ID,
  attachAtlassianRemote,
  type RemoteMcpConnectionRow,
} from "./remote-mcp-servers.js";
import { RuntimeToolRegistry } from "./runtime-tool-registry.service.js";
import { RemoteMcpLifecycleRegistry } from "./remote-mcp-lifecycle.service.js";
import {
  reconcileRemoteMcpSessions,
  type RemoteMcpReconcilerDeps,
} from "./remote-mcp-reconciler.service.js";

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

const BRIDGE_URL = "http://mcp-bridge.test:9096";
const BRIDGE_TOKEN = "bridge-token-FAKE-0000000000000000";
const FAKE_API_TOKEN = "ATATT-FAKE-000000000000";
const CONNECTION_ID = "conn_atlassian_fixture";

const TOOLS_A: McpToolDescriptor[] = [
  { name: "getJiraIssue", description: "Read one Jira issue", inputSchema: { type: "object" } },
  { name: "getConfluencePage", description: "Read one page", inputSchema: { type: "object" } },
];
/** The same surface with one tool REPLACED — ADR-043 §1's fourth failure. */
const TOOLS_DRIFTED: McpToolDescriptor[] = [
  { name: "getJiraIssue", description: "Read one Jira issue", inputSchema: { type: "object" } },
  { name: "deleteJiraIssue", description: "New and unclassified", inputSchema: { type: "object" } },
];

interface FixtureSession {
  state: string;
  /** The drift baseline, or `null` when the session has never listed and was
   *  handed no `knownTools`. */
  baseline: Set<string> | null;
  toolCount: number;
}

/**
 * A model of `services/mcp-bridge`, faithful in the three behaviours this
 * ticket turns on: `open` REPLACES, `/health` reports every session the bridge
 * holds (including ones this process never opened), and a listing that
 * disagrees with the baseline flips the session to `catalog_changed`.
 */
function fixtureBridge(initialTools: McpToolDescriptor[] = TOOLS_A) {
  const sessions = new Map<string, FixtureSession>();
  const calls: { method: string; path: string; body: unknown }[] = [];
  const state = { tools: initialTools, healthFails: false };

  const health = (id: string, s: FixtureSession) => ({
    serverId: id,
    state: s.state,
    toolCount: s.toolCount,
    consecutiveFailures: 0,
    lastReadyAt: 1,
    reason: s.state === "catalog_changed" ? "catalog_changed" : null,
  });

  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url).replace(BRIDGE_URL, "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (path === "/health") {
      // A container that is down does not answer with a status — it does not
      // answer. `fetch` rejects, which is what the client turns into
      // BRIDGE_UNREACHABLE.
      if (state.healthFails) throw new TypeError("fetch failed");
      return json(200, {
        status: "ok",
        knownServers: [ATLASSIAN_REMOTE_SERVER_ID],
        sessions: [...sessions.entries()].map(([id, s]) => health(id, s)),
      });
    }

    const m = /^\/sessions\/([a-z0-9-]+)(?:\/([a-z-]+))?$/.exec(path);
    if (!m) return json(404, { error: { code: "NOT_FOUND", message: path } });
    const id = m[1]!;
    const action = m[2];

    if (action === undefined && method === "DELETE") {
      const closed = sessions.delete(id);
      return json(200, { closed });
    }
    if (action === "open") {
      // Replacement, and the baseline is seeded from `knownTools` when the
      // caller supplied one — the WARP-2651 contract.
      const known = (body as { knownTools?: string[] } | undefined)?.knownTools;
      sessions.set(id, {
        state: "ready",
        baseline: known ? new Set(known) : null,
        toolCount: 0,
      });
      return json(200, { state: health(id, sessions.get(id)!) });
    }

    const session = sessions.get(id);
    if (!session) {
      return json(409, {
        error: { code: "SESSION_NOT_OPEN", message: `No session is open for "${id}".` },
      });
    }
    if (action === "tools") {
      const names = new Set(state.tools.map((t) => t.name));
      if (session.baseline !== null) {
        const removed = [...session.baseline].filter((n) => !names.has(n));
        const added = [...names].filter((n) => !session.baseline!.has(n));
        if (removed.length > 0 || added.length > 0) session.state = "catalog_changed";
      }
      session.baseline = names;
      session.toolCount = names.size;
      return json(200, { tools: state.tools, state: health(id, session) });
    }
    if (action === "state") return json(200, { state: health(id, session) });
    if (action === "acknowledge-catalog") {
      if (session.state === "catalog_changed") session.state = "ready";
      return json(200, { state: health(id, session) });
    }
    if (action === "call") {
      return json(200, {
        result: { content: [{ type: "text", text: "{}" }], isError: false },
        state: health(id, session),
      });
    }
    return json(404, { error: { code: "NOT_FOUND", message: path } });
  });

  return { calls, sessions, state, fetchImpl: fetchImpl as unknown as typeof fetch };
}

function localPort(): McpClientPort {
  return {
    isStarted: true,
    listTools: async () => [
      { name: "list_files", description: "local", inputSchema: { type: "object" } },
    ],
    callTool: async () => ({ content: [], isError: false }),
  };
}

const connectedRow: RemoteMcpConnectionRow = {
  id: CONNECTION_ID,
  status: "CONNECTED",
  providerTokensEnc: "dcv1:sealed",
  providerConfig: { email: "ops@vendor.example", cloudId: "00000000-0000-4000-8000-000000000000" },
};

const allowAll: RemoteCallPolicy = () => ({ kind: "allow" });

function harness(over: { allowlist?: string[]; row?: RemoteMcpConnectionRow | null } = {}) {
  const bridge = fixtureBridge();
  const allowlist = new Set(over.allowlist ?? [ATLASSIAN_REMOTE_SERVER_ID]);
  const mux = new McpToolMultiplexer(localPort(), {
    isServerAllowed: (id) => allowlist.has(id),
    remoteCallPolicy: allowAll,
  });
  const registry = new RuntimeToolRegistry();
  // ONE clock for the registry and the reconciler. Two would let the backoff be
  // armed on a different timeline from the one the tick reads it on, which is a
  // green test that proves nothing.
  const clock = { now: 1_000_000 };
  const lifecycle = new RemoteMcpLifecycleRegistry(() => clock.now);
  const prismaState = { row: over.row === undefined ? connectedRow : over.row };
  const prisma = {
    integrationConnection: { findFirst: vi.fn(async () => prismaState.row) },
  };
  const audit = vi.fn();
  /** Counts every ADR-042 open, so "the credential is re-read per re-open, and
   *  never cached between ticks" is an assertion rather than a comment. */
  const openCredentials = vi.fn(() => ({ apiToken: FAKE_API_TOKEN }));

  const attach = (knownTools?: readonly string[]) =>
    attachAtlassianRemote({
      mux,
      prisma,
      allowlist,
      registry,
      lifecycle,
      auditLifecycle: audit,
      openCredentials,
      createClient: () =>
        new McpBridgeClient({
          baseUrl: BRIDGE_URL,
          serviceToken: BRIDGE_TOKEN,
          serverId: ATLASSIAN_REMOTE_SERVER_ID,
          fetchImpl: bridge.fetchImpl,
        }),
      ...(knownTools !== undefined ? { knownTools } : {}),
    });

  const deps: RemoteMcpReconcilerDeps = {
    lifecycle,
    audit,
    now: () => clock.now,
    health: () =>
      new McpBridgeClient({
        baseUrl: BRIDGE_URL,
        serviceToken: BRIDGE_TOKEN,
        serverId: ATLASSIAN_REMOTE_SERVER_ID,
        fetchImpl: bridge.fetchImpl,
      }).health(),
    closeSession: async (serverId) => {
      await new McpBridgeClient({
        baseUrl: BRIDGE_URL,
        serviceToken: BRIDGE_TOKEN,
        serverId,
        fetchImpl: bridge.fetchImpl,
      }).close();
    },
    detach: (serverId) => {
      mux.detachRemote(serverId);
    },
    reattach: (_serverId, knownTools) => attach(knownTools),
  };

  return {
    bridge,
    mux,
    registry,
    lifecycle,
    prisma,
    prismaState,
    clock,
    audit,
    openCredentials,
    attach,
    tick: () => reconcileRemoteMcpSessions(deps),
  };
}

async function remoteToolNames(mux: McpToolMultiplexer): Promise<string[]> {
  return (await mux.listTools())
    .map((t) => t.name)
    .filter((n) => n.startsWith(`${ATLASSIAN_REMOTE_SERVER_ID}__`));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the empty allowlist is still the shipping default (gates untouched)", () => {
  it("registers nothing and the reconciler dials NOTHING — not even /health", async () => {
    const h = harness({ allowlist: [] });

    const attached = await h.attach();
    expect(attached).toMatchObject({ attached: false, reason: "not_allowlisted" });
    expect(h.lifecycle.list()).toEqual([]);

    const result = await h.tick();
    expect(result.skipped).toBe("nothing_registered");
    // The assertion that matters: ZERO calls, not "no session came back".
    expect(h.bridge.calls).toHaveLength(0);
    expect(h.bridge.fetchImpl).not.toHaveBeenCalled();
    expect(await remoteToolNames(h.mux)).toEqual([]);
  });

  it("un-registers a server the operator removed from the allowlist", async () => {
    const h = harness();
    await h.attach();
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)?.state).toBe("attached");

    // The operator empties REMOTE_MCP_SERVER_ALLOWLIST and the box reboots into
    // an attach that now refuses. Nothing is left for the reconciler to drive.
    const off = harness({ allowlist: [] });
    await off.attach();
    expect(off.lifecycle.list()).toEqual([]);
  });
});

describe("failure (2): the BRIDGE restarts, the orchestrator stays up", () => {
  it("reattaches within ONE tick and the tools come back", async () => {
    const h = harness();
    expect((await h.attach()).attached).toBe(true);
    expect(await remoteToolNames(h.mux)).toEqual([
      "atlassian__getJiraIssue",
      "atlassian__getConfluencePage",
    ]);

    // The bridge container restarts: its session store is memory-only, so every
    // session is gone while THIS process still believes it is attached.
    h.bridge.sessions.clear();
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)?.state).toBe("attached");

    const result = await h.tick();
    expect(result.reattached).toEqual([ATLASSIAN_REMOTE_SERVER_ID]);
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)?.state).toBe("attached");
    expect(h.bridge.sessions.has(ATLASSIAN_REMOTE_SERVER_ID)).toBe(true);
    expect(await remoteToolNames(h.mux)).toEqual([
      "atlassian__getJiraIssue",
      "atlassian__getConfluencePage",
    ]);
  });

  it("passes THROUGH `reattaching`, and audits both transitions", async () => {
    const h = harness();
    await h.attach();
    h.audit.mockClear();
    h.bridge.sessions.clear();

    await h.tick();

    const transitions = h.audit.mock.calls
      .map((c) => c[0] as { event: string; from?: string; to?: string })
      .filter((r) => r.event === "transition");
    expect(transitions.map((t) => `${t.from}->${t.to}`)).toEqual([
      "attached->reattaching",
      "reattaching->attached",
    ]);
  });

  it("re-reads the credential through the ADR-042 seam ON THE RE-OPEN", async () => {
    const h = harness();
    await h.attach();
    expect(h.openCredentials).toHaveBeenCalledTimes(1);

    h.bridge.sessions.clear();
    await h.tick();
    // Two opens ⇒ two seal-openings. A cached plaintext would leave this at 1,
    // and would go on using a token the customer had since rotated.
    expect(h.openCredentials).toHaveBeenCalledTimes(2);

    h.bridge.sessions.clear();
    await h.tick();
    expect(h.openCredentials).toHaveBeenCalledTimes(3);
  });

  it("does NOT re-open a session the bridge still holds", async () => {
    const h = harness();
    await h.attach();
    const opensBefore = h.bridge.calls.filter((c) => c.path.endsWith("/open")).length;

    const result = await h.tick();
    expect(result.reattached).toEqual([]);
    expect(h.bridge.calls.filter((c) => c.path.endsWith("/open"))).toHaveLength(opensBefore);
  });
});

describe("failure (1): the ORCHESTRATOR restarts, the bridge stays up", () => {
  it("closes a session this process does not own, with one audit row", async () => {
    const h = harness();
    await h.attach();

    // The account is disconnected while this process is down; on the way back
    // up the attach refuses at the gate, so the vendor connection the bridge is
    // still holding is now driven by nothing at all.
    h.prismaState.row = { ...connectedRow, status: "DISABLED" };
    await h.attach();
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toMatchObject({
      state: "detached",
      reason: "gate_refused",
    });
    expect(h.bridge.sessions.has(ATLASSIAN_REMOTE_SERVER_ID)).toBe(true);
    h.audit.mockClear();

    const result = await h.tick();
    expect(result.orphansClosed).toEqual([ATLASSIAN_REMOTE_SERVER_ID]);
    expect(h.bridge.sessions.size).toBe(0);
    expect(
      h.bridge.calls.some(
        (c) => c.method === "DELETE" && c.path === `/sessions/${ATLASSIAN_REMOTE_SERVER_ID}`,
      ),
    ).toBe(true);
    const orphanRows = h.audit.mock.calls
      .map((c) => c[0] as { event: string; serverId: string })
      .filter((r) => r.event === "orphan_session_closed");
    expect(orphanRows).toEqual([
      { serverId: ATLASSIAN_REMOTE_SERVER_ID, event: "orphan_session_closed" },
    ]);
  });

  it("closes a session for a server id this process has never heard of", async () => {
    const h = harness();
    await h.attach();
    h.bridge.sessions.set("compass", { state: "ready", baseline: null, toolCount: 3 });

    const result = await h.tick();
    expect(result.orphansClosed).toEqual(["compass"]);
    expect(h.bridge.sessions.has("compass")).toBe(false);
    // And it left OUR session alone.
    expect(h.bridge.sessions.has(ATLASSIAN_REMOTE_SERVER_ID)).toBe(true);
  });
});

describe("catalog_changed survives a re-open (ADR-043 §1's fourth failure state)", () => {
  it("does NOT silently attach a surface that moved while the bridge was down", async () => {
    const h = harness();
    expect((await h.attach()).attached).toBe(true);
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)?.vettedTools).toEqual([
      "getJiraIssue",
      "getConfluencePage",
    ]);

    // The bridge restarts AND the vendor's surface changes while it is down.
    h.bridge.sessions.clear();
    h.bridge.state.tools = TOOLS_DRIFTED;

    const result = await h.tick();

    // The re-open carried the baseline, which is the ONLY reason the bridge
    // could detect drift on a brand-new session.
    const open = h.bridge.calls.filter((c) => c.path.endsWith("/open")).at(-1);
    expect((open?.body as { knownTools?: string[] }).knownTools).toEqual([
      "getJiraIssue",
      "getConfluencePage",
    ]);
    expect(result.reattached).toEqual([]);
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toMatchObject({
      state: "detached",
      reason: "catalog_changed",
    });
    // Nothing from the changed surface reaches tool selection.
    expect(await remoteToolNames(h.mux)).toEqual([]);
    expect(h.registry.serverIds()).toEqual([]);
    // And the read-time view sends a person to the right remedy.
    expect(h.lifecycle.view(ATLASSIAN_REMOTE_SERVER_ID)).toMatchObject({
      state: "detached",
      reason: "catalog_changed",
      remediation: "review_catalog",
    });
  });

  it("is TERMINAL: the next tick neither re-opens nor sweeps the session away", async () => {
    const h = harness();
    await h.attach();
    h.bridge.sessions.clear();
    h.bridge.state.tools = TOOLS_DRIFTED;
    await h.tick();
    const opensAfterDrift = h.bridge.calls.filter((c) => c.path.endsWith("/open")).length;

    await h.tick();

    // No re-open — a fresh session's first listing has nothing to compare
    // against, so retrying IS the silent acknowledgement.
    expect(h.bridge.calls.filter((c) => c.path.endsWith("/open"))).toHaveLength(
      opensAfterDrift,
    );
    // And the session stays OPEN: closing it would destroy the drift record and
    // the acknowledge-catalog call that resolves it.
    expect(h.bridge.sessions.has(ATLASSIAN_REMOTE_SERVER_ID)).toBe(true);
    expect(
      h.bridge.calls.filter(
        (c) => c.method === "DELETE" && c.path === `/sessions/${ATLASSIAN_REMOTE_SERVER_ID}`,
      ),
    ).toHaveLength(0);
  });

  it("reports catalog_changed from the BRIDGE's side too, without re-opening", async () => {
    const h = harness();
    await h.attach();
    // The session is still there; the bridge itself noticed the drift.
    h.bridge.sessions.get(ATLASSIAN_REMOTE_SERVER_ID)!.state = "catalog_changed";
    const opensBefore = h.bridge.calls.filter((c) => c.path.endsWith("/open")).length;

    await h.tick();

    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toMatchObject({
      state: "detached",
      reason: "catalog_changed",
    });
    expect(h.bridge.calls.filter((c) => c.path.endsWith("/open"))).toHaveLength(opensBefore);
    expect(h.bridge.sessions.has(ATLASSIAN_REMOTE_SERVER_ID)).toBe(true);
  });
});

describe("the bridge hop itself fails: bounded backoff", () => {
  it("goes bridge_unreachable, then SKIPS ticks inside the window, then recovers", async () => {
    const h = harness();
    await h.attach();
    h.bridge.state.healthFails = true;
    h.audit.mockClear();

    const first = await h.tick();
    expect(first.bridgeUnreachable).toBe(true);
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toMatchObject({
      state: "bridge_unreachable",
      reason: "health_unreachable",
      consecutiveBridgeFailures: 1,
    });
    expect(h.lifecycle.view(ATLASSIAN_REMOTE_SERVER_ID)?.remediation).toBe("check_bridge");
    expect(
      h.audit.mock.calls.filter(
        (c) => (c[0] as { to?: string }).to === "bridge_unreachable",
      ),
    ).toHaveLength(1);

    // One second later: inside the 30 s window, so nothing is dialled at all.
    h.clock.now += 1_000;
    const callsBefore = h.bridge.calls.length;
    const second = await h.tick();
    expect(second.skipped).toBe("backoff");
    expect(h.bridge.calls).toHaveLength(callsBefore);

    // Past the window, with the container back: a full reconcile runs again.
    h.clock.now += 30_000;
    h.bridge.state.healthFails = false;
    h.bridge.sessions.clear();
    const third = await h.tick();
    expect(third.reattached).toEqual([ATLASSIAN_REMOTE_SERVER_ID]);
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toMatchObject({
      state: "attached",
      consecutiveBridgeFailures: 0,
      nextAttemptAt: 0,
    });
  });

  it("does not leave a gate refusal stuck inside a bridge backoff window", async () => {
    // The backoff belongs to the BRIDGE hop. Once /health answers, an operator
    // who fixes their connection must be reattached on the next tick — not
    // after a ten-minute window they cannot see.
    const h = harness();
    await h.attach();
    h.bridge.state.healthFails = true;
    await h.tick();

    h.clock.now += 30_000;
    h.bridge.state.healthFails = false;
    h.prismaState.row = { ...connectedRow, status: "DISABLED" };
    await h.tick();
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toMatchObject({
      state: "detached",
      reason: "gate_refused",
      nextAttemptAt: 0,
    });

    h.prismaState.row = connectedRow;
    h.clock.now += 1_000;
    const back = await h.tick();
    expect(back.reattached).toEqual([ATLASSIAN_REMOTE_SERVER_ID]);
  });
});

describe("the gates are unchanged on the reconciler's path", () => {
  it("a DISABLED row refuses the re-open — no session is opened", async () => {
    const h = harness();
    await h.attach();
    h.bridge.sessions.clear();
    h.prismaState.row = { ...connectedRow, status: "DISABLED" };

    const result = await h.tick();
    expect(result.reattached).toEqual([]);
    expect(h.bridge.sessions.size).toBe(0);
    expect(h.bridge.calls.filter((c) => c.path.endsWith("/open"))).toHaveLength(1);
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toMatchObject({
      state: "detached",
      reason: "gate_refused",
    });
  });

  it("a purged credential refuses the re-open", async () => {
    const h = harness();
    await h.attach();
    h.bridge.sessions.clear();
    h.prismaState.row = { ...connectedRow, providerTokensEnc: null };

    await h.tick();
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toMatchObject({
      state: "detached",
      reason: "gate_refused",
    });
    expect(await remoteToolNames(h.mux)).toEqual([]);
  });
});
