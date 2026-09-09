/**
 * WARP-2352 — audit rows for the WARP-2305 confirmation interceptor.
 *
 * A confirmation nobody can review afterwards is a UI gesture. Every
 * challenge, refusal, runtime deny and consumed confirmation writes
 * exactly one row through the single writer `activity.service.ts`
 * `record()`, and the scope never carries tool arguments — which on the
 * ERP/health surfaces means PHI.
 *
 * Mutations these are written to catch:
 *   - pass raw tool arguments into the audit scope → the PHI
 *     `not.toContain` assertions go red
 *   - drop the deny row → the deny test goes red
 *   - collapse a challenge and a deny into one outcome → the
 *     distinguishability test goes red
 *   - emit a row for every dispatch → the "read writes no row" test reds
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sdkSpies = vi.hoisted(() => {
  const callTool = vi.fn().mockResolvedValue({ content: [], isError: false });
  const listTools = vi.fn().mockResolvedValue({ tools: [] });
  const connect = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn().mockResolvedValue(undefined);
  return { callTool, listTools, connect, close };
});

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    callTool: sdkSpies.callTool,
    listTools: sdkSpies.listTools,
    connect: sdkSpies.connect,
    close: sdkSpies.close,
  })),
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: vi.fn().mockImplementation(() => ({})),
}));

import { McpClientService } from "../services/mcp-client.service.js";
import {
  confirmationActivityParams,
  confirmedEvent,
  interceptorEventFromContent,
} from "../services/confirmation-audit.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import type { RecordParams } from "../services/activity.service.js";

/** Seeded PHI — must never appear in an audit scope. */
const PHI_NAME = "Camille Moreau";
const PHI_MRN = "MRN-88213";

function textResult(body: unknown, isError = false) {
  return { content: [{ type: "text", text: JSON.stringify(body) }], isError };
}

function challengePayload(tool: string, token = "tok-1") {
  return {
    status: "confirmation_required",
    error: {
      code: "CONFIRMATION_REQUIRED",
      message: `${tool} needs a thumbs-up`,
      details: {
        interceptor: {
          outcome: "confirmation_required",
          tool,
          confirmationToken: token,
          expiresAt: 1_700_000_300_000,
        },
        confirmationToken: token,
        type: tool,
      },
    },
  };
}

function denyPayload(tool: string, reason = "REMOTE_WRITES_DISABLED") {
  return {
    status: "error",
    error: {
      code: "TOOL_DENIED",
      message: "denied",
      details: { interceptor: { outcome: "denied", tool, reason } },
    },
  };
}

function rejectPayload(tool: string, reason = "already_used") {
  return {
    status: "confirmation_required",
    error: {
      code: "CONFIRMATION_REJECTED",
      message: "refused",
      details: { interceptor: { outcome: "confirmation_rejected", tool, reason } },
    },
  };
}

describe("interceptorEventFromContent — reads the machine-readable block", () => {
  it("extracts a challenge without pattern-matching message prose", () => {
    expect(
      interceptorEventFromContent(textResult(challengePayload("delete_file")).content),
    ).toEqual({ outcome: "confirmation_required", tool: "delete_file" });
  });

  it("extracts a deny with its reason code", () => {
    expect(interceptorEventFromContent(textResult(denyPayload("x")).content)).toEqual({
      outcome: "denied",
      tool: "x",
      reason: "REMOTE_WRITES_DISABLED",
    });
  });

  it("extracts a rejected confirmation with its reason", () => {
    expect(interceptorEventFromContent(textResult(rejectPayload("x")).content)).toEqual({
      outcome: "confirmation_rejected",
      tool: "x",
      reason: "already_used",
    });
  });

  it("returns null for an ordinary success, so a read writes no confirmation row", () => {
    expect(interceptorEventFromContent(textResult({ files: [] }).content)).toBeNull();
  });

  it("returns null for a tool-reported failure unrelated to the gate", () => {
    expect(
      interceptorEventFromContent(
        textResult({ status: "error", error: { code: "NOT_FOUND", message: "no" } }).content,
      ),
    ).toBeNull();
  });

  it("survives a non-JSON body without throwing", () => {
    expect(interceptorEventFromContent([{ type: "text", text: "not json" }])).toBeNull();
    expect(interceptorEventFromContent([])).toBeNull();
  });
});

describe("confirmedEvent — the confirm-consumed case", () => {
  it("is emitted when a token was presented and the call succeeded", () => {
    expect(confirmedEvent({ tool: "memory_forget", presentedToken: true, isError: false })).toEqual(
      { outcome: "confirmed", tool: "memory_forget" },
    );
  });

  it("is NOT emitted when no token was presented", () => {
    expect(
      confirmedEvent({ tool: "list_files", presentedToken: false, isError: false }),
    ).toBeNull();
  });

  it("is NOT emitted when the confirmed call failed", () => {
    expect(
      confirmedEvent({ tool: "memory_forget", presentedToken: true, isError: true }),
    ).toBeNull();
  });
});

