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
import { McpBridgeClient, McpBridgeError } from "./mcp-bridge.client.js";
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
  createRemoteMcpReconcileTick,
  mountRemoteMcpReconciler,
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
 * ticket turns on: `open` REPLACES, the bearer-gated `GET /sessions` reports
 * every session the bridge holds (including ones this process never opened),
 * and a listing that disagrees with the baseline flips the session to
 * `catalog_changed`. `/health` answers the constant `{status:"ok"}` and
 * nothing else, as it has on `stage` since 952e0d78 — a model that still
 * served the inventory there is exactly how the old read stayed green while
 * the shipped bridge had moved. The model is the fixture; the bridge's REAL
 * router is driven by `remote-mcp-reconciler.bridge-contract.test.ts`.
 */
function fixtureBridge(initialTools: McpToolDescriptor[] = TOOLS_A) {
  const sessions = new Map<string, FixtureSession>();
  const calls: { method: string; path: string; body: unknown }[] = [];
  const state = {
    tools: initialTools,
    down: false,
    /** When set, the bridge's `open` does not answer until it resolves — a
     *  slow vendor inside `session.connect()`. */
    stallOpen: null as Promise<void> | null,
    /** The vendor does not answer the NEXT `tools/list`; cleared once used. */
    toolsFailOnce: false,
  };

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

    // A container that is down does not answer with a status — it does not
    // answer, on any path. `fetch` rejects, which is what the client turns
    // into BRIDGE_UNREACHABLE.
    if (state.down) throw new TypeError("fetch failed");

    if (path === "/health") {
      // The constant, and deliberately nothing else — served without a bearer.
      return json(200, { status: "ok" });
    }

    // Every other route sits behind the bearer, checked before routing.
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    if (authorization !== `Bearer ${BRIDGE_TOKEN}`) {
      return json(401, { error: { code: "UNAUTHORIZED", message: "Unauthorized." } });
    }

    if (path === "/sessions" && method === "GET") {
      return json(200, {
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
      if (state.stallOpen) await state.stallOpen;
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
      if (state.toolsFailOnce) {
        // The multiplexer swallows this as REMOTE_CATALOG_UNAVAILABLE and the
        // attach completes with nothing listed.
        state.toolsFailOnce = false;
        return json(502, {
          error: { code: "REMOTE_CALL_FAILED", message: "The remote MCP call failed." },
          state: health(id, session),
        });
      }
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
    sessions: () =>
      new McpBridgeClient({
        baseUrl: BRIDGE_URL,
        serviceToken: BRIDGE_TOKEN,
        serverId: ATLASSIAN_REMOTE_SERVER_ID,
        fetchImpl: bridge.fetchImpl,
      }).sessions(),
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
    deps,
    tick: () => reconcileRemoteMcpSessions(deps),
    /** The tick the cron runtime actually drives: one in flight at a time. */
    guarded: createRemoteMcpReconcileTick(deps),
  };
}

/** A promise the test resolves by hand, so the bridge's `open` can be held for
 *  exactly as long as a tick should stay parked inside the vendor call. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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
  it("registers nothing and the reconciler dials NOTHING — not even GET /sessions", async () => {
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
    h.bridge.state.down = true;
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
    h.bridge.state.down = false;
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
    // The backoff belongs to the BRIDGE hop. Once GET /sessions answers, an operator
    // who fixes their connection must be reattached on the next tick — not
    // after a ten-minute window they cannot see.
    const h = harness();
    await h.attach();
    h.bridge.state.down = true;
    await h.tick();

    h.clock.now += 30_000;
    h.bridge.state.down = false;
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

describe("overlapping ticks do not re-enter the re-open (one tick in flight)", () => {
  const opens = (h: ReturnType<typeof harness>) =>
    h.bridge.calls.filter((c) => c.path.endsWith("/open"));

  it("skips a tick that fires while the previous one is still inside the vendor call", async () => {
    const h = harness();
    await h.attach();
    expect(h.openCredentials).toHaveBeenCalledTimes(1);
    h.bridge.sessions.clear();

    // Tick N reaches the bridge's `open` and is parked there: the vendor is
    // slower than the 30 s interval.
    const stall = gate();
    h.bridge.state.stallOpen = stall.promise;
    const first = h.guarded.run();
    await vi.waitFor(() => expect(opens(h)).toHaveLength(2)); // boot + tick N
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)?.state).toBe("reattaching");

    // Tick N+1 fires. Without the guard it reads `reattaching`, detaches the
    // port N is about to use, re-reads the credential and sends a SECOND open
    // that replaces N's session under it.
    const second = await h.guarded.run();
    expect(second.skipped).toBe("in_flight");
    expect(h.guarded.overlapsSkipped).toBe(1);
    expect(opens(h)).toHaveLength(2);
    expect(h.openCredentials).toHaveBeenCalledTimes(2);
    expect(h.bridge.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);

    // The vendor answers; tick N completes normally.
    stall.release();
    h.bridge.state.stallOpen = null;
    const done = await first;
    expect(done.reattached).toEqual([ATLASSIAN_REMOTE_SERVER_ID]);
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)?.state).toBe("attached");

    // And the guard has let go: the next tick RUNS, and finds nothing to do.
    const third = await h.guarded.run();
    expect(third.skipped).toBeNull();
    expect(third.reattached).toEqual([]);
    expect(opens(h)).toHaveLength(2);
    expect(h.guarded.overlapsSkipped).toBe(1);
  });

  it("a tick that THROWS releases the guard — the next tick runs instead of being skipped forever", async () => {
    const h = harness();
    await h.attach();
    h.bridge.sessions.clear();
    let explode = true;
    const tick = createRemoteMcpReconcileTick({
      ...h.deps,
      // `detach` is the one dependency the tick calls outside a try/catch.
      detach: (serverId) => {
        if (explode) throw new Error("detach exploded");
        h.deps.detach(serverId);
      },
    });

    await expect(tick.run()).rejects.toThrow("detach exploded");

    explode = false;
    const next = await tick.run();
    expect(next.skipped).toBeNull();
    expect(next.reattached).toEqual([ATLASSIAN_REMOTE_SERVER_ID]);
    expect(tick.overlapsSkipped).toBe(0);
  });

  it("mountRemoteMcpReconciler schedules the GUARDED tick, not the bare one", async () => {
    const h = harness();
    await h.attach();
    h.bridge.sessions.clear();
    let handler: (() => void | Promise<void>) | null = null;
    mountRemoteMcpReconciler(
      {
        scheduleInterval: (_ms, fn) => {
          handler = fn;
        },
      },
      h.deps,
      30_000,
    );
    expect(handler).not.toBeNull();

    const stall = gate();
    h.bridge.state.stallOpen = stall.promise;
    const a = handler!();
    await vi.waitFor(() => expect(opens(h)).toHaveLength(2));
    // The overlapping fire returns at once, having dialled nothing.
    await handler!();
    expect(opens(h)).toHaveLength(2);

    stall.release();
    await a;
    expect(opens(h)).toHaveLength(2);
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)?.state).toBe("attached");
  });
});

describe("an id the bridge reports is validated before it becomes a path", () => {
  it("refuses to DELETE a session whose id could not be a server id, and still sweeps the rest", async () => {
    const h = harness();
    await h.attach();
    // What `GET /sessions` says is data off the wire, not a constant. Two
    // orphans: one hostile, one honest.
    h.bridge.sessions.set("../sessions", { state: "ready", baseline: null, toolCount: 0 });
    h.bridge.sessions.set("compass", { state: "ready", baseline: null, toolCount: 3 });
    const before = h.bridge.calls.length;

    const result = await h.tick();

    expect(result.orphansClosed).toEqual(["compass"]);
    // The hostile id reached no request — not as a path segment, not at all —
    // and the honest orphan was still closed.
    expect(h.bridge.calls.slice(before).some((c) => c.path.includes(".."))).toBe(false);
    expect(h.bridge.calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([
      "/sessions/compass",
    ]);
    expect(h.bridge.sessions.has("compass")).toBe(false);
    expect(h.bridge.sessions.has(ATLASSIAN_REMOTE_SERVER_ID)).toBe(true);
  });

  it("McpBridgeClient refuses to construct for such an id, before any dial", () => {
    const fetchImpl = vi.fn();
    for (const serverId of ["../sessions", "Atlassian", "a b", "", "x".repeat(33)]) {
      expect(
        () =>
          new McpBridgeClient({
            baseUrl: BRIDGE_URL,
            serviceToken: BRIDGE_TOKEN,
            serverId,
            fetchImpl: fetchImpl as unknown as typeof fetch,
          }),
      ).toThrow(McpBridgeError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("the drift baseline survives a re-open whose own listing failed", () => {
  it("keeps the previously vetted baseline instead of recording an empty one", async () => {
    const h = harness();
    await h.attach();
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)?.vettedTools).toEqual([
      "getJiraIssue",
      "getConfluencePage",
    ]);

    // The bridge restarts, and on the re-open the vendor does not answer
    // tools/list. The multiplexer swallows that rather than failing the box's
    // own catalog, so the attach completes — with nothing listed.
    h.bridge.sessions.clear();
    h.bridge.state.toolsFailOnce = true;
    const result = await h.tick();
    expect(result.reattached).toEqual([ATLASSIAN_REMOTE_SERVER_ID]);
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)?.state).toBe("attached");
    // The baseline a previous attach vetted is still the baseline: an empty
    // listing is not "we vetted an empty surface".
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)?.vettedTools).toEqual([
      "getJiraIssue",
      "getConfluencePage",
    ]);

    // So the NEXT re-open still carries it — and still detects drift.
    h.bridge.sessions.clear();
    h.bridge.state.tools = TOOLS_DRIFTED;
    await h.tick();
    const open = h.bridge.calls.filter((c) => c.path.endsWith("/open")).at(-1);
    expect((open?.body as { knownTools?: string[] }).knownTools).toEqual([
      "getJiraIssue",
      "getConfluencePage",
    ]);
    expect(h.lifecycle.get(ATLASSIAN_REMOTE_SERVER_ID)).toMatchObject({
      state: "detached",
      reason: "catalog_changed",
    });
  });
});
