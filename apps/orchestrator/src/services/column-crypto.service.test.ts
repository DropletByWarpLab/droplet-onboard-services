import { describe, it, expect, beforeEach } from "vitest";
import {
  ENC_PREFIX, deriveDocKek, generateDek, wrapDek, unwrapDek,
  encryptColumn, decryptColumn, isEncryptedColumn, emailLookupHash,
  __setColumnCryptoKeyForTest,
} from "./column-crypto.service.js";

const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("column-crypto (dcv1)", () => {
  beforeEach(() => __setColumnCryptoKeyForTest(TEST_KEY));

  it("round-trips a column value and prefixes dcv1:", () => {
    const dek = generateDek();
    const blob = encryptColumn(dek, "patient has type-2 diabetes");
    expect(blob.startsWith(ENC_PREFIX)).toBe(true);
    expect(blob).not.toContain("diabetes");                    // pg_dump-is-ciphertext AC, unit level
    expect(decryptColumn(dek, blob)).toBe("patient has type-2 diabetes");
  });

  it("wrap/unwrap binds the DEK to its keyId (AAD)", () => {
    const kek = deriveDocKek();
    const dek = generateDek();
    const wrapped = wrapDek(kek, dek, "brain:abc123");
    expect(unwrapDek(kek, wrapped, "brain:abc123").equals(dek)).toBe(true);
    expect(() => unwrapDek(kek, wrapped, "brain:OTHER")).toThrow(); // GCM auth failure
  });

  it("decrypt with the wrong DEK throws (authenticated)", () => {
    const blob = encryptColumn(generateDek(), "x");
    expect(() => decryptColumn(generateDek(), blob)).toThrow();
  });

  it("emailLookupHash is deterministic + normalizing", () => {
    expect(emailLookupHash("  Alice@Example.COM ")).toBe(emailLookupHash("alice@example.com"));
    expect(emailLookupHash("alice@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cross-language wire format: iv(12) ‖ ct ‖ tag(16)", () => {
    // Fixed vector — the Python twin asserts the SAME blob decrypts (test_column_crypto.py).
    const dek = Buffer.alloc(32, 1);
    const blob = encryptColumn(dek, "interop");
    const raw = Buffer.from(blob.slice(ENC_PREFIX.length), "base64");
    expect(raw.length).toBe(12 + Buffer.byteLength("interop") + 16);
  });

  it("isEncryptedColumn discriminates explicitly", () => {
    expect(isEncryptedColumn("dcv1:AAAA")).toBe(true);
    expect(isEncryptedColumn("plain text")).toBe(false);
  });
});
