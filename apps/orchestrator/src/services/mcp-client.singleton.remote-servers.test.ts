/**
 * WARP-3703 (ADR-043 TC-1.2) — TWO servers on the outbound MCP track, through
 * the production wiring.
 *
 * Until TC-1 the track could only attach Atlassian: the boot call, the
 * reconciler's re-open and the inventory read all named it, and the code said so
 * ("a second server is a second attach function and a switch here"). Every
 * function this file calls is the shipped one — `ensureRemoteMcpAttached`,
 * `remoteMcpReconcilerDeps`, `detachRemoteMcp` — over the real multiplexer, the
 * real gate, the real `McpBridgeClient`, the real ADR-042 seal, the real
 * lifecycle registry and the real reconciler. The doubles are the three things
 * that are not ours: the bridge (a MODEL of it, below, not a canned answer), the
 * stdio child, and Postgres.
 *
 * ## The second vendor is a FIXTURE
 *
 * `fixture-bearer` is a TEST-ONLY bearer-only descriptor built in this file and
 * handed to the wiring through the `servers` parameter. It is not, and may never
 * be, in the production provider registry, `REMOTE_SERVER_DOMAINS` or the
 * bridge's `SESSION_PROFILES`; the nothing-connected default is asserted, with
 * the real config, in `mcp-client.singleton.remote-default.test.ts`.
 *
 * Credential fixtures are obviously fake and every host is RFC 2606 reserved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { providerDescriptor, type McpProviderDescriptor } from "@droplet/shared-types";

// No allowlist any more (WARP-3960): a registration handed to the attach wiring
// may attach, and the gate decides. Only the bridge address is mocked.
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return {
    ...actual,
    config: {
      ...actual.config,
      MCP_BRIDGE_URL: "http://mcp-bridge.test:9096",
      MCP_BRIDGE_SERVICE_TOKEN: "bridge-token-FAKE-0000000000000000",
    },
  };
});

// The stdio child. `attachRemoteServer` lists the union catalog, and the real
// client throws "not started" for a listing it was never asked to start for.
vi.mock("./mcp-client.service.js", () => ({
  McpClientService: class {
    isStarted = true;
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
    async listTools() {
      return [{ name: "list_files", description: "local", inputSchema: { type: "object" } }];
    }
    async callTool() {
      return { isError: false, content: [] };
    }
  },
}));

vi.mock("./activity.singleton.js", () => ({
  recordActivity: vi.fn(async () => null),
  getActivitySigner: () => null,
}));

import { __setColumnCryptoKeyForTest } from "./column-crypto.service.js";
import type { McpToolDescriptor } from "./mcp-client.port.js";
import {
  detachRemoteMcp,
  ensureRemoteMcpAttached,
  mcpClient,
  remoteCallPolicy,
  remoteMcpReconcilerDeps,
} from "./mcp-client.singleton.js";
import { remoteMcpLifecycle } from "./remote-mcp-lifecycle.service.js";
import { reconcileRemoteMcpSessions } from "./remote-mcp-reconciler.service.js";
import {
  registeredRemoteServers,
  type RemoteMcpConnectionRow,
  type RemoteServerRegistration,
} from "./remote-mcp-servers.js";
import {
  remoteToolClassificationCache,
  type RemoteToolClassificationRow,
} from "./remote-tool-classification.service.js";
import { runtimeToolRegistry } from "./runtime-tool-registry.service.js";
import { sealSaasCredentials } from "./saas-credential.service.js";

const BRIDGE_URL = "http://mcp-bridge.test:9096";
const BRIDGE_TOKEN = "bridge-token-FAKE-0000000000000000";
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const ATLASSIAN = "atlassian";
const FIXTURE = "fixture-bearer";
const OFF = "fixture-off";
const ATLASSIAN_ROW_ID = "conn_atlassian_0000000001";
const FIXTURE_ROW_ID = "conn_fixture_0000000001";
const ATLASSIAN_TOKEN = "ATATT-FAKE-000000000000";
const FIXTURE_TOKEN = "FIXTURE-FAKE-TOKEN-000000";
const FAKE_EMAIL = "ops@vendor.example";
const FAKE_CLOUD_ID = "00000000-0000-4000-8000-000000000000";

const ATLASSIAN_TOOLS: McpToolDescriptor[] = [
  { name: "getJiraIssue", description: "Read one Jira issue", inputSchema: { type: "object" } },
  { name: "getConfluencePage", description: "Read one page", inputSchema: { type: "object" } },
];
const FIXTURE_TOOLS: McpToolDescriptor[] = [
  { name: "get_thing", description: "Read one thing", inputSchema: { type: "object" } },
  { name: "list_things", description: "List things", inputSchema: { type: "object" } },
];
/** The fixture's surface with one tool REPLACED — ADR-043 §1's fourth failure. */
const FIXTURE_TOOLS_DRIFTED: McpToolDescriptor[] = [
  { name: "get_thing", description: "Read one thing", inputSchema: { type: "object" } },
  { name: "delete_thing", description: "New and unclassified", inputSchema: { type: "object" } },
];

