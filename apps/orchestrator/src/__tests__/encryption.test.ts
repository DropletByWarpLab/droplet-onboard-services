import { describe, it, expect, beforeEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  __setEncryptionKeyForTest,
} from "../services/encryption.service.js";

describe("encryption.service — aes-256-gcm round trip", () => {
  beforeEach(() => {
    // Install a deterministic key for each test.
    __setEncryptionKeyForTest(randomBytes(32).toString("base64"));
  });

  it("round-trips a typical Nextcloud app password", () => {
    const plaintext = "x9B3e2zQa1Kp9vL8";
    const blob = encryptSecret(plaintext);
    expect(blob).not.toContain(plaintext);
    expect(decryptSecret(blob)).toBe(plaintext);
  });

  it("round-trips unicode strings", () => {
    const plaintext = "héllo 🗝️ ääää — пароль";
    expect(decryptSecret(encryptSecret(plaintext))).toBe(plaintext);
  });

  it("produces a distinct ciphertext for every encryption (fresh iv)", () => {
    const plaintext = "same-input";
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plaintext);
    expect(decryptSecret(b)).toBe(plaintext);
  });

  it("rejects tampered ciphertext", () => {
    const blob = encryptSecret("do-not-tamper");
    const tampered = Buffer.from(blob, "base64");
    tampered[tampered.length - 1] ^= 0x01;
    const corrupted = tampered.toString("base64");
    expect(() => decryptSecret(corrupted)).toThrow();
  });

  it("rejects ciphertext decrypted with the wrong key", () => {
    const blob = encryptSecret("only-for-key-A");
    __setEncryptionKeyForTest(randomBytes(32).toString("base64"));
    expect(() => decryptSecret(blob)).toThrow();
  });

  it("throws when no key is configured", () => {
    __setEncryptionKeyForTest(null);
    expect(() => encryptSecret("anything")).toThrow(/DEVICE_SECRET_KEY/);
  });

  it("throws when the key decodes to the wrong length", () => {
    __setEncryptionKeyForTest(Buffer.from("too-short").toString("base64"));
    expect(() => encryptSecret("anything")).toThrow(/32 bytes/);
  });
});
