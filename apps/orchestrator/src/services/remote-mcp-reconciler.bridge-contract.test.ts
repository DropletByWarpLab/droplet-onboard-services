/**
 * WARP-2651 — the reconciler's read of the bridge, driven through the bridge's
 * REAL router.
 *
 * ## Why this file exists
 *
 * Between this branch being cut and its merge to `stage`, stage commit
 * 952e0d78 (WARP-2300 review) moved the bridge's inventory — `knownServers`
 * and every session's health — off the unauthenticated `GET /health`, which is
 * readable by every container on the compose bridge network, and onto the
 * bearer-gated `GET /sessions`. `/health` now answers the constant
 * `{status:"ok"}` and nothing else.
 *
 * The reconciler kept reading `/health`, and NOTHING noticed: the wire type in
 * `mcp-bridge.client.ts` is a deliberate local duplicate (ADR-043 §5 forbids
 * importing the bridge, so `tsc` had no signal), `adr-043-boundary.test.ts`
 * gates the state and error-code vocabularies but not this route, and the
 * fixture in `remote-mcp-reconciler.test.ts` modelled the OLD body. After the
 * merge, every tick on a box with a registered server would have recorded the
 * bridge hop as `succeeded` and then thrown `health.sessions is not iterable`
 * — logged by `safeRun` every 30 s forever, no backoff armed, neither the
 * orphan sweep nor the re-open ever reached. CI-green and production-dead.
 *
 * ## What it does about it
 *
 * The bridge's `handleBridgeRequest` — its routing, its bearer check, its real
 * `BridgeSessionStore` — sits behind the real `McpBridgeClient` via a `fetch`
 * that hands each request to the router instead of a socket (the same
 * adaptation `server.ts` performs for `node:http`), and the real
 * `reconcileRemoteMcpSessions` runs on top. The only double is the vendor: a
 * `RemoteMcpSession` with an injected connection, the same double the bridge's
 * own `http-api.test.ts` uses. A route move on EITHER side is red here.
 *
 * ## Why the bridge is loaded by path, not imported
 *
 * `import … from "../../../../services/mcp-bridge/src/http-api.js"` would put
 * the bridge in this workspace's compile graph — TS6059 under `rootDir: src`,
 * and precisely the module-graph creep ADR-043 §5 names (the bridge's barrel
 * reaches `StreamableHTTPClientTransport`). `adr-043-boundary.test.ts` greps
 * PRODUCT code for that transport and excludes test files, so a test loading
 * the bridge is inside the rule; loading it by a computed path at run time
 * keeps it out of `tsc`'s graph as well. `repoPath()` (test-paths helper) is the anchor
 * that test uses (this workspace compiles to CommonJS, where `import.meta` is
 * a TS1470).
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { join } from "node:path";
import { repoPath } from "../__tests__/helpers/test-paths.js";
import { pathToFileURL } from "node:url";
import { McpBridgeClient } from "./mcp-bridge.client.js";
import { RemoteMcpLifecycleRegistry } from "./remote-mcp-lifecycle.service.js";
import {
  reconcileRemoteMcpSessions,
  type RemoteMcpReconcilerDeps,
} from "./remote-mcp-reconciler.service.js";
import type { RemoteAttachResult } from "./remote-mcp-servers.js";

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

const BRIDGE_URL = "http://mcp-bridge.test:9096";
const BRIDGE_TOKEN = "bridge-token-FAKE-0000000000000000";
const SERVER_ID = "atlassian";
/** The bridge's own constant for this server; only the fake connection below
 *  ever "reaches" it. */
const VENDOR_URL = "https://mcp.atlassian.com/v1/mcp";
const OPEN_BODY = {
  email: "ops@vendor.example",
  apiToken: "ATATT-FAKE-000000000000",
  cloudId: "00000000-0000-4000-8000-000000000000",
};

// WARP-2654: anchored to the repo by the shared helper, never to the runner's
// cwd — the guard in test-paths.guard.test.ts refuses cwd-relative lookups.
const BRIDGE_SRC = repoPath("services", "mcp-bridge", "src");

