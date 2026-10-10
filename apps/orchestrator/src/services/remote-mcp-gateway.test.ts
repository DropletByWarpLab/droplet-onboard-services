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
import { withRemoteCallAttribution } from "./remote-call-attribution.js";
import { redactSecretParams, REDACTION_PLACEHOLDER } from "../lib/log-redaction.js";
import {
  auditRemoteMcp,
  abortRemoteMcpInFlight,
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

// WARP-2439 — capture every log line so the rule-19 test can assert on them.
const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock("../lib/logger.js", () => {
  const sink = (...a: unknown[]) => void logged.push(a);
  return { createLogger: () => ({ warn: sink, info: sink, error: sink, debug: sink }) };
});

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
  it("allows a CONNECTED row holding a credential with no env and no channel row (WARP-3960)", async () => {
    // No `offLanAllowlistChannel` on this prisma at all: the gate must not read it.
    const prisma = {
      integrationConnection: {
        findFirst: async () => ({ id: "c1", status: "CONNECTED", providerTokensEnc: "dcv1:x" }),
      },
    };
    expect(await remoteMcpGate(prisma, SERVER)).toEqual({ allowed: true });
  });

  it("distinguishes no-row, wrong-status and no-credential — three different remedies", async () => {
    const row = (over: Record<string, unknown>) => ({
      integrationConnection: {
        findFirst: async () => ({ id: "c1", status: "CONNECTED", providerTokensEnc: "dcv1:x", ...over }),
      },
    });
    expect(
      await remoteMcpGate({ integrationConnection: { findFirst: async () => null } }, SERVER),
    ).toMatchObject({ reason: "no_connection_row" });
    expect(await remoteMcpGate(row({ status: "ERROR" }), SERVER)).toMatchObject({
      reason: "connection_not_connected",
    });
    expect(await remoteMcpGate(row({ providerTokensEnc: null }), SERVER)).toMatchObject({
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
    const d = await remoteMcpGate(prisma, SERVER);
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
    const h = gated({ allowed: false, reason: "connection_disabled", message: "off" });
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

// WARP-2439 — every remote call writes a PHI-free row naming the member.
describe("every remote call is audited, with the requesting member", () => {
  const REFUSED: RemoteMcpGateDecision = { allowed: false, reason: "no_credential", message: "off" };
  const rows = () =>
    recordActivity.mock.calls.map(
      (c) => c[0] as unknown as { actor: { type: string }; sub: string; refs: Record<string, unknown> },
    );

  function realAudit(decision: RemoteMcpGateDecision, over: Partial<McpClientPort> = {}) {
    const up = upstreamDouble(over);
    recordActivity.mockClear();
    return createGatedRemoteMcpPort({ serverId: SERVER, upstream: up.port, gate: async () => decision });
  }

  it("a refused call writes a row naming the member, the server and the tool", async () => {
    const port = realAudit(REFUSED);
    await withRemoteCallAttribution({ userId: "alice", agentRunId: "run-1" }, () =>
      port.callTool("getJiraIssue", { issue: "PHI-123" }),
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0]!.refs).toMatchObject({
      serverId: SERVER,
      op: "call_tool",
      outcome: "refused_gate",
      tool: "getJiraIssue",
      reason: "no_credential",
      userId: "alice",
      agentRunId: "run-1",
    });
    expect(rows()[0]!.sub).toContain("alice");
  });

  it("an allowed call names the member", async () => {
    const port = realAudit({ allowed: true });
    await withRemoteCallAttribution({ userId: "alice" }, () => port.callTool("t", {}));
    expect(rows()[0]!.refs).toMatchObject({ outcome: "allowed", userId: "alice" });
  });

  it("a provider error names the member", async () => {
    const port = realAudit(
      { allowed: true },
      {
        callTool: vi.fn(async () => {
          throw new McpBridgeError("SESSION_NOT_READY", "x", 503);
        }),
      },
    );
    await withRemoteCallAttribution({ userId: "bob" }, () => port.callTool("t", {}));
    expect(rows()[0]!.refs).toMatchObject({ outcome: "provider_error", userId: "bob" });
  });

  it("an aborted call is its own outcome", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const port = realAudit(
      { allowed: true },
      {
        callTool: vi.fn(async () => {
          throw abort;
        }),
      },
    );
    await port.callTool("t", {});
    expect(rows()[0]!.refs).toMatchObject({ outcome: "aborted", reason: "aborted" });
  });

  it("a catalog listing outside a member scope names no member", async () => {
    const port = realAudit({ allowed: true });
    await port.listTools();
    expect(rows()[0]!.refs).toMatchObject({ op: "list_tools", outcome: "allowed" });
    expect(rows()[0]!.refs).not.toHaveProperty("userId");
  });
});

// WARP-2439 — rule 19: a remote tool's arguments never reach a log line or the row.
describe("a remote tool's arguments never reach logs or the audit row", () => {
  const SECRETS = ["sk-live-AAAA1111BBBB2222", "hunter2-p@ssw0rd", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"];
  const args = {
    api_key: SECRETS[0],
    nested: { password: SECRETS[1], note: "patient John Doe, DOB 1970-01-01" },
    headers: { Authorization: `Bearer ${SECRETS[2]}` },
  };

  it("denied and failed calls leave no argument value in the rows or the logs", async () => {
    recordActivity.mockClear();
    logged.length = 0;
    const failing = upstreamDouble({
      callTool: vi.fn(async () => {
        throw new McpBridgeError("REMOTE_CALL_FAILED", "boom", 502);
      }),
    });
    const decisions: RemoteMcpGateDecision[] = [
      { allowed: false, reason: "gate_unavailable", message: "closed" },
      { allowed: true },
    ];
    for (const d of decisions) {
      const port = createGatedRemoteMcpPort({ serverId: SERVER, upstream: failing.port, gate: async () => d });
      await port.callTool("createIssue", args);
    }
    const everything = JSON.stringify([recordActivity.mock.calls, logged]);
    for (const s of SECRETS) expect(everything).not.toContain(s);
    expect(everything).not.toContain("John Doe");
    expect(recordActivity).toHaveBeenCalledTimes(2);
  });

  it("the shared redaction helper masks secret-looking argument values", () => {
    const out = JSON.stringify(redactSecretParams(args));
    for (const s of SECRETS) expect(out).not.toContain(s);
    expect(out).toContain(REDACTION_PLACEHOLDER);
  });
});

describe("WARP-3960 — the per-server off is the kill switch (no owner switch, no allowlist)", () => {
  const connected = {
    findFirst: async () => ({ id: "c1", status: "DISABLED", providerTokensEnc: "dcv1:x" }),
  };

  it("refuses a DISABLED connection, a stored credential notwithstanding", async () => {
    const d = await remoteMcpGate({ integrationConnection: connected }, SERVER);
    expect(d).toMatchObject({ allowed: false, reason: "connection_disabled" });
  });

  it("a DISABLED connection refuses even when a member's sign-in is CONNECTED", async () => {
    const count = vi.fn(async () => 1);
    const d = await remoteMcpGate({ integrationConnection: connected, mcpOAuthConnection: { count } }, SERVER);
    expect(d).toMatchObject({ allowed: false, reason: "connection_disabled" });
    expect(count).not.toHaveBeenCalled();
  });

  it("a tool call through the real gate with the server off is refused, audited, and never dials", async () => {
    const up = upstreamDouble();
    const audit = vi.fn();
    const port = createGatedRemoteMcpPort({
      serverId: SERVER,
      upstream: up.port,
      gate: () => remoteMcpGate({ integrationConnection: connected }, SERVER),
      audit,
    });
    const out = await port.callTool("atlassian__getJiraIssue", {});
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain("turned this connection off");
    expect(up.callTool).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ op: "call_tool", outcome: "refused_gate", reason: "connection_disabled" }),
    );
  });

  it("turning the server off aborts a call that is already in flight, with an audited refusal", async () => {
    const callTool = vi.fn(() => new Promise<never>(() => undefined)); // never settles
    const h = gated({ allowed: true }, { callTool: callTool as McpClientPort["callTool"] });
    const pending = h.port.callTool("atlassian__searchJiraIssuesUsingJql", {});
    await new Promise((r) => setTimeout(r, 0));
    expect(abortRemoteMcpInFlight(SERVER)).toBe(1);
    const out = await pending;
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).toContain("turned this connection off");
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ op: "call_tool", outcome: "refused_gate" }),
    );
    expect(abortRemoteMcpInFlight()).toBe(0);
  });
});
