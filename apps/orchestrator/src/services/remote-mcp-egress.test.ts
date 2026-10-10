/** WARP-2405 - the pre-credential rules every remote MCP hop shares. */
import { describe, expect, it, vi } from "vitest";
import { remoteMcpEgressAllowed, remoteMcpGate } from "./remote-mcp-gateway.service.js";

vi.mock("./activity.singleton.js", () => ({ recordActivity: vi.fn(async () => null), getActivitySigner: () => null }));
vi.mock("../lib/logger.js", () => ({ createLogger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }) }));

const S = "atlassian";
const allow = new Set([S]);
type Row = { id: string; status: string; providerTokensEnc: string | null } | null;
const prisma = (o: { enabled?: boolean | "throw"; row?: Row | "throw" }) => ({
  offLanAllowlistChannel: {
    findUnique: vi.fn(async () => {
      if (o.enabled === "throw") throw new Error("db");
      return o.enabled === undefined ? null : { enabled: o.enabled };
    }),
  },
  integrationConnection: {
    findFirst: vi.fn(async () => {
      if (o.row === "throw") throw new Error("db");
      return o.row ?? null;
    }),
  },
});
const row = (status: string): Row => ({ id: "c", status, providerTokensEnc: "dcv1:x" });

describe("remoteMcpEgressAllowed", () => {
  it("refuses a server that is not allowlisted before reading anything", async () => {
    const p = prisma({ enabled: true });
    expect(await remoteMcpEgressAllowed(p, S, new Set())).toMatchObject({ allowed: false, reason: "server_not_allowlisted" });
    expect(p.offLanAllowlistChannel.findUnique).not.toHaveBeenCalled();
  });

  it("refuses when the remote_mcp channel is off, absent, or unreadable", async () => {
    expect(await remoteMcpEgressAllowed(prisma({ enabled: false }), S, allow)).toMatchObject({ reason: "channel_disabled" });
    expect(await remoteMcpEgressAllowed(prisma({}), S, allow)).toMatchObject({ reason: "channel_disabled" });
    expect(await remoteMcpEgressAllowed(prisma({ enabled: "throw" }), S, allow)).toMatchObject({ reason: "gate_unavailable" });
  });

  it("refuses a connection an admin turned off, and a failed read", async () => {
    expect(await remoteMcpEgressAllowed(prisma({ enabled: true, row: row("DISABLED") }), S, allow)).toMatchObject({ allowed: false, reason: "connection_disabled" });
    expect(await remoteMcpEgressAllowed(prisma({ enabled: true, row: "throw" }), S, allow)).toMatchObject({ reason: "gate_unavailable" });
  });

  it("does not demand a credential, and does not block on a dead shared token", async () => {
    expect(await remoteMcpEgressAllowed(prisma({ enabled: true, row: null }), S, allow)).toMatchObject({ allowed: true });
    expect(await remoteMcpEgressAllowed(prisma({ enabled: true, row: row("NEEDS_RECONNECT") }), S, allow)).toMatchObject({ allowed: true });
  });

  it("is the first half of the tool-call gate, with no behaviour change", async () => {
    expect(await remoteMcpGate(prisma({ enabled: true, row: row("DISABLED") }), S, allow)).toMatchObject({ reason: "connection_disabled" });
    expect(await remoteMcpGate(prisma({ enabled: true, row: null }), S, allow)).toMatchObject({ reason: "no_connection_row" });
    expect(await remoteMcpGate(prisma({ enabled: true, row: row("CONNECTED") }), S, allow)).toEqual({ allowed: true });
  });
});
