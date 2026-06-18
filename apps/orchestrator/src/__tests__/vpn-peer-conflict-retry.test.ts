import { describe, it, expect, vi } from "vitest";
import {
  allocateMintAndPersistPeer,
  isActiveIpViolation,
} from "../services/vpn.service.js";

// WARP-565: the allocate → mint → persist sequence is a read-then-write race.
// A partial unique index on (assignedIp) WHERE status = 'active' is the DB-level
// authority; allocateMintAndPersistPeer wraps the persist in a $transaction and
// retries the whole sequence when the loser's INSERT trips P2002 on the active
// IP. These tests exercise that retry path with a Prisma double that throws a
// tagged P2002 on conflict, then succeeds.

const SUBNET = "10.13.13.0/24";

/**
 * Minimal Prisma double for the allocator. `taken` seeds the active IPs that
 * findMany reports; create throws a tagged P2002 if the inserted assignedIp is
 * already active, otherwise records it. `$transaction(fn)` runs fn against the
 * same store so `tx` shares state.
 */
function makePrisma(initialActiveIps: string[] = []) {
  const active = new Set(initialActiveIps);
  const created: any[] = [];
  let counter = 0;
  const store: any = {
    created,
    active,
    vpnPeer: {
      findMany: vi.fn(async ({ where }: any = {}) => {
        let ips = [...active];
        if (where?.assignedIp?.startsWith) {
          ips = ips.filter((ip) => ip.startsWith(where.assignedIp.startsWith));
        }
        return ips.map((assignedIp) => ({ assignedIp }));
      }),
      create: vi.fn(async ({ data }: any) => {
        if (active.has(data.assignedIp)) {
          const e: any = new Error("Unique constraint failed on assignedIp");
          e.code = "P2002";
          e.meta = { target: ["assignedIp"] };
          throw e;
        }
        active.add(data.assignedIp);
        const row = { id: `vp-${++counter}`, status: "active", ...data };
        created.push(row);
        return row;
      }),
    },
    $transaction: vi.fn(async (fn: any) => fn(store)),
  };
  return store;
}

function mintFor() {
  let n = 0;
  return vi.fn(async (_ip: string) => ({
    public_key: `PUB-${++n}`,
    private_key: `PRIV-${n}`,
  }));
}

