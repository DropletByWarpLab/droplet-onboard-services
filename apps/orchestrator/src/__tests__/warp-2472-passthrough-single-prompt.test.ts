/**
 * WARP-2472 regression test — ONE prompt per approved action for the
 * `passThroughConfirmation` tools.
 *
 * This file began as the WARP-2305 verification probe that PROVED the
 * double prompt (it asserted the count was 2, and passed). It is
 * committed here with the class-(a) expectation flipped to 1, so the
 * defect it found cannot come back: run it on `origin/stage` before the
 * `confirmationOwner` fix and it is red on exactly that assertion.
 *
 * PR #1818 reported the double prompt as unverified: its own tests stub
 * the injected `http` client, so they proved the interceptor exists but
 * never drove a real orchestrator route. This file closes that hole.
 * Nothing is stubbed between the MCP dispatch path and the route's
 * confirmation decision:
 *
 *   MCP client  → real `createServer` CallToolRequestSchema handler
 *               → real WARP-2305 interceptor (`defaultToolCallInterceptor`)
 *               → real shipped tool handler (untouched)
 *               → real `fetch` over a real listening express app
 *               → real `registerFirewallRoutes` / `registerPhoneHomeRoutes`
 *               → real `evaluateNetworkCommand` safety evaluator
 *
 * Only Prisma and the leaf side-effect services (`network.service`,
 * `egress.service`) are stubbed — the former because the house rule
 * forbids mock-database integration tests, the latter so the probe can
 * assert the write DID or DID NOT happen.
 *
 * The unit under test is the COUNT OF CHALLENGES A USER WOULD SEE for one
 * approved action. One is the contract. Two is the regression.
 *
 * Mutations this file is written to catch:
 *   - drop `confirmationOwner: "route"` from `block_network_device` → the
 *     interceptor challenges again and the class-(a) count goes 1 → 2
 *   - drop `block_device` from `TIER_2_OPERATIONS` → the ROUTE stops
 *     challenging and the count goes 1 → 0
 *   - make `PATCH /network/phone-home` answer 202 → the class-(c) count
 *     goes 1 → 2
 */
// add-llm-tool:gate — WARP-2496 / WARP-2612: this test asserts on a site an
// agent edits when ADDING a tool, so the `add-llm-tool` skill must name every
// repo file it reads. Drop the pragma and it stops being derived from.

import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { type Request, type Response, type NextFunction } from "express";
import { createServer as createHttpServer, type Server as NodeServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { PrismaClient } from "@prisma/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  TOOLS,
  createToolCallInterceptor,
  defaultToolCallInterceptor,
  type HttpClient,
} from "@droplet/tools-core";

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    ROUTING_SERVICE_URL: "http://routing.test:8080",
    SERVICE_SECRET: "svc",
  },
}));

// Leaf side-effect services. These are the ONLY thing between the route's
// confirmation decision and the actual write, so spying here is how the
// probe proves whether the write happened.
const blockDevice = vi.fn().mockResolvedValue({ operationId: "op-1" });
vi.mock("../services/network.service.js", () => ({
  getFirewallConfig: vi.fn().mockResolvedValue({}),
  blockDevice: (...a: unknown[]) => blockDevice(...a),
  unblockDevice: vi.fn().mockResolvedValue({ operationId: "op-2" }),
  addPortForward: vi.fn().mockResolvedValue({ operationId: "op-3" }),
  addFirewallRule: vi.fn().mockResolvedValue({ operationId: "op-4" }),
  setZonePolicy: vi.fn().mockResolvedValue({ operationId: "op-5" }),
  getUpnp: vi.fn().mockResolvedValue({ available: false }),
  setUpnp: vi.fn().mockResolvedValue({ operationId: "op-6" }),
}));

const setPhoneHomeSetting = vi.fn().mockResolvedValue(undefined);
vi.mock("../services/egress.service.js", () => ({
  MASTER_SETTING_KEY: "egress.phoneHome.master",
  CAMERAS_SETTING_KEY: "egress.phoneHome.cameras",
  getPhoneHomeSettings: vi.fn().mockResolvedValue({ enabled: true, cameras: false }),
  getPhoneHomeView: vi.fn().mockResolvedValue({ enabled: true, cameras: false, groups: [] }),
  setPhoneHomeSetting: (...a: unknown[]) => setPhoneHomeSetting(...a),
}));