/** A bearer-only vendor, as a descriptor: ONE required secret, in the sealed
 *  bundle, and nothing in `providerConfig`. */
function fixtureDescriptor(id: string): McpProviderDescriptor {
  return {
    id,
    displayName: "Fixture bearer vendor",
    category: "Fixture",
    track: "mcp",
    mcpServerId: id,
    description: "Test-only.",
    setupGuideHref: `/help/connectors/${id}`,
    credentialFields: [
      {
        name: "apiToken",
        label: "Fixture API token",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
      },
    ],
    egressHosts: ["mcp.fixture.invalid"],
    datasets: [],
  };
}

const atlassianRegistration = (): RemoteServerRegistration => {
  const found = registeredRemoteServers().find((s) => s.serverId === ATLASSIAN);
  if (!found) throw new Error("the atlassian registration is missing");
  return found;
};
const fixtureRegistration = (id: string = FIXTURE): RemoteServerRegistration => ({
  serverId: id,
  operatorDomain: "cloud",
  descriptor: fixtureDescriptor(id),
});

// ---------------------------------------------------------------------------
// The bridge — a MODEL, faithful in what the reconciler turns on
// ---------------------------------------------------------------------------

interface FixtureSession {
  state: string;
  baseline: Set<string> | null;
  toolCount: number;
  openBody: unknown;
}

/**
 * A model of `services/mcp-bridge` for MORE THAN ONE server: sessions are held
 * per id, `open` REPLACES and seeds the drift baseline from `knownTools`, a
 * listing that disagrees with the baseline flips THAT session to
 * `catalog_changed`, `GET /sessions` (behind the bearer) reports every session
 * the bridge holds, and a call is answered by the session it was addressed to —
 * so a call that lands on the wrong server is visible in its own answer.
 */