// The bridge's own types, restated STRUCTURALLY and only as far as this file
// touches them — the same deliberate duplication `mcp-bridge.client.ts`
// explains, for the same reason.
interface BridgeRequest {
  method: string;
  path: string;
  authorization?: string | null;
  body?: unknown;
}
interface BridgeResponse {
  status: number;
  body: unknown;
}
interface BridgeSessionStore {
  get(serverId: string): unknown;
}
interface BridgeApiOptions {
  serviceToken: string;
  store: BridgeSessionStore;
}
interface BridgeHttpApiModule {
  handleBridgeRequest(req: BridgeRequest, opts: BridgeApiOptions): Promise<BridgeResponse>;
  BridgeSessionStore: new (
    factories: Record<string, (input: unknown) => unknown>,
  ) => BridgeSessionStore;
}
interface BridgeRemoteSessionModule {
  RemoteMcpSession: new (opts: {
    serverId: string;
    url: string;
    connect: () => Promise<unknown>;
  }) => unknown;
}

let api: BridgeHttpApiModule;
let sessionModule: BridgeRemoteSessionModule;

beforeAll(async () => {
  // Computed specifiers: `tsc` sees `Promise<any>` and resolves nothing, which
  // is the point (see the header). vitest resolves them at run time.
  api = (await import(pathToFileURL(join(BRIDGE_SRC, "http-api.ts")).href)) as BridgeHttpApiModule;
  sessionModule = (await import(
    pathToFileURL(join(BRIDGE_SRC, "remote-session.ts")).href
  )) as BridgeRemoteSessionModule;
});

/** The vendor double: a connection that lists the given tools and nothing more. */
function vendorServing(names: string[]) {
  return {
    listTools: async () =>
      names.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    callTool: async () => ({ content: [], isError: false }),
    close: async () => undefined,
    onClosed: () => undefined,
  };
}

interface Harness {
  store: BridgeSessionStore;
  /** What the ROUTER saw — method, path and status. Never a body. */
  routed: { method: string; path: string; status: number }[];
  client: (serverId?: string, token?: string) => McpBridgeClient;
  lifecycle: RemoteMcpLifecycleRegistry;
  detach: ReturnType<typeof vi.fn>;
  reattach: ReturnType<typeof vi.fn>;
  deps: (token?: string) => RemoteMcpReconcilerDeps;
}