describe("confirmationActivityParams — PHI-free scope (WARP-2352)", () => {
  it("carries the tool and outcome, never an argument payload", () => {
    const params = confirmationActivityParams(
      { outcome: "confirmation_required", tool: "erp_schedule_appointment" },
      { userId: "alice" },
    );

    // Mutation: pass raw tool arguments into the audit scope → red.
    const serialized = JSON.stringify(params);
    expect(serialized).not.toContain(PHI_NAME);
    expect(serialized).not.toContain(PHI_MRN);
    expect(params.refs).toEqual({
      name: "erp_schedule_appointment",
      confirmation: "confirmation_required",
      userId: "alice",
      ticket: "WARP-2305",
    });
  });

  it("routes through the recorder's accepted enums", () => {
    const params = confirmationActivityParams({ outcome: "denied", tool: "x" }, {});
    expect(params.kind).toBe("tool_call");
    expect(params.severity).toBe("warn");
    expect(params.actor).toEqual({ type: "ai", id: null });
  });

  it("distinguishes a challenge from a deny from a consumed confirmation", () => {
    const of = (outcome: "confirmation_required" | "denied" | "confirmed" | "confirmation_rejected") =>
      confirmationActivityParams({ outcome, tool: "t" }, {});

    const kinds = [
      of("confirmation_required"),
      of("confirmation_rejected"),
      of("denied"),
      of("confirmed"),
    ];
    // Each is separately identifiable in the log — an operator filtering
    // "what was refused" must not also match "what was approved".
    const markers = kinds.map((k) => (k.refs as { confirmation: string }).confirmation);
    expect(new Set(markers).size).toBe(4);
    expect(new Set(kinds.map((k) => k.what)).size).toBe(4);
    expect(kinds.map((k) => k.severity)).toEqual(["info", "warn", "warn", "ok"]);
  });
});

describe("McpClientService writes exactly one confirmation row per dispatch (WARP-2352)", () => {
  let svc: McpClientService;
  let rows: RecordParams[];

  beforeEach(async () => {
    rows = [];
    _setActivityRecorderForTests(
      {
        record: async (params: RecordParams) => {
          rows.push(params);
          return null as never;
        },
      },
      null,
    );
    sdkSpies.callTool.mockReset();
    svc = new McpClientService({ command: "node", args: ["fake.js"] });
    await svc.start();
  });

  afterEach(() => {
    _setActivityRecorderForTests(null, null);
  });

  /** Rows this story adds, separated from the pre-existing dispatch row. */
  const confirmationRows = () =>
    rows.filter((r) => (r.refs as { confirmation?: string } | null)?.confirmation);

  it("writes ONE row for a first-call challenge", async () => {
    sdkSpies.callTool.mockResolvedValue(textResult(challengePayload("delete_file")));

    await svc.callTool("delete_file", { path: `/patients/${PHI_NAME}.pdf` }, { userId: "alice" });
    await flush();

    expect(confirmationRows()).toHaveLength(1);
    expect(confirmationRows()[0]!.refs).toMatchObject({
      name: "delete_file",
      confirmation: "confirmation_required",
    });
    // The arguments carried PHI. The audit must not have.
    expect(JSON.stringify(confirmationRows())).not.toContain(PHI_NAME);
  });

  it("writes ONE row for a runtime deny", async () => {
    sdkSpies.callTool.mockResolvedValue(textResult(denyPayload("remote_delete"), true));

    await svc.callTool("remote_delete", { mrn: PHI_MRN }, { userId: "alice" });
    await flush();

    // Mutation: drop the deny row → red.
    expect(confirmationRows()).toHaveLength(1);
    expect(confirmationRows()[0]!.refs).toMatchObject({
      confirmation: "denied",
      reason: "REMOTE_WRITES_DISABLED",
    });
    expect(JSON.stringify(confirmationRows())).not.toContain(PHI_MRN);
  });

  it("writes ONE row for a consumed confirmation", async () => {
    sdkSpies.callTool.mockResolvedValue(textResult({ forgotten: true }));

    await svc.callTool(
      "memory_forget",
      { id: "f1", note: PHI_NAME },
      { userId: "alice", confirmationToken: "tok-1" },
    );
    await flush();

    expect(confirmationRows()).toHaveLength(1);
    expect(confirmationRows()[0]!.refs).toMatchObject({
      name: "memory_forget",
      confirmation: "confirmed",
    });
    expect(JSON.stringify(confirmationRows())).not.toContain(PHI_NAME);
  });

  it("a first-call refusal is DISTINGUISHABLE from a deny in the audit", async () => {
    sdkSpies.callTool.mockResolvedValue(textResult(challengePayload("t")));
    await svc.callTool("t", {}, {});
    sdkSpies.callTool.mockResolvedValue(textResult(denyPayload("t"), true));
    await svc.callTool("t", {}, {});
    await flush();

    const marks = confirmationRows().map((r) => (r.refs as { confirmation: string }).confirmation);
    expect(marks).toEqual(["confirmation_required", "denied"]);
  });

  it("writes NO confirmation row for an ordinary read", async () => {
    sdkSpies.callTool.mockResolvedValue(textResult({ files: [] }));

    await svc.callTool("list_files", { path: "/" }, { userId: "alice" });
    await flush();

    // The pre-existing per-dispatch `tool_call` row is untouched...
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // ...but the gate said nothing, so it logs nothing.
    expect(confirmationRows()).toHaveLength(0);
  });

  it("keeps the pre-existing per-dispatch row intact alongside the new one", async () => {
    sdkSpies.callTool.mockResolvedValue(textResult(challengePayload("delete_file")));
    await svc.callTool("delete_file", { path: "/a" }, { userId: "alice" });
    await flush();

    const dispatchRow = rows.find((r) => r.sourceIcon === "wrench");
    expect(dispatchRow, "WARP-456 dispatch row must still be written").toBeDefined();
    expect(dispatchRow!.refs).toMatchObject({ name: "delete_file" });
  });
});

/** The recorder calls are fire-and-forget; let the microtask queue drain. */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}
