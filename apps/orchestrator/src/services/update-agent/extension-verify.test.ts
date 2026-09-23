/**
 * WARP-2900 (ADR-056 slice H1): verifyExtensionStatement, the paths that
 * never reach cosign.
 *
 * The box extension key is checked in-process (Node crypto, ECDSA-P256-
 * SHA256 over EXTENSION_STATEMENT_PREFIX || statement). Every case here is
 * decided before any cosign spawn: a regression that makes one of them fall
 * through to cosign surfaces as `cosign_unavailable` on a machine without
 * cosign, or as the wrong reason in CI. The cases that do need the release
 * key (fixtures b and d) are in extension-verify.cosign.test.ts.
 *
 * Fixture letters follow the WARP-2900 plan:
 *   (a) kind "release", signed by the box extension key -> key_usage_mismatch
 *   (c) no kind, signed by the box extension key        -> extension_kind_missing
 *
 * Mutations these tests are written to catch are named inline.
 */
import { describe, it, expect } from "vitest";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  EXTENSION_STATEMENT_PREFIX,
  verifyExtensionStatement,
  type VerifyExtensionStatementOptions,
} from "./extension-verify.js";
import { extensionKeyFingerprint } from "../extension-manifest.js";
import {
  buildExtensionStatement,
  extensionStatementSchema,
  manifestSha256,
} from "../extension-manifest.js";
import { REPO_ROOT } from "../../__tests__/helpers/test-paths.js";

const fx = (name: string): string => path.join(__dirname, "__fixtures__", name);
const bytes = (name: string): Buffer => readFileSync(fx(name));
const sig = (name: string): string => readFileSync(fx(name), "utf8");

const EXT_SPKI = createPublicKey(readFileSync(fx("TEST-ONLY-extension.pub"))).export({
  type: "spki",
  format: "der",
});
const EXT_FP = extensionKeyFingerprint(EXT_SPKI);
const BOX = { spkiDer: new Uint8Array(EXT_SPKI) };
// Never spawned in this file; a path that reaches cosign fails loudly.
const NO_COSIGN = { cosignBin: fx("no-such-cosign-binary"), releaseAnchorPath: fx("TEST-ONLY-signing.pub") };

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
    ...NO_COSIGN,
    ...extra,
  };
}

