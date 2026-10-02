/**
 * WARP-2900 (ADR-056 slice H1): sign a promoted extension with the box
 * extension key.
 *
 * This module is the ONLY product caller of the sidecar's
 * SignExtensionManifest (pinned by src/__tests__/extension-signer.guard.
 * test.ts). Keeping the crown-jewel sign behind one function means one place
 * decides what the box vouches for:
 *
 *   1. the manifest bytes parse under the strict schema, and name the same
 *      workspace and version as the tag being promoted;
 *   2. the canonical statement (commit + tree + manifest digest) is built and
 *      schema-checked, so nothing malformed ever reaches the sidecar;
 *   3. the sidecar must be provisioned; an unprovisioned or unreachable one,
 *      or a backend with no extension key, is device_identity_svc_unreachable
 *      (the promote route's 503) and nothing is returned to persist;
 *   4. the signature that comes back is verified with the full extension
 *      verifier, against the key the sidecar says it used, before it is
 *      returned. A sidecar that signed the wrong bytes is caught here, not at
 *      the next install.
 *
 * H1 ships this with no route. The owner-only two-phase promote route
 * (POST /api/extensions/:workspaceId/promote) and the ExtensionVersion store
 * are WARP-2900 H2.
 */
import {
  buildExtensionStatement,
  deriveExtensionSlug,
  deriveReadback,
  manifestSha256,
  parseExtensionManifest,
  type ExtensionManifest,
  type ExtensionReadback,
  type ExtensionStatement,
} from "./extension-manifest.js";
import type { ExtensionSignResult } from "./device-identity.client.js";
import { verifyExtensionStatement } from "./update-agent/extension-verify.js";

/** The two sidecar calls promotion needs, nothing else. The production
 *  DeviceIdentityClient satisfies it structurally. */
export interface ExtensionSigningIdentity {
  getDeviceIdentityStatus(): Promise<{ provisioned: boolean }>;
  signExtensionManifest(statement: Uint8Array): Promise<ExtensionSignResult>;
}

/** The sidecar cannot sign right now. Routes map this to 503. */
export class ExtensionSigningUnavailableError extends Error {
  readonly code = "device_identity_svc_unreachable" as const;
  readonly httpStatus = 503 as const;
  constructor(message: string) {
    super(message);
    this.name = "ExtensionSigningUnavailableError";
  }
}

export type ExtensionPromotionRefusal =
  | "manifest_invalid"
  | "statement_invalid"
  | "statement_refused"
  | "signature_self_check_failed";

/** The promotion is refused on its merits. Routes map this to 4xx/500. */
export class ExtensionPromotionRefusedError extends Error {
  constructor(
    readonly code: ExtensionPromotionRefusal,
    message: string,
  ) {
    super(message);
    this.name = "ExtensionPromotionRefusedError";
  }
}

export interface PromoteSignInput {
  workspaceId: string;
  /** The proposal/<version> tag being promoted. */
  version: string;
  /** The commit the tag points at, and its tree (git rev-parse <c>^{tree}). */
  commit: string;
  tree: string;
  /** extension-manifest.json exactly as committed at `commit`. */
  manifestBytes: Uint8Array;
}

export interface SignedExtension {
  statement: ExtensionStatement;
  /** The canonical statement bytes that were signed (store these). */
  statementBytes: Buffer;
  manifest: ExtensionManifest;
  /** Base64 DER ECDSA-P256-SHA256 over the prefixed envelope. */
  signature: string;
  signer: "box";
  /** "sha256:<hex>" of the extension key's SPKI (store this). */
  keyFingerprint: string;
  extensionSpkiDer: Uint8Array;
  readback: ExtensionReadback;
}

/** gRPC status codes this module distinguishes. */
const GRPC_INVALID_ARGUMENT = 3;

function grpcCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : undefined;
}

export async function signPromotedExtension(
  identity: ExtensionSigningIdentity,
  input: PromoteSignInput,
): Promise<SignedExtension> {
  const manifestBytes = Buffer.from(input.manifestBytes);

  const parsed = parseExtensionManifest(manifestBytes);
  if (!parsed.ok) {
    throw new ExtensionPromotionRefusedError("manifest_invalid", parsed.detail);
  }
  if (parsed.manifest.id !== input.workspaceId || parsed.manifest.version !== input.version) {
    throw new ExtensionPromotionRefusedError(
      "manifest_invalid",
      `manifest is ${parsed.manifest.id}@${parsed.manifest.version}, promoting ${input.workspaceId}@${input.version}`,
    );
  }

  let statementBytes: Buffer;
  try {
    statementBytes = buildExtensionStatement({
      extensionId: deriveExtensionSlug(input.workspaceId),
      workspaceId: input.workspaceId,
      version: input.version,
      commit: input.commit,
      tree: input.tree,
      manifestSha256: manifestSha256(manifestBytes),
    });
  } catch (err) {
    throw new ExtensionPromotionRefusedError("statement_invalid", (err as Error).message);
  }

  let provisioned: boolean;
  try {
    provisioned = (await identity.getDeviceIdentityStatus()).provisioned;
  } catch (err) {
    throw new ExtensionSigningUnavailableError(
      `device identity sidecar unreachable: ${(err as Error).message}`,
    );
  }
  if (!provisioned) {
    throw new ExtensionSigningUnavailableError("device identity is not provisioned on this box");
  }

  let signed: ExtensionSignResult;
  try {
    signed = await identity.signExtensionManifest(statementBytes);
  } catch (err) {
    if (grpcCode(err) === GRPC_INVALID_ARGUMENT) {
      throw new ExtensionPromotionRefusedError("statement_refused", (err as Error).message);
    }
    // FAILED_PRECONDITION (unprovisioned, or no extension key on this
    // backend), UNAVAILABLE, a deadline: the box cannot sign right now.
    throw new ExtensionSigningUnavailableError(
      `extension signing unavailable: ${(err as Error).message}`,
    );
  }

  const signature = Buffer.from(signed.signature).toString("base64");
  const check = await verifyExtensionStatement({
    statement: statementBytes,
    signature,
    manifest: manifestBytes,
    boxKey: { spkiDer: signed.extensionSpkiDer },
    recorded: { signer: "box", keyFingerprint: signed.keyFingerprint },
  });
  if (!check.ok) {
    throw new ExtensionPromotionRefusedError(
      "signature_self_check_failed",
      `the sidecar's signature does not verify (${check.failureReason}): ${check.detail}`,
    );
  }

  return {
    statement: check.statement,
    statementBytes: check.statementBytes,
    manifest: check.manifest,
    signature,
    signer: "box",
    keyFingerprint: check.keyFingerprint,
    extensionSpkiDer: signed.extensionSpkiDer,
    readback: deriveReadback(check.manifest),
  };
}
