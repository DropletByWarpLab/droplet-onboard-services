/**
 * WARP-2900 (ADR-056 slice H1): an extension signature is never another
 * protocol's signature, and no other protocol's signature is an extension
 * signature.
 *
 * The box extension key and the device-id key are different keys (the
 * sidecar pins that: tests/test_extension_signing.py). This suite assumes the
 * WORST case anyway, one key signing everything, and shows the message
 * formats alone keep the protocols apart:
 *
 *   - every device-key message (audit daily root, hardware BOM, legacy overlay
 *     revoke, registry challenge/provision/release), signed raw the way the
 *     Sign RPC signs it, is refused by the
 *     extension verifier;
 *   - an extension envelope signature verifies over none of those messages;
 *   - the extension prefix is disjoint from every device-key prefix, and the
 *     envelope is not JSON, so neither bare-JSON format can be confused with
 *     it.
 */
import { describe, it, expect } from "vitest";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EXTENSION_STATEMENT_PREFIX, verifyExtensionStatement } from "./update-agent/extension-verify.js";
import { canonicalizeDailyRoot } from "./audit-daily-root.service.js";
import { extensionKeyFingerprint } from "./extension-manifest.js";
import { canonicalizeComponents } from "./hardware-bom.service.js";
import {
  buildOverlayRevokeMessage,
} from "./overlay-revoke.service.js";
import {
  CHALLENGE_PREFIX,
  buildProvisionMessage,
  buildReleaseMessage,
} from "./fleet-registration.service.js";

const fx = (name: string): string => path.join(__dirname, "update-agent", "__fixtures__", name);
const KEY = createPrivateKey(readFileSync(fx("TEST-ONLY-extension.key")));
const PUB = createPublicKey(readFileSync(fx("TEST-ONLY-extension.pub")));
const SPKI = new Uint8Array(PUB.export({ type: "spki", format: "der" }));
const PREFIX = Buffer.from(EXTENSION_STATEMENT_PREFIX, "utf8");

const FP = "sha256:" + "ab".repeat(32);

/** Every message the box signs with its device-id key, as built in-tree. */
const DEVICE_MESSAGES: Array<[string, string]> = [
  [
    "audit daily root",
    canonicalizeDailyRoot({
      date: "2026-09-22",
      firstRowId: "1",
      lastRowId: "9",
      prevRootHash: "prev",
      rowCount: 9,
      tailSignatureHash: "tail",
    }),
  ],
  [
    "hardware BOM",
    canonicalizeComponents([
      { category: "cpu", id: "cpu0", model: "x" },
    ] as unknown as Parameters<typeof canonicalizeComponents>[0]),
  ],
  ["overlay revoke", buildOverlayRevokeMessage("droplet-1", "wgpub")],
  ["tls cert challenge", `${CHALLENGE_PREFIX}nonce:${FP}:label`],
  ["tls provision", buildProvisionMessage("token", "droplet-1", FP)],
  ["tls release", buildReleaseMessage("nonce", "droplet-1", FP)],
];

/** The prefix each prefixed device message starts with. */
const DEVICE_PREFIXES = [
  "droplet-overlay-revoke:v1:",
  CHALLENGE_PREFIX,
  "droplet-provision:v1:",
  "droplet-release:v1:",
];

const MANIFEST = readFileSync(fx("extension.manifest.json"));
const STATEMENT = readFileSync(fx("extension.valid.json"));

describe("cross-protocol: extension signatures vs device-key messages (WARP-2900)", () => {
  it.each(DEVICE_MESSAGES)(
    "a raw signature over the %s message is refused by the extension verifier",
    async (_label, message) => {
      const bytes = Buffer.from(message, "utf8");
      const signature = sign("sha256", bytes, KEY).toString("base64");
      const res = await verifyExtensionStatement({
        statement: bytes,
        signature,
        manifest: MANIFEST,
        boxKey: { spkiDer: SPKI },
        cosignBin: fx("no-such-cosign-binary"),
        releaseAnchorPath: fx("TEST-ONLY-signing.pub"),
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(["extension_kind_missing", "extension_schema_invalid"]).toContain(res.failureReason);
    },
  );

  it.each(DEVICE_MESSAGES)(
    "an extension envelope signature does not verify as the %s message",
    (_label, message) => {
      const envelope = Buffer.concat([PREFIX, STATEMENT]);
      const extSig = sign("sha256", envelope, KEY);
      expect(verify("sha256", envelope, PUB, extSig)).toBe(true); // control
      expect(verify("sha256", Buffer.from(message, "utf8"), PUB, extSig)).toBe(false);
      expect(envelope.equals(Buffer.from(message, "utf8"))).toBe(false);
    },
  );

  it.each(DEVICE_MESSAGES)("the %s message does not start with the extension prefix", (_l, message) => {
    expect(message.startsWith(EXTENSION_STATEMENT_PREFIX)).toBe(false);
  });

  it.each(DEVICE_PREFIXES)("device prefix %j and the extension prefix are disjoint", (p) => {
    expect(EXTENSION_STATEMENT_PREFIX.startsWith(p)).toBe(false);
    expect(p.startsWith(EXTENSION_STATEMENT_PREFIX)).toBe(false);
  });

  it("the envelope is not JSON, so it cannot pass as a daily root or a BOM", () => {
    const envelope = Buffer.concat([PREFIX, STATEMENT]).toString("utf8");
    expect(() => JSON.parse(envelope)).toThrow();
  });

  it("the statement itself (unprefixed) is refused when the box key signed it raw", async () => {
    // The device Sign RPC signs raw bytes. If it were ever handed a statement,
    // that signature still fails: the box path verifies the envelope only.
    const signature = sign("sha256", STATEMENT, KEY).toString("base64");
    const res = await verifyExtensionStatement({
      statement: STATEMENT,
      signature,
      manifest: MANIFEST,
      boxKey: { spkiDer: SPKI },
      recorded: {
        signer: "box",
        keyFingerprint: extensionKeyFingerprint(SPKI),
      },
    });
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });
});
