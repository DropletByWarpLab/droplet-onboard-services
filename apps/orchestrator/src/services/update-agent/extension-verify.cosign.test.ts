/**
 * WARP-2900 (ADR-056 slice H1): verifyExtensionStatement against the REAL
 * cosign binary, for the paths that consult the Warp Lab release key.
 *
 * Like verify.test.ts, this suite execs `cosign verify-blob` and never
 * skips: a skipped trust test is a hole. It is listed in
 * COSIGN_DEPENDENT_SUITES (src/__tests__/env-preflight.ts), so a machine
 * without cosign gets one named failure instead of fake trust breaks. CI
 * installs cosign (sigstore/cosign-installer) before the orchestrator suite.
 *
 * Fixture letters follow the WARP-2900 plan:
 *   (b) kind "extension", signed by neither key            -> signature_failed
 *   (d) kind "extension", cosign-signed by the release key -> ok, signer release
 *
 * extension.valid.json.release.sig is `cosign sign-blob --key
 * TEST-ONLY-signing.key` output: base64 of a DER ECDSA-P256-SHA256 signature
 * over the raw statement bytes (see __fixtures__/README.md for how it was
 * minted and how to regenerate it with cosign).
 */
import { describe, it, expect } from "vitest";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { verifyExtensionStatement, type VerifyExtensionStatementOptions } from "./extension-verify.js";
import { extensionKeyFingerprint } from "../extension-manifest.js";

const fx = (name: string): string => path.join(__dirname, "__fixtures__", name);
const bytes = (name: string): Buffer => readFileSync(fx(name));
const sig = (name: string): string => readFileSync(fx(name), "utf8");

const EXT_SPKI = createPublicKey(readFileSync(fx("TEST-ONLY-extension.pub"))).export({
  type: "spki",
  format: "der",
});
const RELEASE_SPKI = createPublicKey(readFileSync(fx("TEST-ONLY-signing.pub"))).export({
  type: "spki",
  format: "der",
});
const BOX = { spkiDer: new Uint8Array(EXT_SPKI) };
const ANCHOR = fx("TEST-ONLY-signing.pub");

function opts(
  statement: string,
  signature: string,
  extra: Partial<VerifyExtensionStatementOptions> = {},
): VerifyExtensionStatementOptions {
  return {
    statement: bytes(statement),
    signature: sig(signature),
    manifest: bytes("extension.manifest.json"),
    boxKey: BOX,
    releaseAnchorPath: ANCHOR,
    ...extra,
  };
}

describe("verifyExtensionStatement: the release key via cosign (WARP-2900)", () => {
  it("(d) accepts kind 'extension' cosign-signed by the release key", async () => {
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.release.sig"),
    );
    expect(res).toMatchObject({ ok: true, signer: "release" });
    if (!res.ok) return;
    expect(res.keyFingerprint).toBe(extensionKeyFingerprint(RELEASE_SPKI));
  });

  it("(d) also verifies on a box that has no extension key yet", async () => {
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.release.sig", { boxKey: null }),
    );
    expect(res).toMatchObject({ ok: true, signer: "release" });
  });

  it("(b) refuses kind 'extension' signed by neither key as signature_failed", async () => {
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.neither.sig"),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });

  it("refuses a tampered statement with no record as signature_failed (both keys tried)", async () => {
    const res = await verifyExtensionStatement(
      opts("extension.tampered.json", "extension.tampered.json.box.sig"),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });

  it("a record that says 'release' does not accept the box key", async () => {
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.box.sig", {
        recorded: { signer: "release", keyFingerprint: extensionKeyFingerprint(RELEASE_SPKI) },
      }),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });

  it("a record naming a different release key is extension_key_changed", async () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.release.sig", {
        recorded: {
          signer: "release",
          keyFingerprint: extensionKeyFingerprint(publicKey.export({ type: "spki", format: "der" })),
        },
      }),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "extension_key_changed" });
  });

  it("the placeholder release anchor fails closed on the release path", async () => {
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.release.sig", {
        releaseAnchorPath: fx("placeholder-cosign.pub"),
      }),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "trust_anchor_placeholder" });
  });
});
