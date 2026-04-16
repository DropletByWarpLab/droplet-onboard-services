import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { classifyCommand, PARAMETER_BOUNDS, RATE_LIMIT_PER_ENTITY } from "../config/safety-rules.js";
import {
  evaluateCommand,
  confirmCommand,
  getAuditLog,
  cleanupExpiredTokens,
} from "../services/safety-tier.service.js";

// ── Prisma mock with commandAuditLog ──

function createMockPrisma() {
  const prisma = new PrismaClient() as unknown as PrismaClient & {
    commandAuditLog: {
      create: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };
  // The global mock from setup.ts doesn't include commandAuditLog,
  // so we attach it manually for these tests.
  (prisma as any).commandAuditLog = {
    create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    findMany: vi.fn().mockResolvedValue([]),
  };
  return prisma;
}

// ────────────────────────────────────────────────────────────────────────────
// 1. Tier classification — unit tests on classifyCommand
// ────────────────────────────────────────────────────────────────────────────

describe("classifyCommand", () => {
  describe("Tier 1 (auto-execute) domains", () => {
    it("classifies light.turn_on as Tier 1, no confirmation", () => {
      const result = classifyCommand("light", "turn_on");
      expect(result.tier).toBe(1);
      expect(result.requiresConfirmation).toBe(false);
    });

    it("classifies switch.toggle as Tier 1, no confirmation", () => {
      const result = classifyCommand("switch", "toggle");
      expect(result.tier).toBe(1);
      expect(result.requiresConfirmation).toBe(false);
    });

    it("classifies media_player.play as Tier 1, no confirmation", () => {
      const result = classifyCommand("media_player", "play");
      expect(result.tier).toBe(1);
      expect(result.requiresConfirmation).toBe(false);
    });

    it("classifies climate.set_temperature with temp < 30 as Tier 1", () => {
      const result = classifyCommand("climate", "set_temperature", { temperature: 22 });
      expect(result.tier).toBe(1);
      expect(result.requiresConfirmation).toBe(false);
    });
  });

  describe("Tier 2 (requires confirmation) domains", () => {
    it("classifies lock.lock as Tier 2, requires confirmation", () => {
      const result = classifyCommand("lock", "lock");
      expect(result.tier).toBe(2);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.reason).toBeDefined();
    });

    it("classifies alarm_control_panel.arm_home as Tier 2, requires confirmation", () => {
      const result = classifyCommand("alarm_control_panel", "arm_home");
      expect(result.tier).toBe(2);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.reason).toBeDefined();
    });

    it("classifies cover.close_cover as Tier 2, requires confirmation", () => {
      const result = classifyCommand("cover", "close_cover");
      expect(result.tier).toBe(2);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.reason).toContain("cover");
    });

    it("classifies climate.set_temperature with temp >= 30 as Tier 2", () => {
      const result = classifyCommand("climate", "set_temperature", { temperature: 30 });
      expect(result.tier).toBe(2);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.reason).toContain("30");
    });

    it("classifies climate.set_temperature with temp = 35 as Tier 2", () => {
      const result = classifyCommand("climate", "set_temperature", { temperature: 35 });
      expect(result.tier).toBe(2);
      expect(result.requiresConfirmation).toBe(true);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. Parameter bounds checking — via evaluateCommand
// ────────────────────────────────────────────────────────────────────────────

describe("evaluateCommand — parameter bounds", () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it("blocks climate.set_temperature with temp=50 (out of bounds 10-35)", async () => {
    const result = await evaluateCommand(
      prisma,
      "climate.living_room",
      "set_temperature",
      { temperature: 50 },
      "user-1"
    );

    // temp >= 30 triggers Tier 2 (confirmation required) before bounds check
    expect(result.allowed).toBe(false);
    expect("requiresConfirmation" in result && result.requiresConfirmation).toBe(true);
    expect("reason" in result && result.reason).toContain("Temperature");
  });

  it("blocks light.turn_on with brightness=300 (out of bounds 0-255)", async () => {
    const result = await evaluateCommand(
      prisma,
      "light.bedroom",
      "turn_on",
      { brightness: 300 },
      "user-1"
    );

    expect(result.allowed).toBe(false);
    expect("blocked" in result && result.blocked).toBe(true);
    expect("reason" in result && result.reason).toContain("brightness");
  });

  it("allows climate.set_temperature with temp=22 (within bounds)", async () => {
    const result = await evaluateCommand(
      prisma,
      "climate.living_room",
      "set_temperature",
      { temperature: 22 },
      "user-1"
    );

    expect(result.allowed).toBe(true);
    expect(result.tier).toBe(1);
  });

  it("blocks climate.set_temperature with temp=5 (below minimum of 10)", async () => {
    const result = await evaluateCommand(
      prisma,
      "climate.living_room",
      "set_temperature",
      { temperature: 5 },
      "user-1"
    );

    expect(result.allowed).toBe(false);
    expect("blocked" in result && result.blocked).toBe(true);
  });

  it("allows light.turn_on with brightness=128 (within bounds)", async () => {
    const result = await evaluateCommand(
      prisma,
      "light.bedroom",
      "turn_on",
      { brightness: 128 },
      "user-1"
    );

    expect(result.allowed).toBe(true);
  });

  it("allows commands without data when bounds exist for that service", async () => {
    const result = await evaluateCommand(
      prisma,
      "light.bedroom",
      "turn_on",
      undefined,
      "user-1"
    );

    expect(result.allowed).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. Rate limiting
// ────────────────────────────────────────────────────────────────────────────

describe("evaluateCommand — rate limiting", () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it(`allows the first ${RATE_LIMIT_PER_ENTITY} commands but blocks the next one`, async () => {
    // Use a unique entity to avoid interference from other tests
    const entityId = `switch.rate_limit_test_${Date.now()}`;

    // First 10 should all be allowed
    for (let i = 0; i < RATE_LIMIT_PER_ENTITY; i++) {
      const result = await evaluateCommand(prisma, entityId, "toggle", undefined, "user-1");
      expect(result.allowed).toBe(true);
    }

    // 11th should be blocked
    const result = await evaluateCommand(prisma, entityId, "toggle", undefined, "user-1");
    expect(result.allowed).toBe(false);
    expect("blocked" in result && result.blocked).toBe(true);
    expect("reason" in result && result.reason).toContain("Rate limit");
  });

  it("logs a rate-limited command to the audit trail", async () => {
    const entityId = `switch.rate_log_test_${Date.now()}`;

    // Exhaust the rate limit
    for (let i = 0; i < RATE_LIMIT_PER_ENTITY; i++) {
      await evaluateCommand(prisma, entityId, "toggle", undefined, "user-1");
    }

    // The blocked call should still create an audit entry
    await evaluateCommand(prisma, entityId, "toggle", undefined, "user-1");

    // Total audit calls: 10 allowed + 1 blocked = 11
    expect((prisma as any).commandAuditLog.create).toHaveBeenCalledTimes(11);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. Confirmation flow
// ────────────────────────────────────────────────────────────────────────────

describe("Confirmation flow (Tier 2)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it("returns a confirmationToken for lock.lock", async () => {
    const result = await evaluateCommand(prisma, "lock.front_door", "lock", undefined, "user-1");

    expect(result.allowed).toBe(false);
    expect("requiresConfirmation" in result && result.requiresConfirmation).toBe(true);
    expect("confirmationToken" in result && result.confirmationToken).toBeDefined();
    expect("confirmationToken" in result && typeof result.confirmationToken).toBe("string");
    expect("reason" in result && result.reason).toBeDefined();
    expect(result.tier).toBe(2);
  });

  it("confirms with a valid token and returns command details", async () => {
    const evalResult = await evaluateCommand(
      prisma,
      "lock.front_door",
      "lock",
      { code: "1234" },
      "user-1"
    );

    expect(evalResult.allowed).toBe(false);
    expect("confirmationToken" in evalResult).toBe(true);

    const token = (evalResult as any).confirmationToken as string;
    const confirmResult = await confirmCommand(prisma, token, "user-1");

    expect(confirmResult.confirmed).toBe(true);
    if (confirmResult.confirmed) {
      expect(confirmResult.entityId).toBe("lock.front_door");
      expect(confirmResult.domain).toBe("lock");
      expect(confirmResult.service).toBe("lock");
      expect(confirmResult.data).toEqual({ code: "1234" });
    }
  });

  it("rejects confirmation with an invalid token", async () => {
    const result = await confirmCommand(prisma, "totally-invalid-token", "user-1");

    expect(result.confirmed).toBe(false);
    if (!result.confirmed) {
      expect(result.reason).toContain("Invalid");
    }
  });

  it("rejects confirmation with an expired token", async () => {
    // Evaluate to get a real token
    const evalResult = await evaluateCommand(
      prisma,
      "lock.back_door",
      "lock",
      undefined,
      "user-1"
    );
    const token = (evalResult as any).confirmationToken as string;

    // Advance time past the 60-second expiry
    const realDateNow = Date.now;
    Date.now = vi.fn(() => realDateNow() + 61_000);

    try {
      const confirmResult = await confirmCommand(prisma, token, "user-1");
      expect(confirmResult.confirmed).toBe(false);
      if (!confirmResult.confirmed) {
        expect(confirmResult.reason).toContain("expired");
      }
    } finally {
      Date.now = realDateNow;
    }
  });

  it("token is single-use — second confirm fails", async () => {
    const evalResult = await evaluateCommand(
      prisma,
      "lock.garage",
      "lock",
      undefined,
      "user-1"
    );
    const token = (evalResult as any).confirmationToken as string;

    const first = await confirmCommand(prisma, token, "user-1");
    expect(first.confirmed).toBe(true);

    const second = await confirmCommand(prisma, token, "user-1");
    expect(second.confirmed).toBe(false);
  });

  // WARP-41: token binding to operation
  describe("token bound to expected operation (WARP-41)", () => {
    it("accepts matching service + entityId echo", async () => {
      const evalResult = await evaluateCommand(
        prisma,
        "lock.front_door",
        "lock",
        undefined,
        "user-1",
      );
      const token = (evalResult as any).confirmationToken as string;

      const confirm = await confirmCommand(prisma, token, "user-1", {
        service: "lock",
        entityId: "lock.front_door",
      });
      expect(confirm.confirmed).toBe(true);
    });

    it("rejects mismatched service with TOKEN_OPERATION_MISMATCH", async () => {
      const evalResult = await evaluateCommand(
        prisma,
        "lock.front_door",
        "lock",
        undefined,
        "user-1",
      );
      const token = (evalResult as any).confirmationToken as string;

      const confirm = await confirmCommand(prisma, token, "user-1", {
        service: "unlock", // caller thinks they're unlocking, token was for lock
      });
      expect(confirm.confirmed).toBe(false);
      if (!confirm.confirmed) {
        expect(confirm.code).toBe("TOKEN_OPERATION_MISMATCH");
      }
    });

    it("rejects mismatched entityId with TOKEN_OPERATION_MISMATCH", async () => {
      const evalResult = await evaluateCommand(
        prisma,
        "lock.front_door",
        "lock",
        undefined,
        "user-1",
      );
      const token = (evalResult as any).confirmationToken as string;

      const confirm = await confirmCommand(prisma, token, "user-1", {
        service: "lock",
        entityId: "lock.back_door", // confused-deputy: token was for front_door
      });
      expect(confirm.confirmed).toBe(false);
      if (!confirm.confirmed) {
        expect(confirm.code).toBe("TOKEN_OPERATION_MISMATCH");
      }
    });

    it("returns TOKEN_MISSING for unknown tokens", async () => {
      const result = await confirmCommand(prisma, "not-a-real-token", "user-1", {
        service: "lock",
      });
      expect(result.confirmed).toBe(false);
      if (!result.confirmed) {
        expect(result.code).toBe("TOKEN_MISSING");
      }
    });

    it("returns TOKEN_EXPIRED with structured code past 60s", async () => {
      const evalResult = await evaluateCommand(
        prisma,
        "lock.garage",
        "lock",
        undefined,
        "user-1",
      );
      const token = (evalResult as any).confirmationToken as string;

      const realDateNow = Date.now;
      Date.now = vi.fn(() => realDateNow() + 61_000);

      try {
        const result = await confirmCommand(prisma, token, "user-1", { service: "lock" });
        expect(result.confirmed).toBe(false);
        if (!result.confirmed) {
          expect(result.code).toBe("TOKEN_EXPIRED");
        }
      } finally {
        Date.now = realDateNow;
      }
    });

    it("replay-after-success: first confirm wins, second returns TOKEN_MISSING", async () => {
      const evalResult = await evaluateCommand(
        prisma,
        "lock.side_door",
        "lock",
        undefined,
        "user-1",
      );
      const token = (evalResult as any).confirmationToken as string;

      const first = await confirmCommand(prisma, token, "user-1", { service: "lock" });
      expect(first.confirmed).toBe(true);

      const replay = await confirmCommand(prisma, token, "user-1", { service: "lock" });
      expect(replay.confirmed).toBe(false);
      if (!replay.confirmed) {
        expect(replay.code).toBe("TOKEN_MISSING");
      }
    });

    it("no-echo call still succeeds (backwards compat for the transition)", async () => {
      const evalResult = await evaluateCommand(
        prisma,
        "lock.patio",
        "lock",
        undefined,
        "user-1",
      );
      const token = (evalResult as any).confirmationToken as string;

      // Route layers will require the echo — service-layer tolerates its
      // absence so legacy callers during the rollout don't crash.
      const confirm = await confirmCommand(prisma, token, "user-1");
      expect(confirm.confirmed).toBe(true);
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. Audit logging
// ────────────────────────────────────────────────────────────────────────────

describe("Audit logging", () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it("creates an audit log entry for a Tier 1 command", async () => {
    const entityId = `light.audit_tier1_${Date.now()}`;
    await evaluateCommand(prisma, entityId, "turn_on", { brightness: 100 }, "user-1");

    expect((prisma as any).commandAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId,
        domain: "light",
        service: "turn_on",
        tier: 1,
        confirmed: true,
        blocked: false,
        userId: "user-1",
      }),
    });
  });

  it("creates an audit log entry for a Tier 2 command", async () => {
    await evaluateCommand(prisma, "lock.front_door", "lock", undefined, "user-1");

    expect((prisma as any).commandAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: "lock.front_door",
        domain: "lock",
        service: "lock",
        tier: 2,
        confirmed: false,
        blocked: false,
        userId: "user-1",
      }),
    });
  });

  it("creates an audit log entry for a blocked (out-of-bounds) command", async () => {
    await evaluateCommand(prisma, "light.living_room", "turn_on", { brightness: 300 }, "user-1");

    expect((prisma as any).commandAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: "light.living_room",
        tier: 1,
        confirmed: false,
        blocked: true,
        reason: expect.stringContaining("brightness"),
      }),
    });
  });

  it("creates an audit log entry when a Tier 2 command is confirmed", async () => {
    const evalResult = await evaluateCommand(
      prisma,
      "lock.patio",
      "lock",
      undefined,
      "user-1"
    );
    const token = (evalResult as any).confirmationToken as string;

    await confirmCommand(prisma, token, "user-1");

    // The second call to create should have confirmed: true
    const calls = (prisma as any).commandAuditLog.create.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.data.confirmed).toBe(true);
    expect(lastCall.data.entityId).toBe("lock.patio");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. getAuditLog
// ────────────────────────────────────────────────────────────────────────────

describe("getAuditLog", () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it("queries audit log with default pagination", async () => {
    await getAuditLog(prisma);

    expect((prisma as any).commandAuditLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: "desc" },
      take: 50,
      skip: 0,
    });
  });

  it("filters by entityId and userId", async () => {
    await getAuditLog(prisma, { entityId: "light.bedroom", userId: "user-42" });

    expect((prisma as any).commandAuditLog.findMany).toHaveBeenCalledWith({
      where: { entityId: "light.bedroom", userId: "user-42" },
      orderBy: { createdAt: "desc" },
      take: 50,
      skip: 0,
    });
  });

  it("respects custom limit and offset", async () => {
    await getAuditLog(prisma, { limit: 10, offset: 20 });

    expect((prisma as any).commandAuditLog.findMany).toHaveBeenCalledWith({
      where: {},
      orderBy: { createdAt: "desc" },
      take: 10,
      skip: 20,
    });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 7. cleanupExpiredTokens
// ────────────────────────────────────────────────────────────────────────────

describe("cleanupExpiredTokens", () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    prisma = createMockPrisma();
  });

  it("removes expired tokens so they can no longer be confirmed", async () => {
    // Create a pending confirmation
    const evalResult = await evaluateCommand(
      prisma,
      "lock.cleanup_test",
      "lock",
      undefined,
      "user-1"
    );
    const token = (evalResult as any).confirmationToken as string;

    // Advance time past expiry and run cleanup
    const realDateNow = Date.now;
    Date.now = vi.fn(() => realDateNow() + 61_000);

    try {
      cleanupExpiredTokens();

      // Token should now be gone
      const result = await confirmCommand(prisma, token, "user-1");
      expect(result.confirmed).toBe(false);
    } finally {
      Date.now = realDateNow;
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 8. PARAMETER_BOUNDS export validation
// ────────────────────────────────────────────────────────────────────────────

describe("PARAMETER_BOUNDS", () => {
  it("defines bounds for climate.set_temperature as 10-35", () => {
    const bounds = PARAMETER_BOUNDS["climate.set_temperature"];
    expect(bounds).toBeDefined();
    expect(bounds.field).toBe("temperature");
    expect(bounds.min).toBe(10);
    expect(bounds.max).toBe(35);
  });

  it("defines bounds for light.turn_on brightness as 0-255", () => {
    const bounds = PARAMETER_BOUNDS["light.turn_on"];
    expect(bounds).toBeDefined();
    expect(bounds.field).toBe("brightness");
    expect(bounds.min).toBe(0);
    expect(bounds.max).toBe(255);
  });
});