function fixtureBridge() {
  const sessions = new Map<string, FixtureSession>();
  const calls: { method: string; path: string; body: unknown; authorization?: string }[] = [];
  const vendors: Record<string, { tools: McpToolDescriptor[] }> = {
    [ATLASSIAN]: { tools: ATLASSIAN_TOOLS },
    [FIXTURE]: { tools: FIXTURE_TOOLS },
    [OFF]: { tools: FIXTURE_TOOLS },
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
    const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
    calls.push({ method, path, body, ...(authorization ? { authorization } : {}) });
    const json = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });

    if (authorization !== `Bearer ${BRIDGE_TOKEN}`) {
      return json(401, { error: { code: "UNAUTHORIZED", message: "Unauthorized." } });
    }
    if (path === "/sessions" && method === "GET") {
      return json(200, {
        knownServers: Object.keys(vendors).sort(),
        sessions: [...sessions.entries()].map(([id, s]) => health(id, s)),
      });
    }
    const m = /^\/sessions\/([a-z0-9-]+)(?:\/([a-z-]+))?$/.exec(path);
    if (!m) return json(404, { error: { code: "NOT_FOUND", message: path } });
    const id = m[1]!;
    const action = m[2];
    if (!vendors[id]) {
      return json(404, { error: { code: "UNKNOWN_SERVER_ID", message: `"${id}" is unknown.` } });
    }

    if (action === undefined && method === "DELETE") {
      return json(200, { closed: sessions.delete(id) });
    }
    if (action === "open") {
      const known = (body as { knownTools?: string[] } | undefined)?.knownTools;
      sessions.set(id, {
        state: "ready",
        baseline: known ? new Set(known) : null,
        toolCount: 0,
        openBody: body,
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
      const tools = vendors[id]!.tools;
      const names = new Set(tools.map((t) => t.name));
      if (session.baseline !== null) {
        const removed = [...session.baseline].filter((n) => !names.has(n));
        const added = [...names].filter((n) => !session.baseline!.has(n));
        if (removed.length > 0 || added.length > 0) session.state = "catalog_changed";
      }
      session.baseline = names;
      session.toolCount = names.size;
      // WARP-3918 — the real bridge hashes each wire object; dispatch refuses a
      // tool whose listing carries no hash, so the model must send one.
      const hashed = tools.map((t) => ({
        ...t,
        definitionHash: Buffer.from(`${id}:${t.name}:${t.description}`).toString("hex").padEnd(64, "0").slice(0, 64),
      }));
      return json(200, { tools: hashed, state: health(id, session) });
    }
    if (action === "state") return json(200, { state: health(id, session) });
    if (action === "call") {
      return json(200, {
        result: {
          content: [{ type: "text", text: JSON.stringify({ answeredBy: id, name: body.name }) }],
          isError: false,
        },
        state: health(id, session),
      });
    }
    return json(404, { error: { code: "NOT_FOUND", message: path } });
  });

  return {
    calls,
    sessions,
    vendors,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    callsTo: (id: string, action?: string) =>
      calls.filter(
        (c) =>
          c.path === `/sessions/${id}${action ? `/${action}` : ""}` ||
          (action === undefined && c.path.startsWith(`/sessions/${id}/`)),
      ),
  };
}

// ---------------------------------------------------------------------------
// Postgres — the two reads the wiring makes, and the classification record
// ---------------------------------------------------------------------------

