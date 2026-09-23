import { describe, it, expect, vi } from "vitest";
import { outboundEmailGate, webPushGate } from "../services/off-lan-gate.service.js";

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

// WARP-2904 — the `ambientDataGate` posture, not outboundEmailGate's: push is
// best-effort on every caller, so a gate that cannot be read REFUSES rather
// than throwing.
describe("webPushGate (off-LAN web_push gate, never throws)", () => {
  it("returns true only when the web_push channel is enabled", async () => {
    await expect(webPushGate(mockPrisma(async () => ({ enabled: true })))).resolves.toBe(true);
  });

  it("returns false when the channel is disabled", async () => {
    await expect(webPushGate(mockPrisma(async () => ({ enabled: false })))).resolves.toBe(false);
  });

  it("fails CLOSED when the row is missing/unprovisioned", async () => {
    await expect(webPushGate(mockPrisma(async () => null))).resolves.toBe(false);
  });

  it("fails CLOSED (false, not a throw) on a DB error", async () => {
    const prisma = mockPrisma(async () => {
      throw new Error("db unreachable");
    });
    await expect(webPushGate(prisma)).resolves.toBe(false);
  });

  it("reads the channel by the web_push enum key", async () => {
    const prisma = mockPrisma(async () => ({ enabled: true }));
    await webPushGate(prisma);
    expect(prisma.offLanAllowlistChannel.findUnique).toHaveBeenCalledWith({
      where: { key: "web_push" },
    });
  });
});
