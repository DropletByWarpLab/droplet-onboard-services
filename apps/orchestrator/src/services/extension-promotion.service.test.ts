/**
 * WARP-2900 (ADR-056 slice H1): signPromotedExtension, the one caller of the
 * sidecar's SignExtensionManifest.
 *
 * H1 ships it with no route (the promote route and its two-phase confirm are
 * H2). What it must already guarantee:
 *
 *   - nothing malformed reaches the sidecar: the manifest is parsed and the
 *     statement is built and schema-checked BEFORE the sign call;
 *   - an unprovisioned or unreachable sidecar is `device_identity_svc_
 *     unreachable` (the promote route's 503), and nothing is returned to
 *     persist;
 *   - the signature that comes back is re-verified with the full extension
 *     verifier before it is handed to the store: a sidecar that signed the
 *     wrong bytes, or without the prefix, is refused here.
 *
 * The identity stub is a real in-process ECDSA-P256 key that mimics the
 * sidecar's envelope, so the self-check is a real verification.
 */
import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  ExtensionPromotionRefusedError,
  ExtensionSigningUnavailableError,
  signPromotedExtension,
  type ExtensionSigningIdentity,
} from "./extension-promotion.service.js";
import { extensionKeyFingerprint } from "./extension-manifest.js";
import { EXTENSION_STATEMENT_PREFIX } from "./update-agent/extension-verify.js";
import type { ExtensionSignResult } from "./device-identity.client.js";

const fx = (name: string): string => path.join(__dirname, "update-agent", "__fixtures__", name);
const MANIFEST = readFileSync(fx("extension.manifest.json"));

const INPUT = {
  workspaceId: "word-count",
  version: "0.1.0",
  commit: "0123456789abcdef0123456789abcdef01234567",
  tree: "89abcdef0123456789abcdef0123456789abcdef",
  manifestBytes: MANIFEST,
};

type SignFn = (statement: Uint8Array) => Promise<ExtensionSignResult>;

function sidecar(opts: {
  provisioned?: boolean;
  statusThrows?: boolean;
  prefix?: string;
  key?: KeyObject;
  signError?: Error & { code?: number };
} = {}): ExtensionSigningIdentity & { signExtensionManifest: ReturnType<typeof vi.fn<SignFn>> } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
  const signingKey = opts.key ?? privateKey;
  return {
    getDeviceIdentityStatus: vi.fn(async () => {
      if (opts.statusThrows) throw new Error("14 UNAVAILABLE: connect ENOENT");
      return { provisioned: opts.provisioned ?? true };
    }),
    signExtensionManifest: vi.fn<SignFn>(async (statement: Uint8Array) => {
      if (opts.signError) throw opts.signError;
      const prefix = Buffer.from(opts.prefix ?? EXTENSION_STATEMENT_PREFIX, "utf8");
      return {
        signature: new Uint8Array(sign("sha256", Buffer.concat([prefix, statement]), signingKey)),
        algorithm: "ECDSA-P256-SHA256",
        extensionSpkiDer: spki,
        keyFingerprint: extensionKeyFingerprint(spki),
      };
    }),
  };
}

