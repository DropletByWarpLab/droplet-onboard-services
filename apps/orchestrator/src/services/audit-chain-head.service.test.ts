import { describe, it, expect, vi } from "vitest";
import { readChainHead } from "./audit-chain-head.service.js";
import { hashSignature } from "./audit-signing.service.js";

// WARP-3628 — the head an operator copies off the box.
describe("readChainHead", () => {
  const now = new Date("2026-10-03T12:00:00.000Z");

  it("reports the last row's id and signature hash and the newest daily root", async () => {
    const prisma = {
      activityRow: {
        findFirst: vi.fn(async () => ({
          id: 42n,
          at: new Date("2026-10-03T11:59:00.000Z"),
          signature: "sig-42",
        })),
      },
      activityDailyRoot: {
        findFirst: vi.fn(async () => ({
          date: "2026-10-02",
          firstRowId: 10n,
          lastRowId: 40n,
          rowCount: 31,
          rootHash: "root-hash",
          algorithm: "ecdsa-p256-sha256",
        })),
      },
    };

    const head = await readChainHead(prisma as any, now);

    expect(head).toEqual({
      capturedAt: "2026-10-03T12:00:00.000Z",
      lastRow: {
        id: "42",
        at: "2026-10-03T11:59:00.000Z",
        signatureHash: hashSignature("sig-42"),
      },
      latestDailyRoot: {
        date: "2026-10-02",
        firstRowId: "10",
        lastRowId: "40",
        rowCount: 31,
        rootHash: "root-hash",
        algorithm: "ecdsa-p256-sha256",
      },
    });
    // Never the raw signature.
    expect(JSON.stringify(head)).not.toContain("sig-42");
    expect(prisma.activityRow.findFirst).toHaveBeenCalledWith({ orderBy: { id: "desc" } });
    expect(prisma.activityDailyRoot.findFirst).toHaveBeenCalledWith({ orderBy: { date: "desc" } });
  });

  it("handles an empty chain with no roots", async () => {
    const prisma = {
      activityRow: { findFirst: vi.fn(async () => null) },
      activityDailyRoot: { findFirst: vi.fn(async () => null) },
    };
    expect(await readChainHead(prisma as any, now)).toEqual({
      capturedAt: "2026-10-03T12:00:00.000Z",
      lastRow: null,
      latestDailyRoot: null,
    });
  });
});