describe("verifyExtensionStatement: the box extension key (WARP-2900)", () => {
  it("accepts a statement the box extension key signed over the prefixed envelope", async () => {
    const res = await verifyExtensionStatement(opts("extension.valid.json", "extension.valid.json.box.sig"));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.signer).toBe("box");
    expect(res.keyFingerprint).toBe(EXT_FP);
    expect(res.statement.extensionId).toBe("word-count");
    expect(res.manifest.provides.tools[0].name).toBe("word_count");
  });

  it("the fixture statement is exactly what buildExtensionStatement emits", () => {
    const manifestBytes = bytes("extension.manifest.json");
    const built = buildExtensionStatement({
      commit: "0123456789abcdef0123456789abcdef01234567",
      extensionId: "word-count",
      manifestSha256: manifestSha256(manifestBytes),
      tree: "89abcdef0123456789abcdef0123456789abcdef",
      version: "0.1.0",
      workspaceId: "word-count",
    });
    expect(built.equals(bytes("extension.valid.json"))).toBe(true);
  });

  it("accepts it when the record says the box signed it with this key", async () => {
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.box.sig", {
        recorded: { signer: "box", keyFingerprint: EXT_FP },
      }),
    );
    expect(res).toMatchObject({ ok: true, signer: "box" });
  });

  it("refuses a box-key signature over the bare statement (no prefix)", async () => {
    // MUTATION: verify the box key over the bare statement -> accepted.
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.box-unprefixed.sig", {
        recorded: { signer: "box", keyFingerprint: EXT_FP },
      }),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });

  it("(a) kind 'release' signed by the box key is key_usage_mismatch, never signature_failed", async () => {
    // MUTATION: let the box key verify a kind-release statement -> accepted
    // or schema_invalid; MUTATION: map the mismatch to signature_failed -> red.
    const res = await verifyExtensionStatement(
      opts("extension.kind-release.json", "extension.kind-release.json.box.sig"),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "key_usage_mismatch" });
  });

  it("a release-key-signed statement of kind 'release' is refused before any cosign spawn", async () => {
    // Review #2312: the non-extension branch used to run cosign for a result
    // that could never be ok (the statement schema pins kind "extension").
    // It refuses right after the key_usage_mismatch check now. NO_COSIGN
    // points at a binary that does not exist, so a spawn would answer
    // cosign_unavailable instead.
    // MUTATION: put the releaseKeyVerifies() call back in that branch ->
    // cosign_unavailable, red.
    const res = await verifyExtensionStatement(
      opts("extension.kind-release.json", "extension.kind-release.json.release.sig"),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "extension_schema_invalid" });
  });

  it.each([
    ["no box key on the box", { boxKey: undefined }],
    ["a box key that did not sign it", {}],
  ])("a non-extension kind signed by no known key is refused without cosign (%s)", async (_l, extra) => {
    const res = await verifyExtensionStatement(
      opts("extension.kind-release.json", "extension.valid.json.neither.sig", extra),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "extension_schema_invalid" });
  });

  it("(c) a statement with no kind is extension_kind_missing, before any key is tried", async () => {
    // MUTATION: drop the kind check -> the box key verifies it and the
    // result becomes schema_invalid or ok.
    const res = await verifyExtensionStatement(
      opts("extension.no-kind.json", "extension.no-kind.json.box.sig"),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "extension_kind_missing" });
  });

  it("a tampered statement under a box record is signature_failed", async () => {
    const res = await verifyExtensionStatement(
      opts("extension.tampered.json", "extension.tampered.json.box.sig", {
        recorded: { signer: "box", keyFingerprint: EXT_FP },
      }),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });

  it("a signed statement whose digest names other bytes is extension_digest_mismatch", async () => {
    // MUTATION: skip the digest comparison -> accepted.
    const res = await verifyExtensionStatement(
      opts("extension.wrong-digest.json", "extension.wrong-digest.json.box.sig"),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "extension_digest_mismatch" });
  });

  it("stored manifest bytes changed after signing is extension_digest_mismatch", async () => {
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.box.sig", {
        manifest: bytes("extension.manifest.tampered.json"),
      }),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "extension_digest_mismatch" });
  });

  it("the box key rotated since signing (disk rebuilt) is extension_key_changed", async () => {
    // MUTATION: drop the recorded-fingerprint comparison -> signature_failed.
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const rotated = { spkiDer: new Uint8Array(publicKey.export({ type: "spki", format: "der" })) };
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.box.sig", {
        boxKey: rotated,
        recorded: { signer: "box", keyFingerprint: EXT_FP },
      }),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "extension_key_changed" });
  });

  it("a box record on a box with no extension key at all is extension_key_changed", async () => {
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.box.sig", {
        boxKey: null,
        recorded: { signer: "box", keyFingerprint: EXT_FP },
      }),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "extension_key_changed" });
  });

  it("a box key that is not P-256 never verifies", async () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    const res = await verifyExtensionStatement(
      opts("extension.valid.json", "extension.valid.json.box.sig", {
        boxKey: { spkiDer: new Uint8Array(publicKey.export({ type: "spki", format: "der" })) },
        recorded: { signer: "box", keyFingerprint: extensionKeyFingerprint(publicKey.export({ type: "spki", format: "der" })) },
      }),
    );
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });

  it("a signature that is not base64 is signature_failed", async () => {
    const res = await verifyExtensionStatement({
      ...opts("extension.valid.json", "extension.valid.json.box.sig"),
      signature: "not base64 at all!",
    });
    expect(res).toMatchObject({ ok: false, failureReason: "signature_failed" });
  });
});

