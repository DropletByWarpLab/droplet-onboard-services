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

  it("re-throws on a DB error so the caller can 503 (not a silent fail-open)", async () => {
    // The gate distinguishes a transient infra failure from a deliberate
    // channel disable: it RE-THROWS on a DB error so routes/email.ts can
    // surface a 503 (gate temporarily unavailable) instead of the
    // misleading 451 (channel deliberately disabled). The regression this
    // guards is the old impl's `catch { return true }` fail-OPEN — the gate
    // must never default-open on a transient hiccup.
    const prisma = mockPrisma(async () => {
      throw new Error("db unreachable");
    });
    await expect(outboundEmailGate(prisma)).rejects.toThrow("db unreachable");
  });

  it("reads the channel by its unique enum key", async () => {
    const prisma = mockPrisma(async () => ({ enabled: true }));
    await outboundEmailGate(prisma);
    expect(prisma.offLanAllowlistChannel.findUnique).toHaveBeenCalledWith({
      where: { key: "outbound_email" },
    });
  });
});
