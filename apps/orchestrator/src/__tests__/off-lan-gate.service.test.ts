import { describe, it, expect, vi } from "vitest";
import { outboundEmailGate } from "../services/off-lan-gate.service.js";

/**
 * Minimal Prisma mock exposing only offLanAllowlistChannel.findUnique
 * (the surface outboundEmailGate reads). Mirrors the mock factory in
 * off-lan-allowlist.routes.test.ts.
 */
function mockPrisma(impl: () => Promise<unknown>) {
  return {
    offLanAllowlistChannel: {
      findUnique: vi.fn(impl),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("outboundEmailGate (off-LAN outbound_email gate)", () => {
  it("returns true when the outbound_email channel is enabled", async () => {
    const prisma = mockPrisma(async () => ({
      key: "outbound_email",
      enabled: true,
    }));
    await expect(outboundEmailGate(prisma)).resolves.toBe(true);
  });

  it("returns false (fail-closed) when the channel is disabled", async () => {
    const prisma = mockPrisma(async () => ({
      key: "outbound_email",
      enabled: false,
    }));
    await expect(outboundEmailGate(prisma)).resolves.toBe(false);
  });

  it("fails CLOSED when the channel row is missing/unprovisioned", async () => {
    // Regression for the old `rows.length === 0 → return true` fail-open.
    const prisma = mockPrisma(async () => null);
    await expect(outboundEmailGate(prisma)).resolves.toBe(false);
  });

  it("fails CLOSED on a DB error", async () => {
    // The core regression: the old impl had `catch { return true }`.
    const prisma = mockPrisma(async () => {
      throw new Error("db unreachable");
    });
    await expect(outboundEmailGate(prisma)).resolves.toBe(false);
  });

  it("reads the channel by its unique enum key", async () => {
    const prisma = mockPrisma(async () => ({ enabled: true }));
    await outboundEmailGate(prisma);
    expect(prisma.offLanAllowlistChannel.findUnique).toHaveBeenCalledWith({
      where: { key: "outbound_email" },
    });
  });
});