describe("verifyExtensionStatement: statement shape (WARP-2900)", () => {
  const KEY = createPrivateKey(readFileSync(fx("TEST-ONLY-extension.key")));
  const boxSign = (stmt: Buffer): string =>
    sign("sha256", Buffer.concat([Buffer.from(EXTENSION_STATEMENT_PREFIX, "utf8"), stmt]), KEY).toString("base64");
  const manifest = bytes("extension.manifest.json");
  const valid = JSON.parse(bytes("extension.valid.json").toString("utf8")) as Record<string, unknown>;
  const run = (stmt: Buffer) =>
    verifyExtensionStatement({ statement: stmt, signature: boxSign(stmt), manifest, boxKey: BOX, ...NO_COSIGN });

  it("malformed JSON is extension_schema_invalid", async () => {
    expect(await run(Buffer.from("{nope", "utf8"))).toMatchObject({
      ok: false,
      failureReason: "extension_schema_invalid",
    });
  });

  it("a JSON array is extension_schema_invalid", async () => {
    expect(await run(Buffer.from("[1]", "utf8"))).toMatchObject({
      ok: false,
      failureReason: "extension_schema_invalid",
    });
  });

  it("non-canonical bytes (whitespace, key order, duplicate keys) are extension_schema_invalid", async () => {
    // MUTATION: drop the canonical check -> the pretty-printed one is accepted.
    const pretty = Buffer.from(JSON.stringify(valid, null, 2), "utf8");
    expect(await run(pretty)).toMatchObject({ ok: false, failureReason: "extension_schema_invalid" });
    const text = bytes("extension.valid.json").toString("utf8");
    const dup = Buffer.from(text.replace('{"commit"', '{"kind":"release","commit"'), "utf8");
    expect(await run(dup)).toMatchObject({ ok: false, failureReason: "extension_schema_invalid" });
  });

  it("an extra key in a box-signed statement is extension_schema_invalid", async () => {
    const withExtra = Buffer.from(
      JSON.stringify(Object.fromEntries(Object.entries({ ...valid, zzz: 1 }).sort())),
      "utf8",
    );
    expect(await run(withExtra)).toMatchObject({ ok: false, failureReason: "extension_schema_invalid" });
  });

  it("a signed manifest that fails the manifest schema is extension_schema_invalid", async () => {
    const bad = Buffer.from(JSON.stringify({ kind: "extension", egress: "lan" }), "utf8");
    const stmt = Buffer.from(
      JSON.stringify(Object.fromEntries(Object.entries({ ...valid, manifestSha256: manifestSha256(bad) }).sort())),
      "utf8",
    );
    const res = await verifyExtensionStatement({
      statement: stmt,
      signature: boxSign(stmt),
      manifest: bad,
      boxKey: BOX,
      ...NO_COSIGN,
    });
    expect(res).toMatchObject({ ok: false, failureReason: "extension_schema_invalid" });
  });

  it("an extensionId that is not the workspace id's derived slug is extension_schema_invalid", async () => {
    // Review finding (WARP-2900 H1): the slug is the extension's identity
    // (serverId "ext-<slug>"); a signed statement may not name any other.
    // MUTATION: drop the slug check in the verifier -> accepted.
    const stmt = Buffer.from(
      JSON.stringify(Object.fromEntries(Object.entries({ ...valid, extensionId: "other-extension" }).sort())),
      "utf8",
    );
    expect(await run(stmt)).toMatchObject({ ok: false, failureReason: "extension_schema_invalid" });
  });

  it("a statement version that differs from the manifest version is extension_schema_invalid", async () => {
    const stmt = Buffer.from(
      JSON.stringify(Object.fromEntries(Object.entries({ ...valid, version: "9.9.9" }).sort())),
      "utf8",
    );
    expect(await run(stmt)).toMatchObject({ ok: false, failureReason: "extension_schema_invalid" });
  });
});

describe("the prefix is the sidecar's constant (drift gate)", () => {
  it("mirrors EXTENSION_STATEMENT_PREFIX in services/device-identity-svc/extension_signing.py", () => {
    // Read as text, like adr-043-boundary reads the bridge: no import.
    const py = readFileSync(
      path.join(REPO_ROOT, "services", "device-identity-svc", "extension_signing.py"),
      "utf8",
    );
    const m = /^EXTENSION_STATEMENT_PREFIX = b"([^"]+)"$/m.exec(py);
    expect(m, "EXTENSION_STATEMENT_PREFIX not found in extension_signing.py").not.toBeNull();
    expect(EXTENSION_STATEMENT_PREFIX).toBe(m![1]);
  });

  it("the sidecar signs exactly the key set of extensionStatementSchema (review #2312)", () => {
    // The sidecar refuses a statement with one key more or fewer than
    // EXTENSION_STATEMENT_KEYS. If the schema gains a field without the
    // sidecar, every promote is refused; if the sidecar gains one without the
    // schema, it signs statements no verifier accepts. Either way, red here.
    const py = readFileSync(
      path.join(REPO_ROOT, "services", "device-identity-svc", "extension_signing.py"),
      "utf8",
    );
    const m = /^EXTENSION_STATEMENT_KEYS = frozenset\(\{([^}]*)\}\)$/m.exec(py);
    expect(m, "EXTENSION_STATEMENT_KEYS not found in extension_signing.py").not.toBeNull();
    const pyKeys = [...m![1].matchAll(/"([^"]+)"/g)].map((k) => k[1]).sort();
    expect(pyKeys).toEqual(Object.keys(extensionStatementSchema.shape).sort());
  });
});