import { registerFirewallRoutes } from "../routes/network-firewall.routes.js";
import { registerPhoneHomeRoutes } from "../routes/network-phone-home.routes.js";
import type { AuthUser } from "../middleware/auth.js";

// The mcp-server's real dispatch handler, imported from the package barrel.
// WARP-2473 gave `@droplet/mcp-server` `declaration: true` and an `exports`
// entry, so these are the REAL types emitted from `src/` — not the
// hand-written ambient shim this file used to carry, which declared a
// narrowed `ContextDeps` and an `unknown`-claims `TrustContext` and would
// have gone on typechecking green after either one drifted.
// `dist/` is what the appliance runs; it is built by ship-check's leaf-build
// phase and by the orchestrator Dockerfile.
import {
  createServer,
  type ServerOptions,
  type ContextDeps,
} from "@droplet/mcp-server";

/** The AI's dispatch identity — every tool call reaches routes as this. */
const MCP_PRINCIPAL: AuthUser = {
  id: "_service:mcp",
  username: "_service:mcp",
  displayName: "MCP Server",
  role: "service",
};

function prismaMock(): PrismaClient {
  return {
    commandAuditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as unknown as PrismaClient;
}

/** Everything the tool handler actually sent to the orchestrator. */
interface SeenRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, unknown>;
}

async function startOrchestrator(): Promise<{
  baseUrl: string;
  seen: SeenRequest[];
  close: () => Promise<void>;
}> {
  const seen: SeenRequest[] = [];
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: AuthUser }).user = MCP_PRINCIPAL;
    seen.push({
      method: req.method,
      path: req.path,
      body: req.body,
      headers: { ...req.headers },
    });
    next();
  });
  const router = express.Router();
  const prisma = prismaMock();
  registerFirewallRoutes(router, { prisma });
  registerPhoneHomeRoutes(router, { prisma });
  app.use("/api", router);

  const server: NodeServer = createHttpServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A REAL http client — this is the piece PR #1818's tests stubbed out. */
function realHttpClient(baseUrl: string): HttpClient {
  const send = (method: string) => async (path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    get: async (path: string) => fetch(`${baseUrl}${path}`),
    post: send("POST"),
    patch: send("PATCH"),
    delete: async (path: string) => fetch(`${baseUrl}${path}`, { method: "DELETE" }),
  } as HttpClient;
}