describe("signPromotedExtension (WARP-2900)", () => {
  it("signs the canonical statement and returns what the store persists", async () => {
    const id = sidecar();
    const out = await signPromotedExtension(id, INPUT);
    expect(id.signExtensionManifest).toHaveBeenCalledTimes(1);
    expect(out.signer).toBe("box");
    expect(out.statementBytes.equals(readFileSync(fx("extension.valid.json")))).toBe(true);
    expect(out.statement.extensionId).toBe("word-count");
    expect(out.keyFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(out.signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(out.readback.tools.total).toBe(1);
  });

  it("an unprovisioned box is device_identity_svc_unreachable and never signs", async () => {
    const id = sidecar({ provisioned: false });
    const err = await signPromotedExtension(id, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionSigningUnavailableError);
    expect((err as ExtensionSigningUnavailableError).code).toBe("device_identity_svc_unreachable");
    expect(id.signExtensionManifest).not.toHaveBeenCalled();
  });

  it("an unreachable sidecar is device_identity_svc_unreachable", async () => {
    const id = sidecar({ statusThrows: true });
    await expect(signPromotedExtension(id, INPUT)).rejects.toBeInstanceOf(
      ExtensionSigningUnavailableError,
    );
  });

  it("FAILED_PRECONDITION from the sign call (no extension key on this backend) is unreachable", async () => {
    const id = sidecar({
      signError: Object.assign(new Error("9 FAILED_PRECONDITION: backend 'real' holds no extension-signing key"), {
        code: 9,
      }),
    });
    await expect(signPromotedExtension(id, INPUT)).rejects.toBeInstanceOf(
      ExtensionSigningUnavailableError,
    );
  });

  it("INVALID_ARGUMENT from the sidecar is a refusal, not an outage", async () => {
    const id = sidecar({
      signError: Object.assign(new Error("3 INVALID_ARGUMENT: statement refused"), { code: 3 }),
    });
    const err = await signPromotedExtension(id, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionPromotionRefusedError);
    expect((err as ExtensionPromotionRefusedError).code).toBe("statement_refused");
  });

  it("an invalid manifest is refused before the sidecar is called", async () => {
    const id = sidecar();
    const bad = Buffer.from(JSON.stringify({ kind: "extension", egress: "lan" }), "utf8");
    const err = await signPromotedExtension(id, { ...INPUT, manifestBytes: bad }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionPromotionRefusedError);
    expect((err as ExtensionPromotionRefusedError).code).toBe("manifest_invalid");
    expect(id.getDeviceIdentityStatus).not.toHaveBeenCalled();
    expect(id.signExtensionManifest).not.toHaveBeenCalled();
  });

  it("a manifest whose version or id differs from the promoted tag is refused", async () => {
    const id = sidecar();
    for (const input of [
      { ...INPUT, version: "0.2.0" },
      { ...INPUT, workspaceId: "other-space" },
    ]) {
      const err = await signPromotedExtension(id, input).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ExtensionPromotionRefusedError);
    }
    expect(id.signExtensionManifest).not.toHaveBeenCalled();
  });

  it("a malformed commit is refused before the sidecar is called", async () => {
    const id = sidecar();
    const err = await signPromotedExtension(id, { ...INPUT, commit: "HEAD" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionPromotionRefusedError);
    expect((err as ExtensionPromotionRefusedError).code).toBe("statement_invalid");
    expect(id.signExtensionManifest).not.toHaveBeenCalled();
  });

  it("a signature made without the extension prefix is refused by the self-check", async () => {
    // MUTATION: drop the post-sign verification -> this resolves.
    const id = sidecar({ prefix: "" });
    const err = await signPromotedExtension(id, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionPromotionRefusedError);
    expect((err as ExtensionPromotionRefusedError).code).toBe("signature_self_check_failed");
  });

  it("a signature by a key other than the one the sidecar reported is refused", async () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const id = sidecar({ key: privateKey });
    const err = await signPromotedExtension(id, INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionPromotionRefusedError);
    expect((err as ExtensionPromotionRefusedError).code).toBe("signature_self_check_failed");
  });

  it("derives a long workspace id's slug within the multiplexer cap", async () => {
    const long = "a-very-long-workspace-identifier-that-exceeds-the-cap";
    const manifest = JSON.parse(MANIFEST.toString("utf8")) as Record<string, unknown>;
    manifest.id = long;
    const out = await signPromotedExtension(sidecar(), {
      ...INPUT,
      workspaceId: long,
      manifestBytes: Buffer.from(JSON.stringify(manifest), "utf8"),
    });
    expect(`ext-${out.statement.extensionId}`.length).toBeLessThanOrEqual(32);
    expect(out.statement.workspaceId).toBe(long);
  });
});
