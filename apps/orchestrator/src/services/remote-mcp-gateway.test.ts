/**
 * WARP-2627 — the gate and the audit row, which are the two things ADR-043 §5
 * actually requires of the orchestrator side.
 *
 * The gate assertions are all "and it did not dial": a refusal that still made
 * the call would be indistinguishable from one that did not, if the only
 * evidence were the returned error.
 */
import { describe, it, expect, vi } from "vitest";
import type { McpClientPort } from "./mcp-client.port.js";
import { McpBridgeError } from "./mcp-bridge.client.js";
import {
  auditRemoteMcp,
  createGatedRemoteMcpPort,
  remoteMcpGate,
  type RemoteMcpGateDecision,
} from "./remote-mcp-gateway.service.js";

/** Typed with its one parameter so the row-shape assertions below can read it
 *  — `vi.fn(async () => …)` infers an empty tuple and `calls[0][0]` is `never`
 *  (a `tsc` error vitest itself would never have shown). */
const recordActivity = vi.fn(async (_params: Record<string, unknown>) => null);
vi.mock("./activity.singleton.js", () => ({
  recordActivity: (params: Record<string, unknown>) => recordActivity(params),
  getActivitySigner: () => null,
}));

const SERVER = "atlassian";

function upstreamDouble(over: Partial<McpClientPort> = {}) {
  const listTools = vi.fn(async () => [
    { name: "atlassian__getJiraIssue", description: "d", inputSchema: {} },
  ]);
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "{}" }], isError: false }));
  return {
    listTools,
    callTool,
    port: { isStarted: true, listTools, callTool, ...over } as McpClientPort,
  };
}

function gated(decision: RemoteMcpGateDecision, over: Partial<McpClientPort> = {}) {
  const up = upstreamDouble(over);
  const audit = vi.fn();
  return {
    ...up,
    audit,
    port: createGatedRemoteMcpPort({
      serverId: SERVER,
      upstream: up.port,
      gate: async () => decision,
      audit,
    }),
  };
}

describe("the gate reads two EXPLICIT columns, and fails closed", () => {
  const allow = new Set([SERVER]);

  it("refuses a server the operator has not allowlisted, before reading the row", async () => {
    const prisma = { integrationConnection: { findFirst: vi.fn() } };
    const d = await remoteMcpGate(prisma, SERVER, new Set());
    expect(d).toMatchObject({ allowed: false, reason: "server_not_allowlisted" });
    expect(prisma.integrationConnection.findFirst).not.toHaveBeenCalled();
  });

  it("allows a CONNECTED row holding a credential", async () => {
    const prisma = {
      integrationConnection: {
        findFirst: async () => ({ id: "c1", status: "CONNECTED", providerTokensEnc: "dcv1:x" }),
      },
    };
    expect(await remoteMcpGate(prisma, SERVER, allow)).toEqual({ allowed: true });
  });

  it("distinguishes no-row, wrong-status and no-credential — three different remedies", async () => {
    const row = (over: Record<string, unknown>) => ({
      integrationConnection: {
        findFirst: async () => ({ id: "c1", status: "CONNECTED", providerTokensEnc: "dcv1:x", ...over }),
      },
    });
    expect(
      await remoteMcpGate({ integrationConnection: { findFirst: async () => null } }, SERVER, allow),
    ).toMatchObject({ reason: "no_connection_row" });
    expect(await remoteMcpGate(row({ status: "ERROR" }), SERVER, allow)).toMatchObject({
      reason: "connection_not_connected",
    });
    expect(await remoteMcpGate(row({ providerTokensEnc: null }), SERVER, allow)).toMatchObject({
      reason: "no_credential",
    });
  });

  it("a DB error REFUSES — the ambientDataGate posture, not outboundEmailGate's throw", async () => {
    const prisma = {
      integrationConnection: {
        findFirst: async () => {
          throw new Error("db down");
        },
      },
    };
    const d = await remoteMcpGate(prisma, SERVER, allow);
    expect(d).toMatchObject({ allowed: false, reason: "gate_unavailable" });
  });
});

