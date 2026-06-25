/**
 * WARP-41: network-safety token-binding tests.
 *
 * Covers `confirmNetworkCommand` — the confirm path for Tier 2/3 network ops
 * (block_device, unblock_device, add_port_forward, set_wifi_password, reboot).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  evaluateNetworkCommand,
  confirmNetworkCommand,
} from "../services/network-safety.service.js";

function createMockPrisma() {
  const prisma = new PrismaClient() as unknown as PrismaClient & {
    commandAuditLog: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  (prisma as any).commandAuditLog = {
    create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    findMany: vi.fn().mockResolvedValue([]),
  };
  return prisma;
}

describe("confirmNetworkCommand (WARP-41)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  async function issueToken(
    entityId: string,
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<string> {
    return issueTokenAs("user-1", entityId, operation, params);
  }

  async function issueTokenAs(
    minterId: string,
    entityId: string,
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<string> {
    const result = await evaluateNetworkCommand(prisma, entityId, operation, params, minterId);
    expect("confirmationToken" in result).toBe(true);
    return (result as any).confirmationToken as string;
  }

  it("accepts matching operation echo", async () => {
    const token = await issueToken(
      "firewall.block.aa:bb:cc:dd:ee:ff",
      "block_device",
      { mac: "aa:bb:cc:dd:ee:ff" },
    );

    const result = await confirmNetworkCommand(prisma, token, "user-1", {
      operation: "block_device",
    });

    expect(result.confirmed).toBe(true);
    if (result.confirmed) {
      expect(result.operation).toBe("block_device");
      expect(result.params?.mac).toBe("aa:bb:cc:dd:ee:ff");
    }
  });

  it("accepts matching operation + entityId echo", async () => {
    const token = await issueToken(
      "firewall.block.aa:bb:cc:dd:ee:ff",
      "block_device",
      { mac: "aa:bb:cc:dd:ee:ff" },
    );

    const result = await confirmNetworkCommand(prisma, token, "user-1", {
      operation: "block_device",
      entityId: "firewall.block.aa:bb:cc:dd:ee:ff",
    });

    expect(result.confirmed).toBe(true);
  });

  it("rejects mismatched operation with TOKEN_OPERATION_MISMATCH", async () => {
    const token = await issueToken(
      "firewall.block.aa:bb:cc:dd:ee:ff",
      "block_device",
      { mac: "aa:bb:cc:dd:ee:ff" },
    );

    const result = await confirmNetworkCommand(prisma, token, "user-1", {
      operation: "unblock_device", // caller thinks they're unblocking
    });

    expect(result.confirmed).toBe(false);
    if (!result.confirmed) {
      expect(result.code).toBe("TOKEN_OPERATION_MISMATCH");
      expect(result.reason).toContain("block_device");
    }
  });

  it("rejects mismatched entityId with TOKEN_OPERATION_MISMATCH", async () => {
    const token = await issueToken(
      "firewall.block.aa:bb:cc:dd:ee:ff",
      "block_device",
      { mac: "aa:bb:cc:dd:ee:ff" },
    );

    const result = await confirmNetworkCommand(prisma, token, "user-1", {
      operation: "block_device",
      entityId: "firewall.block.99:88:77:66:55:44", // different MAC
    });

    expect(result.confirmed).toBe(false);
    if (!result.confirmed) {
      expect(result.code).toBe("TOKEN_OPERATION_MISMATCH");
    }
  });

  it("returns TOKEN_MISSING for unknown tokens", async () => {
    const result = await confirmNetworkCommand(prisma, "not-a-real-token", "user-1", {
      operation: "block_device",
    });

    expect(result.confirmed).toBe(false);
    if (!result.confirmed) {
      expect(result.code).toBe("TOKEN_MISSING");
    }
  });

  it("returns TOKEN_EXPIRED past 60s", async () => {
    const token = await issueToken(
      "firewall.block.aa:bb:cc:dd:ee:ff",
      "block_device",
      { mac: "aa:bb:cc:dd:ee:ff" },
    );

    const realDateNow = Date.now;
    Date.now = vi.fn(() => realDateNow() + 61_000);
    try {
      const result = await confirmNetworkCommand(prisma, token, "user-1", {
        operation: "block_device",
      });
      expect(result.confirmed).toBe(false);
      if (!result.confirmed) {
        expect(result.code).toBe("TOKEN_EXPIRED");
      }
    } finally {
      Date.now = realDateNow;
    }
  });

  it("returns TOKEN_USER_MISMATCH when a different user confirms", async () => {
    const token = await issueToken(
      "firewall.block.aa:bb:cc:dd:ee:ff",
      "block_device",
      { mac: "aa:bb:cc:dd:ee:ff" },
    );

    const result = await confirmNetworkCommand(prisma, token, "user-2", {
      operation: "block_device",
    });

    expect(result.confirmed).toBe(false);
    if (!result.confirmed) {
      expect(result.code).toBe("TOKEN_USER_MISMATCH");
    }
  });

  it("replay-after-success fails with TOKEN_MISSING", async () => {
    const token = await issueToken(
      "firewall.block.aa:bb:cc:dd:ee:ff",
      "block_device",
      { mac: "aa:bb:cc:dd:ee:ff" },
    );

    const first = await confirmNetworkCommand(prisma, token, "user-1", {
      operation: "block_device",
    });
    expect(first.confirmed).toBe(true);

    const replay = await confirmNetworkCommand(prisma, token, "user-1", {
      operation: "block_device",
    });
    expect(replay.confirmed).toBe(false);
    if (!replay.confirmed) {
      expect(replay.code).toBe("TOKEN_MISSING");
    }
  });

  // ── Agent-proposed (service-minted) ops: agent proposes, human disposes ──
  //
  // When the agent dispatches a requiresConfirmation tool through the MCP
  // principal, the orchestrator mints the pending op under "_service:mcp".
  // The service principal can never sign/execute its own op, so an AUTHORIZED
  // human (already gated by the route's role guard) must be able to confirm
  // it. A same-id rule here would dead-end every agent→human confirmation
  // with TOKEN_USER_MISMATCH — the bug this branch fixes.

  it("agent flow: a service-minted op (add_port_forward) is confirmable by a human", async () => {
    const token = await issueTokenAs(
      "_service:mcp",
      "firewall.redirect.ssh",
      "add_port_forward",
      { name: "ssh", src_port: "2222", dest_ip: "10.0.0.5", dest_port: "22", proto: "tcp" },
    );

    const result = await confirmNetworkCommand(prisma, token, "u-owner", {
      operation: "add_port_forward",
    });

    expect(result.confirmed).toBe(true);
    if (result.confirmed) {
      expect(result.operation).toBe("add_port_forward");
      expect(result.params?.dest_ip).toBe("10.0.0.5");
    }
  });

  it("agent flow: the service principal CANNOT self-confirm its own op", async () => {
    const token = await issueTokenAs(
      "_service:mcp",
      "firewall.redirect.ssh",
      "add_port_forward",
      { name: "ssh", src_port: "2222", dest_ip: "10.0.0.5", dest_port: "22", proto: "tcp" },
    );

    const result = await confirmNetworkCommand(prisma, token, "_service:mcp", {
      operation: "add_port_forward",
    });

    expect(result.confirmed).toBe(false);
    if (!result.confirmed) {
      expect(result.code).toBe("TOKEN_USER_MISMATCH");
    }
  });

  it("agent flow: no other service principal can dispose of an agent-minted op", async () => {
    const token = await issueTokenAs(
      "_service:mcp",
      "firewall.redirect.ssh",
      "add_port_forward",
      { name: "ssh", src_port: "2222", dest_ip: "10.0.0.5", dest_port: "22", proto: "tcp" },
    );

    const result = await confirmNetworkCommand(prisma, token, "_service:voice", {
      operation: "add_port_forward",
    });

    expect(result.confirmed).toBe(false);
    if (!result.confirmed) {
      expect(result.code).toBe("TOKEN_USER_MISMATCH");
    }
  });

  it("user-minted ops still require the SAME user (no regression)", async () => {
    // A human-initiated op (e.g. dashboard add_port_forward where one person
    // both mints and confirms) keeps the strict same-id binding.
    const token = await issueTokenAs(
      "u-owner",
      "firewall.redirect.ssh",
      "add_port_forward",
      { name: "ssh", src_port: "2222", dest_ip: "10.0.0.5", dest_port: "22", proto: "tcp" },
    );

    const mismatch = await confirmNetworkCommand(prisma, token, "u-admin", {
      operation: "add_port_forward",
    });
    expect(mismatch.confirmed).toBe(false);
    if (!mismatch.confirmed) {
      expect(mismatch.code).toBe("TOKEN_USER_MISMATCH");
    }

    const same = await confirmNetworkCommand(prisma, token, "u-owner", {
      operation: "add_port_forward",
    });
    expect(same.confirmed).toBe(true);
  });

  it("confused-deputy scenario: two pending ops, confirming B with A's echo fails", async () => {
    // Two different pending confirmations for the same user
    const tokenA = await issueToken(
      "firewall.block.aa:aa:aa:aa:aa:aa",
      "block_device",
      { mac: "aa:aa:aa:aa:aa:aa" },
    );
    const tokenB = await issueToken(
      "firewall.redirect.ssh",
      "add_port_forward",
      { name: "ssh", src_port: "22", dest_ip: "10.0.0.5", dest_port: "22", proto: "tcp" },
    );

    // Caller thinks they're confirming B (add_port_forward) but hands over A's token.
    const confused = await confirmNetworkCommand(prisma, tokenA, "user-1", {
      operation: "add_port_forward",
    });
    expect(confused.confirmed).toBe(false);
    if (!confused.confirmed) {
      expect(confused.code).toBe("TOKEN_OPERATION_MISMATCH");
    }

    // Both tokens should still work when confirmed correctly — A was rejected,
    // not consumed.
    const a = await confirmNetworkCommand(prisma, tokenA, "user-1", {
      operation: "block_device",
    });
    expect(a.confirmed).toBe(true);

    const b = await confirmNetworkCommand(prisma, tokenB, "user-1", {
      operation: "add_port_forward",
    });
    expect(b.confirmed).toBe(true);
  });
});