function fixturePrisma(rows: Record<string, RemoteMcpConnectionRow | null>) {
  const record = new Map<string, RemoteToolClassificationRow>();
  const keyOf = (w: { serverId_toolName: { serverId: string; toolName: string } }) =>
    `${w.serverId_toolName.serverId} ${w.serverId_toolName.toolName}`;
  const prisma = {
    integrationConnection: {
      findFirst: vi.fn(async (args: { where: { provider: string } }) => rows[args.where.provider] ?? null),
    },
    remoteToolClassification: {
      findUnique: vi.fn(async (args: { where: Parameters<typeof keyOf>[0] }) => record.get(keyOf(args.where)) ?? null),
      upsert: vi.fn(
        async (args: {
          where: Parameters<typeof keyOf>[0];
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const k = keyOf(args.where);
          const existing = record.get(k);
          const row = existing
            ? { ...existing, ...args.update }
            : ({ reviewedBy: null, reviewedAt: null, ...args.create } as RemoteToolClassificationRow);
          record.set(k, row as RemoteToolClassificationRow);
          return row;
        },
      ),
      findMany: vi.fn(async () => [...record.values()]),
    },
  };
  return { prisma, record };
}

function connectedRows(): Record<string, RemoteMcpConnectionRow | null> {
  return {
    [ATLASSIAN]: {
      id: ATLASSIAN_ROW_ID,
      status: "CONNECTED",
      providerTokensEnc: sealSaasCredentials(ATLASSIAN_ROW_ID, { apiToken: ATLASSIAN_TOKEN }),
      providerConfig: { email: FAKE_EMAIL, cloudId: FAKE_CLOUD_ID },
    },
    [FIXTURE]: {
      id: FIXTURE_ROW_ID,
      status: "CONNECTED",
      providerTokensEnc: sealSaasCredentials(FIXTURE_ROW_ID, { apiToken: FIXTURE_TOKEN }),
      providerConfig: null,
    },
  };
}

// ---------------------------------------------------------------------------

let bridge: ReturnType<typeof fixtureBridge>;
let db: ReturnType<typeof fixturePrisma>;
let rows: Record<string, RemoteMcpConnectionRow | null>;

async function clearProcessState(): Promise<void> {
  for (const id of mcpClient.remoteServerIds()) mcpClient.detachRemote(id);
  for (const id of [ATLASSIAN, FIXTURE, OFF]) {
    runtimeToolRegistry.unregisterServer(id);
    await detachRemoteMcp(id);
  }
  for (const reg of remoteMcpLifecycle.list()) remoteMcpLifecycle.unregister(reg.serverId);
  remoteToolClassificationCache.seed([]);
}

beforeEach(async () => {
  vi.clearAllMocks();
  __setColumnCryptoKeyForTest(TEST_KEY);
  bridge = fixtureBridge();
  vi.stubGlobal("fetch", bridge.fetchImpl);
  rows = connectedRows();
  db = fixturePrisma(rows);
  await clearProcessState();
  bridge.calls.length = 0;
  bridge.sessions.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const BOTH = (): RemoteServerRegistration[] => [atlassianRegistration(), fixtureRegistration()];

/** An owner's review of a vendor's tools: reads, with a reviewer — the only
 *  thing that lets a tool a compiled table has no row for run. */
async function ownerReviewsAsReads(serverId: string, names: string[]): Promise<void> {
  for (const name of names) {
    const k = `${serverId} ${name}`;
    const row = db.record.get(k);
    if (!row) throw new Error(`${k} was never recorded`);
    db.record.set(k, {
      ...row,
      requiresWrite: false,
      requiresConfirmation: false,
      reviewedBy: "owner",
      reviewedAt: new Date(),
    });
  }
  await remoteToolClassificationCache.refresh(db.prisma as never);
}

/** WARP-2434 — an owner/admin allowlists tools of a server (the record rows
 *  exist from discovery). Orthogonal to the review above. */
async function allowlist(serverId: string, names: string[]): Promise<void> {
  for (const name of names) {
    const k = `${serverId} ${name}`;
    const row = db.record.get(k);
    if (!row) throw new Error(`${k} was never recorded`);
    db.record.set(k, { ...row, allowlisted: true });
  }
  await remoteToolClassificationCache.refresh(db.prisma as never);
}

describe("the boot attach loops every registered server (TC-1.2)", () => {
  it("attaches Atlassian and a bearer-only vendor side by side, each over ITS OWN contract", async () => {
    const results = await ensureRemoteMcpAttached(db.prisma, BOTH());

    expect(results.map((r) => [r.serverId, r.attached])).toEqual([
      [ATLASSIAN, true],
      [FIXTURE, true],
    ]);
    expect(bridge.sessions.get(ATLASSIAN)?.openBody).toEqual({
      email: FAKE_EMAIL,
      apiToken: ATLASSIAN_TOKEN,
      cloudId: FAKE_CLOUD_ID,
    });
    // One field. No email, no site — and nothing of Atlassian's.
    expect(bridge.sessions.get(FIXTURE)?.openBody).toEqual({ apiToken: FIXTURE_TOKEN });
  });

  it("never lets one vendor's credential reach the other's session", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    expect(JSON.stringify(bridge.sessions.get(FIXTURE)?.openBody)).not.toContain(ATLASSIAN_TOKEN);
    expect(JSON.stringify(bridge.sessions.get(ATLASSIAN)?.openBody)).not.toContain(FIXTURE_TOKEN);
  });

  it("advertises both namespaces, each in the OPERATOR domain its server was registered with", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());

    expect(mcpClient.remoteServerIds()).toEqual([ATLASSIAN, FIXTURE]);
    const byServer = (id: string) => runtimeToolRegistry.list().filter((t) => t.serverId === id);
    expect(byServer(ATLASSIAN).map((t) => t.name)).toEqual([
      "atlassian__getJiraIssue",
      "atlassian__getConfluencePage",
    ]);
    expect(byServer(FIXTURE).map((t) => t.name)).toEqual([
      "fixture-bearer__get_thing",
      "fixture-bearer__list_things",
    ]);
    expect(byServer(ATLASSIAN).every((t) => t.domain === "pm" && t.domainSource === "operator")).toBe(true);
    expect(byServer(FIXTURE).every((t) => t.domain === "cloud" && t.domainSource === "operator")).toBe(true);
  });

  it("writes each server's lifecycle under its own id", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    expect(remoteMcpLifecycle.list().map((r) => [r.serverId, r.state])).toEqual([
      [ATLASSIAN, "attached"],
      [FIXTURE, "attached"],
    ]);
  });

  it("records each server's tools in the classification record under its own id, by wire name", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    expect([...db.record.keys()].sort()).toEqual([
      "atlassian getConfluencePage",
      "atlassian getJiraIssue",
      "fixture-bearer get_thing",
      "fixture-bearer list_things",
    ]);
  });

  it("skips a registered server with no connection — refused at the gate, no dial — and still attaches the others", async () => {
    const results = await ensureRemoteMcpAttached(db.prisma, [
      atlassianRegistration(),
      fixtureRegistration(OFF),
      fixtureRegistration(),
    ]);

    expect(results.map((r) => [r.serverId, r.attached])).toEqual([
      [ATLASSIAN, true],
      [OFF, false],
      [FIXTURE, true],
    ]);
    expect(results[1]).toMatchObject({ reason: "gate_refused" });
    expect(bridge.calls.some((c) => c.path.startsWith(`/sessions/${OFF}`))).toBe(false);
    // Registered detached, so the reconciler attaches it once a sign-in connects.
    expect(remoteMcpLifecycle.get(OFF)).toMatchObject({ state: "detached", reason: "gate_refused" });
  });

  it("attempts the NEXT server when one throws, then reports the failure to the caller", async () => {
    // The gate read succeeds and the row read that follows it does not — the
    // one place a database error is not already a refusal.
    let fixtureReads = 0;
    db.prisma.integrationConnection.findFirst.mockImplementation(async (args) => {
      if (args.where.provider === FIXTURE && ++fixtureReads === 2) throw new Error("db went away");
      return rows[args.where.provider] ?? null;
    });

    await expect(
      ensureRemoteMcpAttached(db.prisma, [fixtureRegistration(), atlassianRegistration()]),
    ).rejects.toThrow("db went away");

    // Atlassian was still attached, although the server before it threw.
    expect(mcpClient.remoteServerIds()).toEqual([ATLASSIAN]);
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "attached" });
  });
});

