/**
 * WARP-537 — cosign signature verification over golden fixtures.
 *
 * These tests exec the REAL cosign binary (`verify-blob`): the point of
 * the golden fixtures is to prove actual cryptographic rejection, not a
 * mocked exit code. Binary resolution mirrors verify.ts:
 * `DROPLET_COSIGN_BIN` env → `cosign` on PATH. CI installs it via
 * sigstore/cosign-installer (orchestrator-tests.yml); locally install
 * cosign or set DROPLET_COSIGN_BIN. A missing binary FAILS these tests
 * loudly — never skips — because a skipped trust test is a hole.
 *
 * Trust-chain order under test:
 *   1. trust anchor gate  — placeholder/missing key fails closed BEFORE
 *      any cosign spawn (asserted by pointing cosignBin at a
 *      nonexistent path: the placeholder verdict must still win);
 *   2. signature gate     — tampered bytes and wrong-key signatures are
 *      `signature_failed`;
 *   3. parse gate         — only signature-verified bytes reach
 *      parseReleaseManifest (composed verifyAndParseRelease).
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  verifyReleaseSignature,
  verifyAndParseRelease,
  defaultTrustAnchorPath,
  TRUST_ANCHOR_PLACEHOLDER_MARKER,
} from "./verify.js";

const fx = (name: string): string => path.join(__dirname, "__fixtures__", name);

const KEY = fx("TEST-ONLY-signing.pub");

describe("verifyReleaseSignature (WARP-537)", () => {
  it("verifies the golden valid manifest against the test trust anchor", async () => {
    const res = await verifyReleaseSignature({
      manifestPath: fx("release.valid.json"),
      signaturePath: fx("release.valid.json.sig"),
      publicKeyPath: KEY,
    });
    expect(res).toEqual({ ok: true });
  });

  it("rejects tampered manifest bytes as signature_failed", async () => {
    const res = await verifyReleaseSignature({
      manifestPath: fx("release.tampered.json"),
      signaturePath: fx("release.tampered.json.sig"),
      publicKeyPath: KEY,
    });
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });

  it("rejects a signature minted by a different key as signature_failed", async () => {
    const res = await verifyReleaseSignature({
      manifestPath: fx("release.valid.json"),
      signaturePath: fx("release.valid.json.wrong-key.sig"),
      publicKeyPath: KEY,
    });
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });

  it("fails closed on the placeholder trust anchor WITHOUT spawning cosign", async () => {
    const res = await verifyReleaseSignature({
      manifestPath: fx("release.valid.json"),
      signaturePath: fx("release.valid.json.sig"),
      publicKeyPath: fx("placeholder-cosign.pub"),
      // If the placeholder gate ever ran cosign first, this nonexistent
      // binary would surface as cosign_unavailable instead — the
      // assertion below proves the trust-anchor verdict dominates.
      cosignBin: fx("no-such-cosign-binary"),
    });
    expect(res).toMatchObject({
      ok: false,
      failureReason: "trust_anchor_placeholder",
    });
  });

  it("fails closed on a missing trust-anchor file", async () => {
    const res = await verifyReleaseSignature({
      manifestPath: fx("release.valid.json"),
      signaturePath: fx("release.valid.json.sig"),
      publicKeyPath: fx("no-such-key.pub"),
    });
    expect(res).toMatchObject({
      ok: false,
      failureReason: "trust_anchor_placeholder",
    });
  });

  it("reports a missing cosign binary as cosign_unavailable (fail closed, distinct reason)", async () => {
    const res = await verifyReleaseSignature({
      manifestPath: fx("release.valid.json"),
      signaturePath: fx("release.valid.json.sig"),
      publicKeyPath: KEY,
      cosignBin: fx("no-such-cosign-binary"),
    });
    expect(res).toMatchObject({ ok: false, failureReason: "cosign_unavailable" });
  });
});

describe("verifyAndParseRelease (composed trust chain)", () => {
  it("returns the typed manifest for a valid signed release", async () => {
    const res = await verifyAndParseRelease({
      manifestPath: fx("release.valid.json"),
      signaturePath: fx("release.valid.json.sig"),
      publicKeyPath: KEY,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.manifest.release.gitSha).toBe(
      "0123456789abcdef0123456789abcdef01234567",
    );
  });

  it("rejects a correctly-signed but malformed manifest as malformed_manifest", async () => {
    const res = await verifyAndParseRelease({
      manifestPath: fx("release.malformed.json"),
      signaturePath: fx("release.malformed.json.sig"),
      publicKeyPath: KEY,
    });
    expect(res).toMatchObject({ ok: false, failureReason: "malformed_manifest" });
  });

  it("rejects a correctly-signed schema-downgrade manifest as schema_downgrade", async () => {
    const res = await verifyAndParseRelease({
      manifestPath: fx("release.schema-downgrade.json"),
      signaturePath: fx("release.schema-downgrade.json.sig"),
      publicKeyPath: KEY,
    });
    expect(res).toMatchObject({ ok: false, failureReason: "schema_downgrade" });
  });

  it("rejects a correctly-signed schema-invalid manifest as schema_invalid", async () => {
    const res = await verifyAndParseRelease({
      manifestPath: fx("release.schema-invalid.json"),
      signaturePath: fx("release.schema-invalid.json.sig"),
      publicKeyPath: KEY,
    });
    expect(res).toMatchObject({ ok: false, failureReason: "schema_invalid" });
  });

  it("rejects tampered bytes at the signature gate, before parsing", async () => {
    const res = await verifyAndParseRelease({
      manifestPath: fx("release.tampered.json"),
      signaturePath: fx("release.tampered.json.sig"),
      publicKeyPath: KEY,
    });
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });
});

describe("defaultTrustAnchorPath", () => {
  it("resolves to the shipped trust-anchor file", () => {
    const p = defaultTrustAnchorPath();
    expect(existsSync(p)).toBe(true);
    expect(p).toMatch(/update-agent[\\/]cosign\.pub$/);
  });

  it("the shipped anchor is a real key, not the placeholder (key ceremony ran)", async () => {
    // This assertion is about the CURRENT repo state. It was inverted when
    // the human key ceremony (scripts/README.md, "OTA release signing")
    // stamped the real cosign public key over the WARP-535 placeholder —
    // the tripwire that forced this edit is exactly what it was for.
    //
    // It stays as a REVERSE tripwire: if a merge, a bad revert, or a
    // rebase ever restores the placeholder, production verify silently
    // starts failing closed on every release and this test says so.
    // The placeholder-detection code path itself is still covered — see
    // the placeholder-cosign.pub fixture cases above.
    const { readFileSync } = await import("node:fs");
    const anchor = readFileSync(defaultTrustAnchorPath(), "utf8");
    expect(anchor).not.toContain(TRUST_ANCHOR_PLACEHOLDER_MARKER);
    expect(anchor).toContain("-----BEGIN PUBLIC KEY-----");
  });
});