async function connectMcp(baseUrl: string) {
  const deps: ContextDeps = {
    prisma: prismaMock(),
    matter: {} as never,
    httpFactory: (target: string) =>
      target === "orchestrator"
        ? realHttpClient(baseUrl)
        : ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as HttpClient),
  } as ContextDeps;
  // The PRODUCTION interceptor instance, not a test double.
  const options: ServerOptions = { interceptor: defaultToolCallInterceptor };
  const server = createServer(deps, { kind: "local-trusted" }, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "warp-2305-probe", version: "0.0.1" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function parse(res: unknown): Record<string, unknown> {
  const content = (res as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

type Details = Record<string, unknown> & {
  interceptor?: { outcome?: string; confirmationToken?: string };
};

function detailsOf(payload: Record<string, unknown>): Details {
  return ((payload.error as { details?: Details })?.details ?? {}) as Details;
}

function isChallenge(payload: Record<string, unknown>): boolean {
  return payload.status === "confirmation_required";
}

/** Which mechanism raised this challenge — the discriminator that makes
 *  "two prompts" legible instead of just a count. */
function challengeSource(payload: Record<string, unknown>): "interceptor" | "orchestrator-route" {
  return detailsOf(payload).interceptor ? "interceptor" : "orchestrator-route";
}

function interceptorToken(payload: Record<string, unknown>): string {
  return detailsOf(payload).interceptor?.confirmationToken ?? "";
}

describe("WARP-2472 — the pass-through roster, enumerated from the flag", () => {
  it("is 15 tools, derived from requiresConfirmation + the handler's own code", () => {
    const confirming = [...TOOLS.values()].filter((t) => t.requiresConfirmation === true);
    // Enumeration from the FLAG and from the SHIPPED HANDLER BODY — never a
    // copied list. `handler.toString()` sees the compiled call site, so a
    // handler that only MENTIONS the helper in a comment (apply_update) is
    // correctly excluded, and a 16th pass-through tool is picked up the day
    // it is written.
    const passThrough = confirming
      .filter((t) => t.handler.toString().includes("passThroughConfirmation"))
      .map((t) => t.name)
      .sort();

    // 38, not the 37 the probe measured: WARP-2472 flips
    // `detect_wan_port.requiresConfirmation` to true so the flag stops
    // disagreeing with its route's Tier-2 classification.
    //
    // 40 as of WARP-2546: `crm_log_activity` and `crm_move_deal_stage`. Both
    // are gated by the flag alone (the interceptor enforces it generically),
    // and neither is a pass-through — the roster below is unchanged, which is
    // the distinction this count exists to keep visible.
    //
    // 41 as of WARP-2669: `delete_file`. Flag-gated by the interceptor, no
    // `confirmed` boolean in its schema (so only a human-minted token gets
    // through), and not a pass-through — the roster below is unchanged, which
    // is the distinction this count exists to keep visible.
    //
    // 43 as of WARP-2664: `organize_files` and `delete_files`. Same shape —
    // flag-gated by the interceptor, no `confirmed` boolean in either schema,
    // neither a pass-through. This is the reconciliation origin/stage's note
    // asked for: WARP-2669's `delete_file` (40→41) and WARP-2664's two
    // (41→43) are independent and both correct, so the count is the UNION of
    // both, not either side's number.
    expect(confirming).toHaveLength(43);
    expect(passThrough).toEqual([
      "add_port_forward",
      "approve_ap",
      "block_network_device",
      "decommission_ap",
      "detect_wan_port",
      "restart_router",
      "set_phone_home_blocking",
      "set_port_poe",
      "set_port_vlan",
      "set_wifi_channel",
      "set_wifi_password",
      "set_wifi_ssid",
      "setup_camera_ports",
      "share_clip",
      "unblock_network_device",
    ]);
  });
});

describe("WARP-2472 — class (a): the route 202s, and it is the ONLY gate", () => {
  beforeEach(() => {
    blockDevice.mockClear();
    setPhoneHomeSetting.mockClear();
  });

  it("block_network_device prompts the user ONCE, from the route", async () => {
    const orch = await startOrchestrator();
    const { client, close } = await connectMcp(orch.baseUrl);
    const args = { mac: "AA:BB:CC:DD:EE:FF" };
    const challenges: string[] = [];

    // ── the user's first ask ──────────────────────────────────────────
    const first = parse(await client.callTool({ name: "block_network_device", arguments: args }));
    if (isChallenge(first)) challenges.push(challengeSource(first));

    // THE VERDICT. Before WARP-2472 this read
    // ["interceptor", "orchestrator-route"] across two calls: the
    // interceptor challenged first, and the second challenge carried the
    // ROUTE's token, which only the dashboard confirm endpoint redeems —
    // so the approved write could never happen from chat. The tool now
    // declares `confirmationOwner: "route"`, so the interceptor stands
    // down and the route's existing Tier-2 gate is the single prompt.
    expect(challenges).toEqual(["orchestrator-route"]);
    expect(challenges).toHaveLength(1);

    // It is the ROUTE's challenge, with the route's own token, and the
    // interceptor contributed nothing — not even a token nobody asked for.
    expect(detailsOf(first).operation).toBe("block_device");
    expect(detailsOf(first).tier).toBe(2);
    expect(typeof detailsOf(first).confirmationToken).toBe("string");
    expect(detailsOf(first).interceptor).toBeUndefined();
    expect(interceptorToken(first)).toBe("");

    // The handler DID run and reach the route — that is what makes this
    // the route's challenge rather than a refusal before dispatch.
    expect(orch.seen).toHaveLength(1);
    expect(orch.seen[0]!.path).toBe("/api/network/firewall/block");

    // The write itself is still gated: the route 202'd, so nothing was
    // blocked. Fail-closed is unchanged; only the number of asks moved.
    expect(blockDevice).not.toHaveBeenCalled();

    await close();
    await orch.close();
  });

  it("the interceptor forwards NO confirmation signal the route could read (why class (b) is empty)", async () => {
    const orch = await startOrchestrator();
    const { client, close } = await connectMcp(orch.baseUrl);
    const args = { mac: "11:22:33:44:55:66" };

    await client.callTool({ name: "block_network_device", arguments: args });

    // Exactly one request reached the orchestrator, and it carries the
    // tool's plain arguments: no `confirmed`, no `confirmationToken`, no
    // header. There is nothing for a route to branch on, which is why no
    // route can be class (b) today — and therefore why "forward the
    // interceptor's token to the route" was never an available fix.
    expect(orch.seen).toHaveLength(1);
    const req = orch.seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/api/network/firewall/block");
    expect(req.body).toEqual({ mac: "11:22:33:44:55:66" });
    expect(JSON.stringify(req.body)).not.toContain("confirm");
    expect(Object.keys(req.headers).join(",").toLowerCase()).not.toContain("confirmation");

    await close();
    await orch.close();
  });
});

describe("WARP-2472 — class (c): the route has no 202 path, so the interceptor is the gate", () => {
  beforeEach(() => {
    blockDevice.mockClear();
    setPhoneHomeSetting.mockClear();
  });

  it("set_phone_home_blocking prompts ONCE and then performs the write", async () => {
    const orch = await startOrchestrator();
    const { client, close } = await connectMcp(orch.baseUrl);
    const args = { scope: "master", enabled: true };
    const challenges: string[] = [];

    const first = parse(await client.callTool({ name: "set_phone_home_blocking", arguments: args }));
    if (isChallenge(first)) challenges.push(challengeSource(first));
    const token = interceptorToken(first);
    expect(setPhoneHomeSetting).not.toHaveBeenCalled();

    const second = parse(
      await client.callTool({
        name: "set_phone_home_blocking",
        arguments: args,
        _meta: { confirmationToken: token },
      }),
    );
    if (isChallenge(second)) challenges.push(challengeSource(second));

    expect(challenges).toEqual(["interceptor"]);
    expect(challenges).toHaveLength(1);
    // Success: `toolResultToContent` renders `data` alone, so this is the
    // route's own 200 body coming back through the tool.
    expect(second).toEqual({ status: "ok", enabled: true, cameras: false });
    expect(setPhoneHomeSetting).toHaveBeenCalledTimes(1);

    await close();
    await orch.close();
  });
});

describe("WARP-2472 — control: a pass-through interceptor gives the same single prompt", () => {
  beforeEach(() => {
    blockDevice.mockClear();
  });

  /**
   * Models the dispatch path as it stood on `origin/stage` before
   * PR #1818: `requiresConfirmation` enforced by nothing generically, so
   * the call goes straight to the handler and the ROUTE's 202 is the only
   * challenge the user ever sees.
   *
   * Kept as a CONTROL. It is the behaviour WARP-2472 restores, so the
   * test above cannot be vacuously green: if the ownership skip stopped
   * working, the two would disagree.
   *
   * `block_network_device` has no handler-side gate and its schema does
   * not declare `confirmed`, so the interceptor is the entire delta.
   */
  const passThroughInterceptor = {
    ...createToolCallInterceptor(),
    intercept: (_tool: unknown, args: Record<string, unknown>) => ({
      kind: "proceed" as const,
      args,
      confirmationConsumed: false,
    }),
  } as unknown as typeof defaultToolCallInterceptor;

  it("WITHOUT the interceptor, block_network_device challenges exactly ONCE", async () => {
    const orch = await startOrchestrator();
    const deps = {
      prisma: prismaMock(),
      matter: {} as never,
      httpFactory: (target: string) =>
        target === "orchestrator"
          ? realHttpClient(orch.baseUrl)
          : ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() } as unknown as HttpClient),
    } as ContextDeps;
    const server = createServer(deps, { kind: "local-trusted" }, {
      interceptor: passThroughInterceptor,
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "warp-2305-before", version: "0.0.1" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);

    const only = parse(
      await client.callTool({
        name: "block_network_device",
        arguments: { mac: "AA:BB:CC:DD:EE:FF" },
      }),
    );

    expect(isChallenge(only)).toBe(true);
    expect(challengeSource(only)).toBe("orchestrator-route");
    expect(detailsOf(only).operation).toBe("block_device");
    expect(blockDevice).not.toHaveBeenCalled();

    await client.close();
    await server.close();
    await orch.close();
  });
});