describe("allocateMintAndPersistPeer (WARP-565 retry-on-conflict)", () => {
  it("mints + persists the lowest free IP on the happy path", async () => {
    // .2 is already active → allocator hands out .3, no conflict, no rollback.
    const prisma = makePrisma(["10.13.13.2"]);
    const mint = mintFor();
    const rollbackMint = vi.fn(async () => {});

    const result = await allocateMintAndPersistPeer(prisma, SUBNET, {
      userId: "alice",
      deviceLabel: "iPhone",
      mint,
      rollbackMint,
    });

    expect(result.peerIp).toBe("10.13.13.3");
    expect(result.saved.assignedIp).toBe("10.13.13.3");
    expect(mint).toHaveBeenCalledTimes(1);
    expect(rollbackMint).not.toHaveBeenCalled();
  });

  it("re-mints and re-allocates after a P2002, rolling back the orphan mint", async () => {
    // Force a genuine race: findMany reports .2 free on attempt 1, but the
    // insert throws P2002 (a concurrent peer claimed .2 between read+write).
    // On retry, .2 is now active so the allocator hands out .3 and succeeds.
    const prisma = makePrisma();
    const create = prisma.vpnPeer.create;
    let calls = 0;
    create.mockImplementation(async ({ data }: any) => {
      calls += 1;
      if (calls === 1) {
        // Simulate the racer: the IP is now taken by someone else.
        prisma.active.add(data.assignedIp);
        const e: any = new Error("Unique constraint failed on assignedIp");
        e.code = "P2002";
        e.meta = { target: ["assignedIp"] };
        throw e;
      }
      prisma.active.add(data.assignedIp);
      const row = { id: `vp-${calls}`, status: "active", ...data };
      prisma.created.push(row);
      return row;
    });

    const mint = mintFor();
    const rollbackMint = vi.fn(async () => {});

    const result = await allocateMintAndPersistPeer(prisma, SUBNET, {
      userId: "alice",
      deviceLabel: "iPhone",
      mint,
      rollbackMint,
    });

    // Attempt 1 minted+failed on .2; attempt 2 allocated .3 and persisted.
    expect(result.peerIp).toBe("10.13.13.3");
    expect(mint).toHaveBeenCalledTimes(2);
    expect(mint).toHaveBeenNthCalledWith(1, "10.13.13.2");
    expect(mint).toHaveBeenNthCalledWith(2, "10.13.13.3");
    // The failed attempt's router peer was rolled back exactly once. The race
    // is retryable AND there's retry budget left, so the rollback is signalled
    // as NON-terminal (terminal=false) — the route logs it at warn, not error,
    // so a successful-on-retry mint doesn't false-page error alerting.
    expect(rollbackMint).toHaveBeenCalledTimes(1);
    expect(rollbackMint).toHaveBeenCalledWith(
      { public_key: "PUB-1", private_key: "PRIV-1" },
      false,
    );
  });

  it("does NOT retry a publicKey clash — rolls back once and rethrows", async () => {
    // A publicKey P2002 is a genuine persist failure (routing minted a pubkey
    // we already hold), not an IP race. It must surface, not loop.
    const prisma = makePrisma();
    prisma.vpnPeer.create.mockImplementation(async () => {
      const e: any = new Error("Unique constraint failed on publicKey");
      e.code = "P2002";
      e.meta = { target: ["publicKey"] };
      throw e;
    });
    const mint = mintFor();
    const rollbackMint = vi.fn(async () => {});

    await expect(
      allocateMintAndPersistPeer(prisma, SUBNET, {
        userId: "alice",
        deviceLabel: "iPhone",
        mint,
        rollbackMint,
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(mint).toHaveBeenCalledTimes(1);
    // A publicKey clash is a genuine final failure → rollback is terminal=true
    // so the route logs it at error level (this one SHOULD page).
    expect(rollbackMint).toHaveBeenCalledTimes(1);
    expect(rollbackMint).toHaveBeenCalledWith(
      { public_key: "PUB-1", private_key: "PRIV-1" },
      true,
    );
  });

  it("gives up after the bounded retry budget on persistent conflicts", async () => {
    const prisma = makePrisma();
    prisma.vpnPeer.create.mockImplementation(async () => {
      const e: any = new Error("Unique constraint failed on assignedIp");
      e.code = "P2002";
      e.meta = { target: ["assignedIp"] };
      throw e;
    });
    const mint = mintFor();
    const rollbackMint = vi.fn(async () => {});

    await expect(
      allocateMintAndPersistPeer(
        prisma,
        SUBNET,
        { userId: "alice", deviceLabel: "iPhone", mint, rollbackMint },
        2, // maxRetries
      ),
    ).rejects.toMatchObject({ code: "P2002" });

    // attempts = maxRetries + 1 = 3 mints, each rolled back.
    expect(mint).toHaveBeenCalledTimes(3);
    expect(rollbackMint).toHaveBeenCalledTimes(3);
    // The first two rollbacks are retryable (budget remained) → terminal=false;
    // the final one exhausts the budget and propagates → terminal=true. Only the
    // last should log at error level.
    expect(rollbackMint).toHaveBeenNthCalledWith(
      1,
      { public_key: "PUB-1", private_key: "PRIV-1" },
      false,
    );
    expect(rollbackMint).toHaveBeenNthCalledWith(
      2,
      { public_key: "PUB-2", private_key: "PRIV-2" },
      false,
    );
    expect(rollbackMint).toHaveBeenNthCalledWith(
      3,
      { public_key: "PUB-3", private_key: "PRIV-3" },
      true,
    );
  });
});

describe("isActiveIpViolation", () => {
  it("true for an assignedIp-targeted P2002", () => {
    expect(isActiveIpViolation({ code: "P2002", meta: { target: ["assignedIp"] } })).toBe(true);
  });
  it("false for a publicKey-targeted P2002", () => {
    expect(isActiveIpViolation({ code: "P2002", meta: { target: ["publicKey"] } })).toBe(false);
  });
  it("true for an unannotated P2002 (older Prisma / bare test errors)", () => {
    expect(isActiveIpViolation({ code: "P2002" })).toBe(true);
  });
  it("false for non-P2002 errors", () => {
    expect(isActiveIpViolation({ code: "P2025" })).toBe(false);
    expect(isActiveIpViolation(new Error("boom"))).toBe(false);
    expect(isActiveIpViolation(null)).toBe(false);
  });
});