describe("a vendor with no compiled table is DENIED until an owner has reviewed a read (default-deny, through the wiring)", () => {
  it("refuses its tools at dispatch without touching the wire, and runs one once reviewed — while Atlassian's table needs no review", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());

    // WARP-2434 — nothing is allowlisted yet, so the allowlist refuses first.
    const notListed = await mcpClient.callTool("fixture-bearer__get_thing", {});
    expect(JSON.parse(notListed.content[0]!.text!)).toMatchObject({ error: "REMOTE_TOOL_NOT_ALLOWLISTED" });
    await allowlist(FIXTURE, ["get_thing", "list_things"]);

    // No table speaks for this server, so the answer is the table's own
    // refusal — NOT_CLASSIFIED — even though the record holds every advertised
    // tool (as a confirming write). Nothing is dialled.
    const denied = await mcpClient.callTool("fixture-bearer__get_thing", {});
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0]!.text!)).toMatchObject({ error: "REMOTE_TOOL_NOT_CLASSIFIED" });
    expect(bridge.callsTo(FIXTURE, "call")).toHaveLength(0);

    // Atlassian's reviewed table allows its reads once allowlisted.
    await allowlist(ATLASSIAN, ["getJiraIssue"]);
    const allowed = await mcpClient.callTool("atlassian__getJiraIssue", { issueKey: "WARP-1" });
    expect(allowed.isError).toBe(false);
    expect(JSON.parse(allowed.content[0]!.text!)).toEqual({ answeredBy: ATLASSIAN, name: "getJiraIssue" });

    await ownerReviewsAsReads(FIXTURE, ["get_thing"]);
    const reviewed = await mcpClient.callTool("fixture-bearer__get_thing", {});
    expect(reviewed.isError).toBe(false);
    expect(JSON.parse(reviewed.content[0]!.text!)).toEqual({ answeredBy: FIXTURE, name: "get_thing" });
    // …and an unreviewed sibling is still refused.
    const sibling = await mcpClient.callTool("fixture-bearer__list_things", {});
    expect(sibling.isError).toBe(true);
  });
});

