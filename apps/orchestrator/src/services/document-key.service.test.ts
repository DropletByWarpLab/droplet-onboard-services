import { describe, it, expect, beforeEach } from "vitest";
import {
  getOrCreateDek,
  getDek,
  getDeksByIds,
  shredDocumentKey,
  shredDocumentKeys,
} from "./document-key.service.js";
import { __setColumnCryptoKeyForTest } from "./column-crypto.service.js";

type Row = { keyId: string; version: number; wrappedDek: string };

/** In-memory stand-in for the (keyId, version)-keyed DocumentEncryptionKey
 *  table — supports the findFirst/findMany/create/deleteMany subset the
 *  service uses. */
function fakePrisma() {
  const rows: Row[] = [];
  const byKey = (keyId: string) =>
    rows.filter((r) => r.keyId === keyId).sort((a, b) => b.version - a.version);
  return {
    documentEncryptionKey: {
      findFirst: async ({ where: { keyId } }: any) => byKey(keyId)[0] ?? null,
      create: async ({ data }: any) => {
        if (rows.some((r) => r.keyId === data.keyId && r.version === data.version)) {
          throw new Error("P2002 unique constraint");
        }
        rows.push(data);
        return data;
      },
      findMany: async ({ where: { keyId } }: any) => {
        const ids: string[] = keyId.in ?? [keyId];
        return rows
          .filter((r) => ids.includes(r.keyId))
          .sort((a, b) => a.version - b.version);
      },
      deleteMany: async ({ where: { keyId } }: any) => {
        const ids: string[] = typeof keyId === "string" ? [keyId] : keyId.in;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (ids.includes(rows[i]!.keyId)) rows.splice(i, 1);
        }
      },
    },
    __rows: rows,
  } as any;
}

describe("document-key.service", () => {
  beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 7).toString("base64")));

  it("mints version 1 once, then returns the same unwrapped DEK", async () => {
    const prisma = fakePrisma();
    const a = await getOrCreateDek(prisma, "brain:item1");
    const b = await getOrCreateDek(prisma, "brain:item1");
    expect(a.equals(b)).toBe(true);
    expect(prisma.__rows).toHaveLength(1);
    expect(prisma.__rows[0].version).toBe(1);
    expect(prisma.__rows[0].wrappedDek).not.toContain(a.toString("base64"));
  });

  it("getDek returns null for unknown keyId (crypto-shredded doc)", async () => {
    const prisma = fakePrisma();
    await getOrCreateDek(prisma, "brain:item1");
    await shredDocumentKey(prisma, "brain:item1");
    expect(await getDek(prisma, "brain:item1")).toBeNull();
  });

  it("shred deletes ALL versions for a keyId", async () => {
    const prisma = fakePrisma();
    await getOrCreateDek(prisma, "brain:item1");
    // Simulate a mid-rotation second version (rotation slice is a follow-up;
    // the shred contract must already cover it).
    prisma.__rows.push({ ...prisma.__rows[0], version: 2 });
    await shredDocumentKey(prisma, "brain:item1");
    expect(prisma.__rows).toHaveLength(0);
    expect(await getDek(prisma, "brain:item1")).toBeNull();
  });

  it("shredDocumentKeys batch-deletes (user purge) and is a no-op on missing keys", async () => {
    const prisma = fakePrisma();
    await getOrCreateDek(prisma, "brain:a");
    await getOrCreateDek(prisma, "brain:b");
    await shredDocumentKeys(prisma, ["brain:a", "brain:b", "brain:missing"]);
    expect(prisma.__rows).toHaveLength(0);
  });

  it("getDeksByIds batch-unwraps, latest version winning per keyId", async () => {
    const prisma = fakePrisma();
    const a = await getOrCreateDek(prisma, "brain:a");
    const map = await getDeksByIds(prisma, ["brain:a", "brain:missing"]);
    expect(map.get("brain:a")!.equals(a)).toBe(true);
    expect(map.has("brain:missing")).toBe(false);
  });

  it("mint race: losing the (keyId, version) insert re-reads the winner's DEK", async () => {
    const prisma = fakePrisma();
    const winner = await getOrCreateDek(prisma, "brain:item1");
    // Force the racing path: the first findFirst misses (reader raced ahead
    // of the insert), the create collides, the re-read lands on the winner.
    const realFindFirst = prisma.documentEncryptionKey.findFirst;
    let firstCall = true;
    prisma.documentEncryptionKey.findFirst = async (args: any) => {
      if (firstCall) {
        firstCall = false;
        return null;
      }
      return realFindFirst(args);
    };
    const loser = await getOrCreateDek(prisma, "brain:item1");
    expect(loser.equals(winner)).toBe(true);
    expect(prisma.__rows).toHaveLength(1);
  });
});
