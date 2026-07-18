/**
 * WARP-353 — safety-tier *target axis* (ADR-014 "Core mechanism").
 *
 * The safety-tier service is generalized with a target dimension rather
 * than a new tier system:
 *
 *   target: 'self' | { kind: 'client', deviceId: string }
 *
 * - Default 'self': the existing Tier-2 flow is byte-for-byte unchanged
 *   (regression block below asserts the exact return shapes and pending-
 *   confirmation semantics the pre-353 callers rely on).
 * - target = client: the confirmationToken binding is extended to
 *   { service, action/entityId, resourceId/nodeId, targetDeviceId }. The
 *   confirmation surface is the CLIENT's native modal (no dashboard
 *   /command/confirm round-trip) — a dashboard-style confirm that does
 *   not echo the targetDeviceId MUST be rejected, and vice-versa a
 *   client-echoed confirm on a self-minted token must be rejected.
 * - Audit rows carry the target device id + request id WITHOUT a schema
 *   migration (folded into the data JSON, same pattern as KAN-7's
 *   `_command`); the signed per-device ActivityRow axis is WARP-1299.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  evaluateCommand,
  confirmCommand,
  type DispatchTarget,
} from "../services/safety-tier.service.js";

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

const CLIENT_TARGET: DispatchTarget = {
  kind: "client",
  deviceId: "dc-stefans-macbook",
};

describe("safety-tier target axis (WARP-353)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  // ── Regression: default 'self' flow unchanged ──

  describe("target defaults to 'self' — existing flow byte-for-byte", () => {
    it("omitting target behaves identically to pre-353 (Tier-2 202 shape has no target fields)", async () => {
      const result = await evaluateCommand(
        prisma,
        "lock.front-door",
        "lock",
        undefined,
        "user-1",
      );
      expect(result.allowed).toBe(false);
      if (result.allowed !== false || !("requiresConfirmation" in result)) {
        throw new Error("expected Tier-2 confirmation result");
      }
      expect(result.requiresConfirmation).toBe(true);
      expect(typeof result.confirmationToken).toBe("string");
      // The self-target result must NOT grow new fields — existing
      // clients JSON-roundtrip this object into a 202 body.
      expect("targetDeviceId" in result).toBe(false);
      expect("confirmationSurface" in result).toBe(false);
    });

    it("explicit target:'self' is identical to omitting it", async () => {
      const result = await evaluateCommand(
        prisma,
        "lock.front-door",
        "lock",
        undefined,
        "user-1",
        undefined,
        "self",
      );
      if (!("requiresConfirmation" in result) || !result.requiresConfirmation) {
        throw new Error("expected Tier-2 confirmation result");
      }
      expect("targetDeviceId" in result).toBe(false);

      // And the token confirms through the classic dashboard path.
      const confirmed = await confirmCommand(
        prisma,
        result.confirmationToken,
        "user-1",
        { service: "lock" },
      );
      expect(confirmed.confirmed).toBe(true);
    });

    it("Tier-1 self commands stay auto-allowed", async () => {
      const result = await evaluateCommand(
        prisma,
        "light.kitchen",
        "turn_on",
        undefined,
        "user-1",
        undefined,
        "self",
      );
      expect(result).toEqual({ allowed: true, tier: 1 });
    });
  });

  // ── Client target: token binding + confirmation surface ──

  describe("target = { kind: 'client' }", () => {
    it("mints a Tier-2 token bound to the targetDeviceId and says the surface is the client", async () => {
      const result = await evaluateCommand(
        prisma,
        "client_tool.open_file",
        "open_file",
        { path: "/Users/stefan/brief.pdf" },
        "user-1",
        undefined,
        CLIENT_TARGET,
      );
      if (!("requiresConfirmation" in result) || !result.requiresConfirmation) {
        throw new Error("expected Tier-2 confirmation result");
      }
      expect(result.targetDeviceId).toBe("dc-stefans-macbook");
      expect(result.confirmationSurface).toBe("client");
    });

    it("REJECTS a dashboard-style confirm (no targetDeviceId echo) on a client-minted token", async () => {
      const result = await evaluateCommand(
        prisma,
        "client_tool.open_file",
        "open_file",
        undefined,
        "user-1",
        undefined,
        CLIENT_TARGET,
      );
      if (!("requiresConfirmation" in result) || !result.requiresConfirmation) {
        throw new Error("expected Tier-2 confirmation result");
      }
      const confirmed = await confirmCommand(
        prisma,
        result.confirmationToken,
        "user-1",
        { service: "open_file" }, // no targetDeviceId — dashboard round-trip
      );
      expect(confirmed.confirmed).toBe(false);
      if (confirmed.confirmed) throw new Error("unreachable");
      expect(confirmed.code).toBe("TOKEN_OPERATION_MISMATCH");
    });

    it("REJECTS a confirm echoing the WRONG targetDeviceId", async () => {
      const result = await evaluateCommand(
        prisma,
        "client_tool.open_file",
        "open_file",
        undefined,
        "user-1",
        undefined,
        CLIENT_TARGET,
      );
      if (!("requiresConfirmation" in result) || !result.requiresConfirmation) {
        throw new Error("expected Tier-2 confirmation result");
      }
      const confirmed = await confirmCommand(
        prisma,
        result.confirmationToken,
        "user-1",
        { service: "open_file", targetDeviceId: "dc-someone-else" },
      );
      expect(confirmed.confirmed).toBe(false);
      if (confirmed.confirmed) throw new Error("unreachable");
      expect(confirmed.code).toBe("TOKEN_OPERATION_MISMATCH");
    });

    it("CONFIRMS when the client surface echoes the bound targetDeviceId", async () => {
      const result = await evaluateCommand(
        prisma,
        "client_tool.open_file",
        "open_file",
        { path: "/tmp/x" },
        "user-1",
        undefined,
        CLIENT_TARGET,
      );
      if (!("requiresConfirmation" in result) || !result.requiresConfirmation) {
        throw new Error("expected Tier-2 confirmation result");
      }
      const confirmed = await confirmCommand(
        prisma,
        result.confirmationToken,
        "user-1",
        { service: "open_file", targetDeviceId: "dc-stefans-macbook" },
      );
      expect(confirmed.confirmed).toBe(true);
      if (!confirmed.confirmed) throw new Error("unreachable");
      expect(confirmed.targetDeviceId).toBe("dc-stefans-macbook");
    });

    it("auto-allows Tier-1 client tools (notify) with the target audited", async () => {
      const result = await evaluateCommand(
        prisma,
        "client_tool.notify",
        "notify",
        { title: "Done" },
        "user-1",
        undefined,
        CLIENT_TARGET,
      );
      expect(result).toEqual({ allowed: true, tier: 1 });
      const row = prisma.commandAuditLog.create.mock.calls[0][0].data;
      expect(row.data._targetDeviceId).toBe("dc-stefans-macbook");
    });

    it("BLOCKS Tier-3 client tools outright — get_clipboard / screenshot / off-catalog (ADR-014 ②)", async () => {
      for (const tool of ["get_clipboard", "screenshot", "run_shell"]) {
        const result = await evaluateCommand(
          prisma,
          `client_tool.${tool}`,
          tool,
          undefined,
          "user-1",
          undefined,
          CLIENT_TARGET,
        );
        expect(result.allowed).toBe(false);
        expect("blocked" in result && result.blocked).toBe(true);
        // No confirmation escape hatch for blocked tools.
        expect("requiresConfirmation" in result).toBe(false);
      }
    });

    it("REJECTS a client-echoed confirm on a token minted for target 'self'", async () => {
      const result = await evaluateCommand(
        prisma,
        "lock.front-door",
        "lock",
        undefined,
        "user-1",
        undefined,
        "self",
      );
      if (!("requiresConfirmation" in result) || !result.requiresConfirmation) {
        throw new Error("expected Tier-2 confirmation result");
      }
      const confirmed = await confirmCommand(
        prisma,
        result.confirmationToken,
        "user-1",
        { service: "lock", targetDeviceId: "dc-stefans-macbook" },
      );
      expect(confirmed.confirmed).toBe(false);
      if (confirmed.confirmed) throw new Error("unreachable");
      expect(confirmed.code).toBe("TOKEN_OPERATION_MISMATCH");
    });
  });

  // ── Audit rows carry target device + request id (no migration) ──

  describe("audit writes (within the WARP-1299 no-migration constraint)", () => {
    it("folds _targetDeviceId into the CommandAuditLog data JSON for client-target mints", async () => {
      await evaluateCommand(
        prisma,
        "client_tool.open_file",
        "open_file",
        { path: "/tmp/x" },
        "user-1",
        undefined,
        CLIENT_TARGET,
      );
      expect(prisma.commandAuditLog.create).toHaveBeenCalledTimes(1);
      const row = prisma.commandAuditLog.create.mock.calls[0][0].data;
      expect(row.data._targetDeviceId).toBe("dc-stefans-macbook");
    });

    it("folds _targetDeviceId into the confirm-time audit row too", async () => {
      const result = await evaluateCommand(
        prisma,
        "client_tool.open_file",
        "open_file",
        { path: "/tmp/x" },
        "user-1",
        undefined,
        CLIENT_TARGET,
      );
      if (!("requiresConfirmation" in result) || !result.requiresConfirmation) {
        throw new Error("expected Tier-2 confirmation result");
      }
      await confirmCommand(prisma, result.confirmationToken, "user-1", {
        service: "open_file",
        targetDeviceId: "dc-stefans-macbook",
      });
      expect(prisma.commandAuditLog.create).toHaveBeenCalledTimes(2);
      const confirmRow = prisma.commandAuditLog.create.mock.calls[1][0].data;
      expect(confirmRow.data._targetDeviceId).toBe("dc-stefans-macbook");
    });

    it("does NOT add target fields to self-target audit rows (byte-for-byte)", async () => {
      await evaluateCommand(
        prisma,
        "light.kitchen",
        "turn_on",
        { brightness: 128 },
        "user-1",
      );
      const row = prisma.commandAuditLog.create.mock.calls[0][0].data;
      expect(row.data).toEqual({ brightness: 128 });
    });
  });
});
