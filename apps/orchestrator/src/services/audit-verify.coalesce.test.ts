/**
 * WARP-1027 — verifyActivityChainCoalesced() shares one in-flight O(n) chain
 * walk across concurrent callers (N admin tabs, or the nightly cron racing a
 * manual re-verify), so the worst-case concurrency is 1 full walk, not N.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyActivityChainCoalesced,
  verifyActivityChain,
} from "./audit-verify.service.js";
import type { ActivityRowSigner } from "./audit-signing.service.js";

// A one-row activity table: the walk fetches a single sub-PAGE page and stops,
// so exactly one findMany call == one full walk.
function makeRow(id: bigint) {
  return {
    id,
    at: new Date("2026-01-01T00:00:00Z"),
    severity: "info",
    sourceIcon: "shield",
    what: "boot",
    sub: null,
    kind: "system",
    refs: null,
    signature: `sig-${id}`,
    prevSignatureHash: "", // genesis anchor: expectedPrevHash === this for row 1
    actorType: "system",
    actorId: null,
    schemaVersion: 1,
  };
}

function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

// signer.verify() -> true so the single row passes; the coalescing is the SUT.
const signer = { verify: vi.fn(() => true) } as unknown as ActivityRowSigner;

describe("verifyActivityChainCoalesced (WARP-1027)", () => {
  let findManyCalls: number;
  let gate: ReturnType<typeof makeDeferred<void>> | null;
  let prisma: { activityRow: { findMany: (...args: unknown[]) => Promise<unknown[]> } };

  beforeEach(() => {
    vi.clearAllMocks();
    findManyCalls = 0;
    gate = null;
    prisma = {
      activityRow: {
        findMany: vi.fn(async () => {
          findManyCalls += 1;
          // Hold the walk "in flight" while a second caller joins, if armed.
          if (gate) await gate.promise;
          return [makeRow(1n)];
        }),
      },
    };
  });

  it("concurrent callers share one walk (one DB pass)", async () => {
    gate = makeDeferred<void>();
    const p1 = verifyActivityChainCoalesced(prisma as never, signer);
    const p2 = verifyActivityChainCoalesced(prisma as never, signer);
    // Both callers get the exact same in-flight promise.
    expect(p2).toBe(p1);
    gate.resolve(); // let the shared walk finish
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(r2); // same shared result
    expect(r1).toMatchObject({ ok: true, rowsChecked: 1, brokenAtId: null });
    // One walk over a single-page table => exactly one findMany call, not two.
    expect(findManyCalls).toBe(1);
  });

  it("clears the in-flight ref so a later call re-walks fresh state", async () => {
    await verifyActivityChainCoalesced(prisma as never, signer);
    expect(findManyCalls).toBe(1);
    // A sequential call after the first settles must NOT reuse the stale walk —
    // verification has to reflect live DB state.
    await verifyActivityChainCoalesced(prisma as never, signer);
    expect(findManyCalls).toBe(2);
  });

  it("clears the in-flight ref on a REJECTED walk — callers retry, not replay the failure", async () => {
    // The whole point of `.finally` (vs `.then`) is that it clears on reject too,
    // so a transient DB error doesn't poison the shared promise for every later caller.
    const boom = new Error("db down");
    prisma.activityRow.findMany = vi.fn(async () => {
      findManyCalls += 1;
      throw boom;
    });
    const p1 = verifyActivityChainCoalesced(prisma as never, signer);
    const p2 = verifyActivityChainCoalesced(prisma as never, signer);
    await expect(p1).rejects.toBe(boom);
    await expect(p2).rejects.toBe(boom); // both joiners share the one rejection
    expect(findManyCalls).toBe(1); // one shared (failed) walk, not two

    // Ref cleared → a subsequent call re-walks fresh instead of awaiting the dead promise.
    prisma.activityRow.findMany = vi.fn(async () => {
      findManyCalls += 1;
      return [makeRow(1n)];
    });
    const r = await verifyActivityChainCoalesced(prisma as never, signer);
    expect(r).toMatchObject({ ok: true, rowsChecked: 1 });
    expect(findManyCalls).toBe(2);
  });

  it("verifyActivityChain still walks directly (uncoalesced) — recorder/export tests rely on it", async () => {
    const r = await verifyActivityChain(prisma as never, signer);
    expect(r).toMatchObject({ ok: true, rowsChecked: 1 });
    expect(findManyCalls).toBe(1);
  });
});
