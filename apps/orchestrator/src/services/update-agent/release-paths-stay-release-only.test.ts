/**
 * WARP-2900 (ADR-056 slice H1): the OTA release paths never accept the box
 * extension key.
 *
 * The extension trust model is one-way: the Warp Lab release key may vouch
 * for an extension, the box extension key may never vouch for a release.
 * These tests take the golden valid release manifest, have the TEST-ONLY box
 * extension key sign it (raw, and in the prefixed extension envelope), and
 * pin that both OTA verifiers refuse it with signature_failed, while the
 * same manifest signed by the release key still verifies (so a refusal here
 * is the key, not a broken fixture).
 *
 * Real cosign, never skipped (COSIGN_DEPENDENT_SUITES). The static half of
 * this contract (verify.ts / poller.ts / app-downloads/store.ts never import
 * the extension verifier) is in src/__tests__/extension-signer.guard.test.ts.
 *
 * The reverse direction is pinned too: an extension statement the RELEASE
 * key signed passes cosign (same key, same raw-bytes scheme) but is refused
 * by verifyAndParseRelease, because it is not a release manifest.
 *
 * MUTATION: let verifyReleaseSignature also accept a signature the box
 * extension key made -> the two refusal tests go red.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { verifyAndParseRelease, verifyReleaseSignature } from "./verify.js";

const fx = (name: string): string => path.join(__dirname, "__fixtures__", name);
const ANCHOR = fx("TEST-ONLY-signing.pub");

describe("OTA release paths stay release-key-only (WARP-2900)", () => {
  it("control: the release-key signature over the same manifest verifies", async () => {
    const res = await verifyAndParseRelease({
      manifestPath: fx("release.valid.json"),
      signaturePath: fx("release.valid.json.sig"),
      publicKeyPath: ANCHOR,
    });
    expect(res.ok).toBe(true);
  });

  it.each([
    ["raw", "release.valid.json.ext-key.sig"],
    ["prefixed envelope", "release.valid.json.ext-key-prefixed.sig"],
  ])("verifyReleaseSignature refuses a %s box-extension-key signature", async (_label, sig) => {
    const res = await verifyReleaseSignature({
      manifestPath: fx("release.valid.json"),
      signaturePath: fx(sig),
      publicKeyPath: ANCHOR,
    });
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });

  it.each([
    ["raw", "release.valid.json.ext-key.sig"],
    ["prefixed envelope", "release.valid.json.ext-key-prefixed.sig"],
  ])("verifyAndParseRelease refuses a %s box-extension-key signature", async (_label, sig) => {
    const res = await verifyAndParseRelease({
      manifestPath: fx("release.valid.json"),
      signaturePath: fx(sig),
      publicKeyPath: ANCHOR,
    });
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });

  // The other direction (review #2312). Both kinds are cosign over raw bytes
  // under the same release key, with no domain separation between them, so a
  // release-key-signed EXTENSION statement carries a signature the OTA path
  // accepts. What keeps it off the OTA path is the release manifest schema
  // (manifest.ts, which requires release/services/configs). Pin that here, so
  // loosening the schema, or skipping the parse after the signature, is red.
  it("control: the release key really did sign the extension statement (cosign accepts it)", async () => {
    const res = await verifyReleaseSignature({
      manifestPath: fx("extension.valid.json"),
      signaturePath: fx("extension.valid.json.release.sig"),
      publicKeyPath: ANCHOR,
    });
    expect(res.ok).toBe(true);
  });

  it("verifyAndParseRelease refuses a release-key-signed extension statement", async () => {
    // MUTATION: return the parsed JSON without parseReleaseManifest -> ok, red.
    // MUTATION: make release/services/configs optional in manifestSchema -> red.
    const res = await verifyAndParseRelease({
      manifestPath: fx("extension.valid.json"),
      signaturePath: fx("extension.valid.json.release.sig"),
      publicKeyPath: ANCHOR,
    });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ ok: false, failureReason: "schema_invalid" });
  });

  it("even pointed at the extension public key, the release path takes no envelope", async () => {
    // Worst case: a misconfiguration makes the box extension key the OTA
    // trust anchor. The prefixed envelope still cannot pass as a release,
    // because the release path verifies the raw bytes it will parse.
    const res = await verifyReleaseSignature({
      manifestPath: fx("release.valid.json"),
      signaturePath: fx("release.valid.json.ext-key-prefixed.sig"),
      publicKeyPath: fx("TEST-ONLY-extension.pub"),
    });
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });
});
