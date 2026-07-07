import { describe, it, expect, beforeEach } from "vitest";
import { getOrCreateDek, getDek, getDeksByIds, shredDocumentKey } from "./document-key.service.js";
import { __setColumnCryptoKeyForTest } from "./column-crypto.service.js";

function fakePrisma() {
  const rows = new Map<string, { keyId: string; wrappedDek: string }>();
  return {
    documentEncryptionKey: {
      findUnique: async ({ where: { keyId } }: any) => rows.get(keyId) ?? null,
      create: async ({ data }: any) => { rows.set(data.keyId, data); return data; },
      findMany: async ({ where: { keyId: { in: ids } } }: any) =>
        ids.map((id: string) => rows.get(id)).filter(Boolean),
      delete: async ({ where: { keyId } }: any) => { rows.delete(keyId); },
    },
    __rows: rows,
  } as any;
}

describe("document-key.service", () => {
  beforeEach(() => __setColumnCryptoKeyForTest(Buffer.alloc(32, 7).toString("base64")));

  it("mints once, then returns the same unwrapped DEK", async () => {
    const prisma = fakePrisma();
    const a = await getOrCreateDek(prisma, "brain:item1");
    const b = await getOrCreateDek(prisma, "brain:item1");
    expect(a.equals(b)).toBe(true);
    expect(prisma.__rows.size).toBe(1);
    expect(prisma.__rows.get("brain:item1").wrappedDek).not.toContain(a.toString("base64"));
  });

  it("getDek returns null for unknown keyId (crypto-shredded doc)", async () => {
    const prisma = fakePrisma();
    await getOrCreateDek(prisma, "brain:item1");
    await shredDocumentKey(prisma, "brain:item1");
    expect(await getDek(prisma, "brain:item1")).toBeNull();
  });

  it("getDeksByIds batch-unwraps", async () => {
    const prisma = fakePrisma();
    const a = await getOrCreateDek(prisma, "brain:a");
    const map = await getDeksByIds(prisma, ["brain:a", "brain:missing"]);
    expect(map.get("brain:a")!.equals(a)).toBe(true);
    expect(map.has("brain:missing")).toBe(false);
  });
});
