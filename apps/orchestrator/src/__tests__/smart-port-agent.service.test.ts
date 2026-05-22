/**
 * WARP-399 — smart-port-agent service contract.
 *
 * Verifies the autonomous subscriber's behaviour without touching MQTT
 * or a real Prisma. Stubs the agent loop so we can assert the agent
 * was called with mode=autonomous + the right allowed_tools, and that
 * the audit-row and cooldown are wired correctly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @droplet/tools-core BEFORE importing the service under test.
vi.mock("@droplet/tools-core", () => ({
  TOOLS: new Map([
    [
      "get_switch_ports",
      { name: "get_switch_ports", requiresWrite: false, requiresConfirmation: false },
    ],
    [
      "set_port_vlan",
      { name: "set_port_vlan", requiresWrite: true, requiresConfirmation: true },
    ],
    [
      "initialize_camera",
      { name: "initialize_camera", requiresWrite: true, requiresConfirmation: true },
    ],
  ]),
}));

// Mock the MQTT module to avoid pulling the real broker setup.
vi.mock("../services/mqtt.service.js", () => ({
  subscribeToTopic: vi.fn(() => () => {}),
  publish: vi.fn(),
}));

// Mock runAgent so we control what the loop "thinks" — without it we'd
// need a live ai-gateway stub on every test.
const runAgentMock = vi.fn();
vi.mock("../services/llm-agent.service.js", () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

import { createSmartPortAgent } from "../services/smart-port-agent.service.js";

interface FakeRow {
  id: string;
  [k: string]: unknown;
}

function makePrisma() {
  const auditCreate = vi.fn(async (args: { data: Record<string, unknown> }): Promise<FakeRow> => ({
    id: "audit_1",
    ...args.data,
  }));
  const auditUpdate = vi.fn(async () => ({ id: "audit_1" }));
  const proposalCreate = vi.fn(async (args: { data: Record<string, unknown> }): Promise<FakeRow> => ({
    id: "proposal_1",
    ...args.data,
  }));
  return {
    prisma: {
      commandAuditLog: { create: auditCreate, update: auditUpdate },
      autonomousProposal: { create: proposalCreate },
    } as never,
    auditCreate,
    auditUpdate,
    proposalCreate,
  };
}

function makeAgent(prisma: ReturnType<typeof makePrisma>["prisma"], cooldownMs = 60_000) {
  return createSmartPortAgent({
    prisma,
    mcp: {} as never,
    aiGateway: { chat: vi.fn() as never },
    loadSystemPrompt: async () => "fake system prompt",
    cooldownMs,
    proposalTtlMs: 60 * 60 * 1_000,
    model: "test-model",
  });
}

beforeEach(() => {
  runAgentMock.mockReset();
  runAgentMock.mockResolvedValue({
    message: { role: "assistant", content: "" },
    trace: [],
    iterations: 1,
    stop_reason: "model_done",
  });
});

describe("smart-port-agent", () => {
  it("creates an audit row + calls runAgent with mode=autonomous + the whitelist", async () => {
    const { prisma, auditCreate } = makePrisma();
    const agent = makeAgent(prisma);

    await agent.handleEvent({
      port: 7,
      mac: "E4:30:22:50:2A:FD",
      oui: "E4:30:22",
      source: "mac_table",
      ts: 1779437597,
    });

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      userId: null,
      domain: "smart_port",
      entityId: "port:7",
      tier: 1,
    });
    expect(runAgentMock).toHaveBeenCalledTimes(1);
    const req = runAgentMock.mock.calls[0][1];
    expect(req.mode).toBe("autonomous");
    expect(req.agentRunId).toBe("audit_1");
    expect(req.allowed_tools).toContain("set_port_vlan");
    expect(req.allowed_tools).toContain("get_camera_init_status");
    expect(req.allowed_tools.length).toBeGreaterThanOrEqual(8);
  });

  it("dedups inside the cooldown window for the same (port, mac)", async () => {
    const { prisma, auditCreate } = makePrisma();
    const agent = makeAgent(prisma, 60_000);

    await agent.handleEvent({ port: 7, mac: "E4:30:22:50:2A:FD", source: "mac_table" });
    await agent.handleEvent({ port: 7, mac: "E4:30:22:50:2A:FD", source: "dhcp_lease" });

    expect(auditCreate).toHaveBeenCalledTimes(1);
    expect(runAgentMock).toHaveBeenCalledTimes(1);
  });

  it("different (port, mac) does NOT dedup", async () => {
    const { prisma, auditCreate } = makePrisma();
    const agent = makeAgent(prisma, 60_000);

    await agent.handleEvent({ port: 7, mac: "E4:30:22:50:2A:FD", source: "mac_table" });
    await agent.handleEvent({ port: 8, mac: "AA:BB:CC:00:11:22", source: "mac_table" });

    expect(auditCreate).toHaveBeenCalledTimes(2);
    expect(runAgentMock).toHaveBeenCalledTimes(2);
  });

  it("deferral hook creates an AutonomousProposal for requiresConfirmation tools", async () => {
    const { prisma, proposalCreate } = makePrisma();
    const agent = makeAgent(prisma);

    // Capture the hook runAgent gets and call it ourselves.
    let capturedHook: undefined | ((i: { toolName: string; toolArgs: Record<string, unknown> }) => Promise<unknown>);
    runAgentMock.mockImplementation(async (deps: { deferTier2ToolCall: typeof capturedHook }) => {
      capturedHook = deps.deferTier2ToolCall;
      return {
        message: { role: "assistant", content: "" },
        trace: [],
        iterations: 1,
        stop_reason: "model_done",
      };
    });

    await agent.handleEvent({ port: 7, mac: "E4:30:22:50:2A:FD" });
    expect(capturedHook).toBeDefined();

    // Tier-2 tool → proposal created, returns deferral.
    const tier2 = await capturedHook!({
      toolName: "initialize_camera",
      toolArgs: { ip: "192.168.20.176" },
    });
    expect(proposalCreate).toHaveBeenCalledTimes(1);
    expect(proposalCreate.mock.calls[0][0].data).toMatchObject({
      domain: "smart_port",
      entityId: "port:7",
      toolName: "initialize_camera",
      tier: 2,
      status: "pending",
      agentRunId: "audit_1",
    });
    expect(tier2).toMatchObject({ proposal_id: "proposal_1" });

    // Tier-1 tool → no proposal, returns null.
    const tier1 = await capturedHook!({
      toolName: "get_switch_ports",
      toolArgs: {},
    });
    expect(proposalCreate).toHaveBeenCalledTimes(1); // unchanged
    expect(tier1).toBeNull();

    // Unknown tool → null too (let dispatcher fail loudly).
    const unknown = await capturedHook!({
      toolName: "does_not_exist",
      toolArgs: {},
    });
    expect(proposalCreate).toHaveBeenCalledTimes(1); // unchanged
    expect(unknown).toBeNull();
  });
});