describe("every outbound operation lands one audit row", () => {
  it("audits an allowed call", async () => {
    const h = gated({ allowed: true });
    await h.port.callTool("atlassian__getJiraIssue", { issueKey: "WARP-1" });
    expect(h.audit).toHaveBeenCalledWith({
      serverId: SERVER,
      op: "call_tool",
      outcome: "allowed",
      tool: "atlassian__getJiraIssue",
    });
  });

  it("audits an allowed catalog listing", async () => {
    const h = gated({ allowed: true });
    await h.port.listTools();
    expect(h.audit).toHaveBeenCalledWith({ serverId: SERVER, op: "list_tools", outcome: "allowed" });
  });

  it("audits a gate refusal, carries the reason, and DOES NOT DIAL", async () => {
    const h = gated({ allowed: false, reason: "no_credential", message: "no credential" });
    const out = await h.port.callTool("atlassian__getJiraIssue", {});
    expect(out.isError).toBe(true);
    expect(h.callTool).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith({
      serverId: SERVER,
      op: "call_tool",
      outcome: "refused_gate",
      tool: "atlassian__getJiraIssue",
      reason: "no_credential",
    });
  });

  it("audits a provider error with the bridge's code", async () => {
    const h = gated(
      { allowed: true },
      {
        callTool: vi.fn(async () => {
          throw new McpBridgeError("SESSION_NOT_READY", "auth_rejected", 409);
        }),
      },
    );
    const out = await h.port.callTool("atlassian__getJiraIssue", {});
    expect(out.isError).toBe(true);
    expect(h.audit).toHaveBeenCalledWith({
      serverId: SERVER,
      op: "call_tool",
      outcome: "provider_error",
      tool: "atlassian__getJiraIssue",
      reason: "SESSION_NOT_READY",
    });
  });

  it("listTools THROWS on a refusal so the multiplexer records REMOTE_CATALOG_UNAVAILABLE", async () => {
    const h = gated({ allowed: false, reason: "gate_unavailable", message: "closed" });
    await expect(h.port.listTools()).rejects.toThrow(McpBridgeError);
    expect(h.listTools).not.toHaveBeenCalled();
  });

  it("callTool RETURNS an error outcome rather than throwing — the model is mid-turn", async () => {
    const h = gated({ allowed: false, reason: "not_allowlisted" as never, message: "off" });
    const out = await h.port.callTool("atlassian__getJiraIssue", {});
    expect(out.isError).toBe(true);
    expect(JSON.parse(out.content[0]!.text!)).toMatchObject({ error: "REMOTE_MCP_GATE_REFUSED" });
  });
});

describe("the audit row's shape", () => {
  it("carries the server, the op and the outcome — and no host, no args, no credential", () => {
    recordActivity.mockClear();
    auditRemoteMcp({ serverId: SERVER, op: "call_tool", outcome: "allowed", tool: "atlassian__getJiraIssue" });
    expect(recordActivity).toHaveBeenCalledTimes(1);
    const params = recordActivity.mock.calls[0]![0] as unknown as {
      kind: string;
      sub: string;
      refs: Record<string, unknown>;
      actor: { type: string };
    };
    expect(params.kind).toBe("network");
    expect(params.sub).toBe("remote_mcp");
    expect(params.actor.type).toBe("ai");
    expect(params.refs).toEqual({
      channel: "remote_mcp",
      serverId: SERVER,
      op: "call_tool",
      outcome: "allowed",
      tool: "atlassian__getJiraIssue",
    });
    // The vendor host is deliberately absent: after WARP-2627 the bridge
    // container is the only thing that dials it, and a literal here would make
    // that claim harder to check than a grep.
    expect(JSON.stringify(params.refs)).not.toContain("atlassian.com");
  });

  it("marks a refusal `warn` and an allowed call `info`", () => {
    recordActivity.mockClear();
    auditRemoteMcp({ serverId: SERVER, op: "list_tools", outcome: "allowed" });
    auditRemoteMcp({ serverId: SERVER, op: "list_tools", outcome: "refused_gate", reason: "x" });
    const severities = recordActivity.mock.calls.map(
      (c) => (c[0] as unknown as { severity: string }).severity,
    );
    expect(severities).toEqual(["info", "warn"]);
  });
});
