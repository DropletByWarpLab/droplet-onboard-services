/**
 * WARP-2978 (review R3) — the incident fake's transactions are the shared
 * WARP-1570 seam's, not a hand-rolled stub: the isolation level reaches it,
 * a throwing callback rolls every table back, and a RepeatableRead
 * transaction that lost a write-conflict aborts with P2034 while the
 * transaction that won keeps its write.
 */
import { describe, expect, it } from "vitest";
import { createFakeSecurityPrisma } from "./security-incidents.fake.js";

type Tx = { user: { update(a: unknown): Promise<unknown>; create(a: unknown): Promise<unknown> } };
type Client = { $transaction(fn: (tx: Tx) => Promise<unknown>, opts?: { isolationLevel?: string }): Promise<unknown> };

const U1 = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const U2 = "6b2c3d4e-5f6a-4b7c-9d8e-0f1a2b3c4d5e";

function fake() {
  const f = createFakeSecurityPrisma({
    user: [{ id: U1, username: "maria", displayName: "Maria", role: "family", directoryStatus: "ACTIVE" }],
  });
  return { f, client: f.client as unknown as Client };
}

describe("the incident fake's transactions (the WARP-1570 seam)", () => {
  it("records the isolation level asked for, and a throwing callback rolls every table back", async () => {
    const { f, client } = fake();
    await expect(
      client.$transaction(
        async (tx) => {
          await tx.user.update({ where: { id: U1 }, data: { displayName: "Changed" } });
          await tx.user.create({ data: { id: U2, username: "jordan", displayName: "Jordan", role: "admin", directoryStatus: "ACTIVE" } });
          throw new Error("boom");
        },
        { isolationLevel: "ReadCommitted" },
      ),
    ).rejects.toThrow("boom");
    expect(f.world.user).toEqual([expect.objectContaining({ id: U1, displayName: "Maria" })]);
    expect(f.txLevels).toEqual(["ReadCommitted"]);
    expect(f.txDepth()).toBe(0);
  });

  it("two overlapping RepeatableRead writers of one row: the later committer aborts with P2034; the winner's write survives the rollback", async () => {
    const { f, client } = fake();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const loser = client.$transaction(
      async (tx) => {
        await tx.user.update({ where: { id: U1 }, data: { displayName: "Loser" } });
        entered();
        await gate;
      },
      { isolationLevel: "RepeatableRead" },
    );
    await inside;
    await client.$transaction(async (tx) => tx.user.update({ where: { id: U1 }, data: { displayName: "Winner" } }), {
      isolationLevel: "RepeatableRead",
    });
    release();
    await expect(loser).rejects.toMatchObject({ code: "P2034" });
    expect(f.world.user.find((u) => u.id === U1)).toMatchObject({ displayName: "Winner" });
    expect(f.txLevels).toEqual(["RepeatableRead", "RepeatableRead"]);
  });

  it("at ReadCommitted the same overlap is not a conflict (last writer wins, as in Postgres)", async () => {
    const { f, client } = fake();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const first = client.$transaction(
      async (tx) => {
        entered();
        await gate;
        await tx.user.update({ where: { id: U1 }, data: { displayName: "Later" } });
      },
      { isolationLevel: "ReadCommitted" },
    );
    await inside;
    await client.$transaction(async (tx) => tx.user.update({ where: { id: U1 }, data: { displayName: "Earlier" } }), {
      isolationLevel: "ReadCommitted",
    });
    release();
    await first;
    expect(f.world.user.find((u) => u.id === U1)).toMatchObject({ displayName: "Later" });
  });
});
