/**
 * BUG-3 / ADR-019 — storage safety-tier service.
 *
 * Every destructive pool op is Tier-3-class: data-destroying, owner-only,
 * AI-blocked. This service mirrors network-safety.service.ts but binds the
 * single-use confirm token to {service, resourceId} so a token minted to
 * destroy `md0` can never confirm a destroy of `md1`, nor a format.
 *
 * Contract pinned here:
 *   - evaluateStorageCommand on a destructive op via the AI is BLOCKED.
 *   - via the dashboard it returns a single-use confirm token (202-shaped).
 *   - confirmStorageCommand refuses a missing/expired/mismatched token.
 *   - the token is single-use (a second confirm fails).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// CommandAuditLog writes go through a stubbed Prisma; we don't need a DB.
function prismaStub() {
  return {
    commandAuditLog: { create: vi.fn(async () => ({})) },
  } as unknown as import("@prisma/client").PrismaClient;
}

import {
  evaluateStorageCommand,
  confirmStorageCommand,
} from "../services/storage-safety.service.js";

describe("storage safety — AI is blocked from destructive ops", () => {
  let prisma: ReturnType<typeof prismaStub>;
  beforeEach(() => {
    prisma = prismaStub();
  });

  it("blocks a destructive op outright when source is the AI", async () => {
    const res = await evaluateStorageCommand(
      prisma,
      "pool_destroy",
      "md0",
      { device: "md0" },
      "ai-user",
      "ai",
    );
    expect("blocked" in res && res.blocked).toBe(true);
    expect(res.tier).toBe(3);
  });

  it("requires confirmation (not auto-allow) for a destructive op via the dashboard", async () => {
    const res = await evaluateStorageCommand(
      prisma,
      "pool_create",
      "md0",
      { device: "md0", level: "raid1" },
      "owner-user",
      "api",
    );
    expect("requiresConfirmation" in res && res.requiresConfirmation).toBe(true);
    expect("confirmationToken" in res && typeof res.confirmationToken).toBe("string");
  });
});

describe("storage safety — confirm token is single-use + bound to {service, resourceId}", () => {
  let prisma: ReturnType<typeof prismaStub>;
  beforeEach(() => {
    prisma = prismaStub();
  });

  async function mintToken(service: string, resourceId: string) {
    const res = await evaluateStorageCommand(
      prisma, service, resourceId, { device: resourceId }, "owner", "api",
    );
    if (!("confirmationToken" in res)) throw new Error("no token minted");
    return res.confirmationToken;
  }

  it("a valid token confirms its exact {service, resourceId}", async () => {
    const token = await mintToken("pool_destroy", "md0");
    const res = await confirmStorageCommand(prisma, token, "owner", {
      service: "pool_destroy",
      resourceId: "md0",
    });
    expect(res.confirmed).toBe(true);
  });

  it("refuses when no token is supplied / token is unknown", async () => {
    const res = await confirmStorageCommand(prisma, "not-a-real-token", "owner", {
      service: "pool_destroy",
      resourceId: "md0",
    });
    expect(res.confirmed).toBe(false);
  });

  it("refuses a token whose resourceId does not match (md0 token cannot destroy md1)", async () => {
    const token = await mintToken("pool_destroy", "md0");
    const res = await confirmStorageCommand(prisma, token, "owner", {
      service: "pool_destroy",
      resourceId: "md1",
    });
    expect(res.confirmed).toBe(false);
    if (!res.confirmed) expect(res.code).toBe("TOKEN_OPERATION_MISMATCH");
  });

  it("refuses a token whose service does not match (a destroy token cannot format)", async () => {
    const token = await mintToken("pool_destroy", "md0");
    const res = await confirmStorageCommand(prisma, token, "owner", {
      service: "pool_format",
      resourceId: "md0",
    });
    expect(res.confirmed).toBe(false);
    if (!res.confirmed) expect(res.code).toBe("TOKEN_OPERATION_MISMATCH");
  });

  it("is single-use — a second confirm of the same token fails", async () => {
    const token = await mintToken("pool_create", "md0");
    const first = await confirmStorageCommand(prisma, token, "owner", {
      service: "pool_create",
      resourceId: "md0",
    });
    expect(first.confirmed).toBe(true);
    const second = await confirmStorageCommand(prisma, token, "owner", {
      service: "pool_create",
      resourceId: "md0",
    });
    expect(second.confirmed).toBe(false);
  });

  it("every destructive storage op classifies as Tier 3 (never auto, never AI)", async () => {
    const ops = [
      "pool_create",
      "pool_destroy",
      "pool_format",
      "pool_set_level",
      "pool_add_spare",
      "pool_remove_disk",
    ];
    for (const op of ops) {
      const viaAi = await evaluateStorageCommand(
        prisma, op, "md0", { device: "md0" }, "ai", "ai",
      );
      expect("blocked" in viaAi && viaAi.blocked, `${op} must block the AI`).toBe(true);
      expect(viaAi.tier, `${op} must be Tier 3`).toBe(3);
    }
  });
});