describe("the reconciler converges each server on its own (TC-1.2)", () => {
  /** The shipped deps, over the shipped lifecycle registry. */
  const tick = (servers = BOTH()) =>
    reconcileRemoteMcpSessions(remoteMcpReconcilerDeps(db.prisma, servers));

  it("reads the bridge's bearer-gated inventory once, and it names every server the bridge serves", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    bridge.calls.length = 0;

    const result = await tick();

    expect(result).toMatchObject({ checked: 2, reattached: [], orphansClosed: [], bridgeUnreachable: false });
    const inventory = bridge.calls.filter((c) => c.path === "/sessions");
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({ method: "GET", authorization: `Bearer ${BRIDGE_TOKEN}` });
  });

  it("closes an ORPHAN for one id — a session nothing here owns — and leaves the owned session beside it alone", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    // The account is disconnected while this process is down; on the way back
    // up the attach refuses at the gate, so the vendor connection the bridge is
    // still holding is driven by nothing — registered, but not OWNED.
    rows[FIXTURE] = { ...rows[FIXTURE]!, status: "DISABLED" };
    await ensureRemoteMcpAttached(db.prisma, [fixtureRegistration()]);
    expect(remoteMcpLifecycle.get(FIXTURE)).toMatchObject({ state: "detached", reason: "gate_refused" });
    expect(bridge.sessions.has(FIXTURE)).toBe(true);
    const atlassianSession = bridge.sessions.get(ATLASSIAN);
    bridge.calls.length = 0;

    const result = await tick();

    expect(result.orphansClosed).toEqual([FIXTURE]);
    expect(bridge.callsTo(FIXTURE).filter((c) => c.method === "DELETE")).toHaveLength(1);
    expect(bridge.callsTo(ATLASSIAN).filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(bridge.sessions.has(FIXTURE)).toBe(false);
    expect(bridge.sessions.get(ATLASSIAN)).toBe(atlassianSession);
  });

  it("re-opens ONLY the server whose session the bridge lost — with its own baseline — and never touches the other", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    const atlassianSession = bridge.sessions.get(ATLASSIAN);
    // The bridge restarted for ONE of them (a model of a session lost).
    bridge.sessions.delete(FIXTURE);
    bridge.calls.length = 0;

    const result = await tick();

    expect(result.reattached).toEqual([FIXTURE]);
    // Exactly one open, and it was the fixture's, over the fixture's contract
    // and carrying the surface this process had vetted for it.
    const opens = bridge.calls.filter((c) => c.path.endsWith("/open"));
    expect(opens.map((c) => c.path)).toEqual([`/sessions/${FIXTURE}/open`]);
    expect(opens[0]!.body).toEqual({
      apiToken: FIXTURE_TOKEN,
      knownTools: ["get_thing", "list_things"],
    });
    expect(bridge.callsTo(ATLASSIAN, "open")).toHaveLength(0);
    expect(bridge.sessions.get(ATLASSIAN)).toBe(atlassianSession);
    expect(remoteMcpLifecycle.list().map((r) => [r.serverId, r.state])).toEqual([
      [ATLASSIAN, "attached"],
      [FIXTURE, "attached"],
    ]);
  });

  it("refuses a re-open past drift for ONE server — nothing from it is advertised — while the other stays attached and advertised", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    // The bridge lost the fixture's session AND its surface moved while we
    // were apart: the re-open carries the baseline, and the first listing
    // disagrees with it.
    bridge.sessions.delete(FIXTURE);
    bridge.vendors[FIXTURE]!.tools = FIXTURE_TOOLS_DRIFTED;

    const result = await tick();

    expect(result.reattached).toEqual([]);
    expect(remoteMcpLifecycle.get(FIXTURE)).toMatchObject({
      state: "detached",
      reason: "catalog_changed",
    });
    expect(mcpClient.remoteServerIds()).toEqual([ATLASSIAN]);
    expect(runtimeToolRegistry.list().filter((t) => t.serverId === FIXTURE)).toEqual([]);
    // The bridge session is deliberately left open so the drift can be
    // acknowledged; and Atlassian is exactly as it was.
    expect(bridge.sessions.get(FIXTURE)?.state).toBe("catalog_changed");
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "attached", reason: null });
    expect(runtimeToolRegistry.list().filter((t) => t.serverId === ATLASSIAN)).toHaveLength(2);
  });

  it("holds ONE server at catalog_changed when the bridge reports it, and does not re-open past it — the other is not affected", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    bridge.sessions.get(FIXTURE)!.state = "catalog_changed";
    bridge.calls.length = 0;

    const result = await tick();

    expect(result.reattached).toEqual([]);
    expect(remoteMcpLifecycle.get(FIXTURE)).toMatchObject({ state: "detached", reason: "catalog_changed" });
    expect(remoteMcpLifecycle.get(ATLASSIAN)).toMatchObject({ state: "attached" });
    // A re-open would hand the bridge a fresh session with nothing to compare
    // against — silent acknowledgement — so no open was sent for either.
    expect(bridge.calls.filter((c) => c.path.endsWith("/open"))).toHaveLength(0);
  });

  it("refuses a re-open for an id nobody registered, rather than answering with another server's attach", async () => {
    const deps = remoteMcpReconcilerDeps(db.prisma, BOTH());
    await expect(deps.reattach("not-registered", [])).rejects.toThrow(/not-registered/);
    expect(bridge.calls).toHaveLength(0);
    expect(mcpClient.remoteServerIds()).toEqual([]);
  });

  it("closes the session it is told to close, by id, and detaches in-process by id", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    const deps = remoteMcpReconcilerDeps(db.prisma, BOTH());
    bridge.calls.length = 0;

    await deps.closeSession(FIXTURE);
    deps.detach(FIXTURE);

    expect(bridge.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /sessions/${FIXTURE}`]);
    expect(mcpClient.remoteServerIds()).toEqual([ATLASSIAN]);
  });
});

describe("a disconnect tears down ONE server and leaves the other attached (TC-1.2)", () => {
  it("closes only that bridge session, drops only that multiplexer entry, unregisters only that server's tools", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    bridge.calls.length = 0;

    await detachRemoteMcp(FIXTURE);

    expect(bridge.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`DELETE /sessions/${FIXTURE}`]);
    expect(bridge.sessions.has(FIXTURE)).toBe(false);
    expect(bridge.sessions.has(ATLASSIAN)).toBe(true);
    expect(mcpClient.remoteServerIds()).toEqual([ATLASSIAN]);
    expect(runtimeToolRegistry.list().map((t) => t.serverId)).toEqual([ATLASSIAN, ATLASSIAN]);
  });

  it("keeps the survivor callable, and the departed server's names no longer reach the wire", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    await detachRemoteMcp(FIXTURE);
    await allowlist(ATLASSIAN, ["getJiraIssue"]);
    bridge.calls.length = 0;

    const survivor = await mcpClient.callTool("atlassian__getJiraIssue", {});
    expect(survivor.isError).toBe(false);
    expect(bridge.callsTo(ATLASSIAN, "call")).toHaveLength(1);

    await mcpClient.callTool("fixture-bearer__get_thing", {});
    expect(bridge.callsTo(FIXTURE, "call")).toHaveLength(0);
  });

  it("is idempotent for a server that was never attached — the shipping default — and dials nothing", async () => {
    await detachRemoteMcp(OFF);
    expect(bridge.calls).toHaveLength(0);
  });

  it("re-reads the gate per server on every call: disconnecting one account refuses ITS calls and not the other's", async () => {
    await ensureRemoteMcpAttached(db.prisma, BOTH());
    await ownerReviewsAsReads(FIXTURE, ["get_thing"]);
    await allowlist(FIXTURE, ["get_thing"]);
    await allowlist(ATLASSIAN, ["getJiraIssue"]);
    expect((await mcpClient.callTool("fixture-bearer__get_thing", {})).isError).toBe(false);

    rows[FIXTURE] = { ...rows[FIXTURE]!, status: "DISABLED" };
    bridge.calls.length = 0;

    const refused = await mcpClient.callTool("fixture-bearer__get_thing", {});
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0]!.text!)).toMatchObject({ error: "REMOTE_MCP_GATE_REFUSED" });
    expect(bridge.callsTo(FIXTURE, "call")).toHaveLength(0);

    expect((await mcpClient.callTool("atlassian__getJiraIssue", {})).isError).toBe(false);
  });
});

describe("the singleton's call policy speaks through the table registry (TC-1.3)", () => {
  const decide = (serverId: string, wireName: string) =>
    remoteCallPolicy({ serverId, wireName, namespacedName: `${serverId}__${wireName}`, args: {} });

  // WARP-2434 — these assert the table behind the allowlist, so every name used
  // below is allowlisted; the allowlist itself is covered in remote-tool-allowlist.test.ts.
  beforeEach(() => {
    const at = new Date(0);
    const allowRow = (serverId: string, toolName: string): RemoteToolClassificationRow => ({
      serverId,
      toolName,
      requiresWrite: true,
      requiresConfirmation: true,
      denied: false,
      allowlisted: true,
      reviewedBy: null,
      reviewedAt: null,
      wireDescription: null,
      firstSeenAt: at,
      lastSeenAt: at,
    });
    remoteToolClassificationCache.seed([
      ...["getJiraIssue", "createJiraIssue", "getCompassComponents", "notATool"].map((t) =>
        allowRow(ATLASSIAN, t),
      ),
      allowRow(FIXTURE, "getJiraIssue"),
      allowRow("constructor", "getJiraIssue"),
    ]);
  });

  it("is Atlassian's reviewed table for Atlassian: a read runs, a write is blocked, a Compass tool is refused for the credential it needs", () => {
    expect(decide(ATLASSIAN, "getJiraIssue")).toEqual({ kind: "allow" });
    expect(decide(ATLASSIAN, "createJiraIssue")).toMatchObject({
      kind: "deny",
      code: "REMOTE_WRITE_NOT_PERMITTED",
    });
    expect(decide(ATLASSIAN, "getCompassComponents")).toMatchObject({
      kind: "deny",
      code: "ATLASSIAN_TOOL_UNAVAILABLE_IN_AUTH_MODE",
    });
    expect(decide(ATLASSIAN, "notATool")).toMatchObject({ kind: "deny", code: "REMOTE_TOOL_NOT_CLASSIFIED" });
  });

  it("is the shipping deny-all for every server no table speaks for — even one named like an Atlassian read", () => {
    expect(decide(FIXTURE, "getJiraIssue")).toMatchObject({ kind: "deny", code: "REMOTE_TOOL_NOT_CLASSIFIED" });
    expect(decide("constructor", "getJiraIssue")).toMatchObject({ kind: "deny" });
  });
});

describe("the registrations the production wiring defaults to (TC-1.2)", () => {
  it("are the registry's mcp descriptors with their domains — Atlassian alone today", () => {
    expect(registeredRemoteServers().map((s) => s.serverId)).toEqual([ATLASSIAN]);
    expect(providerDescriptor(ATLASSIAN)?.track).toBe("mcp");
  });
});