function harness(names: string[] = ["getJiraIssue"]): Harness {
  const store = new api.BridgeSessionStore({
    [SERVER_ID]: () =>
      new sessionModule.RemoteMcpSession({
        serverId: SERVER_ID,
        url: VENDOR_URL,
        connect: async () => vendorServing(names),
      }),
  });
  const opts: BridgeApiOptions = { serviceToken: BRIDGE_TOKEN, store };
  const routed: Harness["routed"] = [];

  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const { pathname } = new URL(String(url));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? "GET";
    const res = await api.handleBridgeRequest(
      {
        method,
        path: pathname,
        authorization: headers.Authorization ?? null,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      },
      opts,
    );
    routed.push({ method, path: pathname, status: res.status });
    return new Response(JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const client = (serverId: string = SERVER_ID, token: string = BRIDGE_TOKEN) =>
    new McpBridgeClient({ baseUrl: BRIDGE_URL, serviceToken: token, serverId, fetchImpl });

  const lifecycle = new RemoteMcpLifecycleRegistry(() => 1_000_000);
  const detach = vi.fn();
  // Mirrors what `attachAtlassianRemote` does at the end of a successful
  // re-open: records the terminal state. The full attach path is exercised by
  // `remote-mcp-reconciler.test.ts`; this file is about the READ.
  const reattach = vi.fn(
    async (serverId: string, knownTools: readonly string[]): Promise<RemoteAttachResult> => {
      lifecycle.record({ serverId, state: "attached", reason: null, vettedTools: knownTools });
      return {
        attached: true,
        serverId,
        sync: { serverId, registered: [], rejected: [] },
        vettedTools: knownTools,
      };
    },
  );
  const deps = (token: string = BRIDGE_TOKEN): RemoteMcpReconcilerDeps => ({
    lifecycle,
    audit: vi.fn(),
    now: () => 1_000_000,
    sessions: () => client(SERVER_ID, token).sessions(),
    closeSession: async (serverId) => {
      await client(serverId, token).close();
    },
    detach,
    reattach,
  });

  return { store, routed, client, lifecycle, detach, reattach, deps };
}

function registerAttached(h: Harness, vettedTools: readonly string[] = ["getJiraIssue"]): void {
  h.lifecycle.record({ serverId: SERVER_ID, state: "attached", reason: null, vettedTools });
}

describe("the reconciler reads the bridge's REAL `GET /sessions` (WARP-2651)", () => {
  it("the client's inventory read is the bearer-gated route, and answers an ITERABLE `sessions`", async () => {
    const h = harness();
    await h.client().open(OPEN_BODY);

    const body = await h.client().sessions();

    expect(h.routed.at(-1)).toEqual({ method: "GET", path: "/sessions", status: 200 });
    expect(body.knownServers).toEqual([SERVER_ID]);
    expect(Array.isArray(body.sessions)).toBe(true);
    expect(body.sessions.map((s) => [s.serverId, s.state])).toEqual([[SERVER_ID, "ready"]]);
  });

  it("a session the bridge still holds is left alone — no re-open, no detach, no throw", async () => {
    const h = harness();
    await h.client().open(OPEN_BODY);
    registerAttached(h);

    const result = await reconcileRemoteMcpSessions(h.deps());

    expect(result).toMatchObject({ checked: 1, reattached: [], orphansClosed: [], bridgeUnreachable: false });
    expect(h.reattach).not.toHaveBeenCalled();
    expect(h.detach).not.toHaveBeenCalled();
    expect(h.lifecycle.get(SERVER_ID)?.state).toBe("attached");
  });

  it("a session the bridge LOST is re-opened, through `reattaching`, carrying the baseline", async () => {
    const h = harness();
    // The bridge restarted: its store is empty while this process still
    // believes it is attached. Nothing was ever opened on THIS store.
    registerAttached(h, ["getJiraIssue"]);

    const result = await reconcileRemoteMcpSessions(h.deps());

    expect(result.reattached).toEqual([SERVER_ID]);
    expect(h.detach).toHaveBeenCalledWith(SERVER_ID);
    expect(h.reattach).toHaveBeenCalledWith(SERVER_ID, ["getJiraIssue"]);
    expect(h.lifecycle.get(SERVER_ID)?.state).toBe("attached");
  });

  it("closes an orphan through the bridge's real DELETE route", async () => {
    const h = harness();
    await h.client().open(OPEN_BODY);
    // Registered but not OWNED: the account was disconnected while this
    // process was down, so the boot attach refused at the gate.
    h.lifecycle.record({ serverId: SERVER_ID, state: "detached", reason: "gate_refused" });

    const result = await reconcileRemoteMcpSessions(h.deps());

    expect(result.orphansClosed).toEqual([SERVER_ID]);
    expect(h.routed).toContainEqual({ method: "DELETE", path: `/sessions/${SERVER_ID}`, status: 200 });
    expect(h.store.get(SERVER_ID)).toBeUndefined();
  });

  it("without the bearer the router REFUSES the read — so this is the gated inventory, not `/health`", async () => {
    const h = harness();
    await h.client().open(OPEN_BODY);
    registerAttached(h);

    const result = await reconcileRemoteMcpSessions(h.deps("not-the-token"));

    expect(h.routed.at(-1)).toMatchObject({ method: "GET", path: "/sessions", status: 401 });
    expect(result.bridgeUnreachable).toBe(true);
    expect(h.reattach).not.toHaveBeenCalled();
    expect(h.lifecycle.get(SERVER_ID)).toMatchObject({
      state: "bridge_unreachable",
      reason: "health_unreachable",
    });
  });

  it("`/health` is a constant on the shipped bridge — the body the old read expected is gone", async () => {
    // Belt and braces for the mutation "point the read back at /health": what
    // the bridge ACTUALLY answers there, with no bearer at all.
    const h = harness();
    await h.client().open(OPEN_BODY);
    const res = await api.handleBridgeRequest(
      { method: "GET", path: "/health", authorization: null },
      { serviceToken: BRIDGE_TOKEN, store: h.store },
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});
