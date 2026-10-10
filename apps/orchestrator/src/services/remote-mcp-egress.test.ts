/** WARP-2405 - the pre-credential rule every remote MCP hop shares (WARP-3960: only the per-server off). */
import { describe, expect, it, vi } from "vitest";
import { remoteMcpEgressAllowed, remoteMcpGate } from "./remote-mcp-gateway.service.js";

vi.mock("./activity.singleton.js", () => ({ recordActivity: vi.fn(async () => null), getActivitySigner: () => null }));
vi.mock("../lib/logger.js", () => ({ createLogger: () => ({ warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }) }));

const S = "atlassian";
type Row = { id: string; status: string; providerTokensEnc: string | null } | null;
// No `offLanAllowlistChannel` on purpose: since WARP-3960 the gate never reads the
// remote_mcp channel, so a prisma without that model must work.
const prisma = (o: { row?: Row | "throw" }) => ({
  integrationConnection: {
    findFirst: vi.fn(async () => {
      if (o.row === "throw") throw new Error("db");
      return o.row ?? null;
    }),
  },
});
const row = (status: string): Row => ({ id: "c", status, providerTokensEnc: "dcv1:x" });

describe("remoteMcpEgressAllowed", () => {
  it("needs no env allowlist and no channel row: an unconfigured box with a registered server is allowed", async () => {
    expect(await remoteMcpEgressAllowed(prisma({ row: null }), S)).toMatchObject({ allowed: true });
  });

  it("refuses a connection an admin turned off, and a failed read", async () => {
    expect(await remoteMcpEgressAllowed(prisma({ row: row("DISABLED") }), S)).toMatchObject({ allowed: false, reason: "connection_disabled" });
    expect(await remoteMcpEgressAllowed(prisma({ row: "throw" }), S)).toMatchObject({ reason: "gate_unavailable" });
  });

  it("does not demand a credential, and does not block on a dead shared token", async () => {
    expect(await remoteMcpEgressAllowed(prisma({ row: null }), S)).toMatchObject({ allowed: true });
    expect(await remoteMcpEgressAllowed(prisma({ row: row("NEEDS_RECONNECT") }), S)).toMatchObject({ allowed: true });
  });

  it("is the first half of the tool-call gate, with no behaviour change", async () => {
    expect(await remoteMcpGate(prisma({ row: row("DISABLED") }), S)).toMatchObject({ reason: "connection_disabled" });
    expect(await remoteMcpGate(prisma({ row: null }), S)).toMatchObject({ reason: "no_connection_row" });
    expect(await remoteMcpGate(prisma({ row: row("CONNECTED") }), S)).toEqual({ allowed: true });
  });
});
