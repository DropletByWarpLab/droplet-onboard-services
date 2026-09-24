/**
 * WARP-230 — unit tests for device-identity.client.ts.
 *
 * Tests inject a hand-rolled stub satisfying `DeviceIdentityStub`; no
 * gRPC channel is opened. Mirrors the EmbeddingClient test seam.
 */
import { describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
import type { ServiceError } from "@grpc/grpc-js";

import {
  createDeviceIdentityClient,
  type DeviceIdentityStub,
} from "./device-identity.client.js";

function makeStub(overrides: Partial<DeviceIdentityStub> = {}): DeviceIdentityStub {
  const notImpl = () => {
    throw new Error("stub method not configured");
  };
  return {
    sign: overrides.sign ?? (notImpl as DeviceIdentityStub["sign"]),
    getCert: overrides.getCert ?? (notImpl as DeviceIdentityStub["getCert"]),
    getStatus:
      overrides.getStatus ?? (notImpl as DeviceIdentityStub["getStatus"]),
    reseal: overrides.reseal ?? (notImpl as DeviceIdentityStub["reseal"]),
    signExtensionManifest:
      overrides.signExtensionManifest ??
      (notImpl as DeviceIdentityStub["signExtensionManifest"]),
  };
}

/** A GetStatusResponse with every field the proto declares. */
function statusResponse(extensionSpkiDer: Uint8Array, extensionKeyFingerprint: string) {
  return {
    provisioned: true,
    backend: "mock",
    certSubject: "CN=droplet-test",
    certFingerprint: "sha256:abc",
    certExpiresAt: "2031-05-11T00:00:00Z",
    sealingPcrs: [0, 2, 4, 7],
    sealValid: true,
    lastResealAt: "",
    currentPcrSnapshot: { 0: "00", 2: "00", 4: "00", 7: "00" },
    extensionSpkiDer,
    extensionKeyFingerprint,
  };
}

const sha256Fp = (b: Uint8Array): string =>
  `sha256:${createHash("sha256").update(b).digest("hex")}`;

describe("device-identity.client", () => {
  it("getDeviceIdentityStatus() unwraps the gRPC response into the expected camelCase shape", async () => {
    const stub = makeStub({
      getStatus: (_req, cb) => {
        cb(null, {
          provisioned: true,
          backend: "mock",
          certSubject: "CN=droplet-test",
          certFingerprint: "sha256:abc",
          certExpiresAt: "2031-05-11T00:00:00Z",
          sealingPcrs: [0, 2, 4, 7],
          sealValid: true,
          lastResealAt: "",
          currentPcrSnapshot: { 0: "00", 2: "00", 4: "00", 7: "00" },
          extensionSpkiDer: new Uint8Array(0),
          extensionKeyFingerprint: "",
        });
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    const status = await client.getDeviceIdentityStatus();
    expect(status.provisioned).toBe(true);
    expect(status.backend).toBe("mock");
    expect(status.sealingPcrs).toEqual([0, 2, 4, 7]);
    expect(status.sealValid).toBe(true);
    expect(status.currentPcrSnapshot["0"]).toBe("00");
  });

  // ── WARP-2900: the extension key ────────────────────────────────────────

  it("signExtensionManifest forwards the statement bytes and returns the signature + public half", async () => {
    const spki = new Uint8Array([9, 8, 7]);
    const seen: Uint8Array[] = [];
    const stub = makeStub({
      signExtensionManifest: (req, cb) => {
        seen.push(req.statement);
        cb(null, {
          signature: new Uint8Array([1, 2]),
          algorithm: "ECDSA-P256-SHA256",
          extensionSpkiDer: spki,
          keyUsage: "extension",
        });
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    const stmt = new TextEncoder().encode('{"kind":"extension"}');
    const r = await client.signExtensionManifest(stmt);
    expect(Array.from(seen[0])).toEqual(Array.from(stmt));
    expect(Array.from(r.signature)).toEqual([1, 2]);
    expect(Array.from(r.extensionSpkiDer)).toEqual([9, 8, 7]);
    expect(r.keyFingerprint).toBe(sha256Fp(spki));
    expect(r.algorithm).toBe("ECDSA-P256-SHA256");
  });

  it("signExtensionManifest refuses a response signed under any other key usage", async () => {
    // MUTATION: drop the keyUsage check -> this resolves.
    const stub = makeStub({
      signExtensionManifest: (_req, cb) => {
        cb(null, {
          signature: new Uint8Array([1]),
          algorithm: "ECDSA-P256-SHA256",
          extensionSpkiDer: new Uint8Array([1]),
          keyUsage: "device",
        });
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    await expect(client.signExtensionManifest(new Uint8Array([1]))).rejects.toThrow(
      /key usage/,
    );
  });

  it("signExtensionManifest refuses a response with no public key or no signature", async () => {
    const stub = makeStub({
      signExtensionManifest: (_req, cb) => {
        cb(null, {
          signature: new Uint8Array(0),
          algorithm: "ECDSA-P256-SHA256",
          extensionSpkiDer: new Uint8Array(0),
          keyUsage: "extension",
        });
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    await expect(client.signExtensionManifest(new Uint8Array([1]))).rejects.toThrow(
      /empty/,
    );
  });

  it("signExtensionManifest propagates FAILED_PRECONDITION from the sidecar", async () => {
    const stub = makeStub({
      signExtensionManifest: (_req, cb) => {
        cb(Object.assign(new Error("9 FAILED_PRECONDITION: device not provisioned"), {
          code: 9,
        }) as ServiceError, null);
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    await expect(client.signExtensionManifest(new Uint8Array([1]))).rejects.toMatchObject({
      code: 9,
    });
  });

  it("getExtensionPublicKey is null until the sidecar has created the key", async () => {
    const stub = makeStub({
      getStatus: (_req, cb) => {
        cb(null, statusResponse(new Uint8Array(0), ""));
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    expect(await client.getExtensionPublicKey()).toBeNull();
  });

  it("getExtensionPublicKey returns the SPKI and a fingerprint it recomputed itself", async () => {
    const spki = new Uint8Array([4, 5, 6]);
    const stub = makeStub({
      getStatus: (_req, cb) => {
        cb(null, statusResponse(spki, sha256Fp(spki)));
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    const key = await client.getExtensionPublicKey();
    expect(key).not.toBeNull();
    expect(Array.from(key!.spkiDer)).toEqual([4, 5, 6]);
    expect(key!.fingerprint).toBe(sha256Fp(spki));
  });

  it("getExtensionPublicKey refuses a fingerprint that does not match the SPKI", async () => {
    // MUTATION: trust the sidecar's fingerprint string -> this resolves.
    const spki = new Uint8Array([4, 5, 6]);
    const stub = makeStub({
      getStatus: (_req, cb) => {
        cb(null, statusResponse(spki, `sha256:${"0".repeat(64)}`));
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    await expect(client.getExtensionPublicKey()).rejects.toThrow(/fingerprint/);
  });

  it("signWithDeviceKey returns the raw signature bytes + algorithm", async () => {
    const stub = makeStub({
      sign: (_req, cb) => {
        cb(null, {
          signature: new Uint8Array([1, 2, 3]),
          algorithm: "ECDSA-P256-SHA256",
        });
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    const sig = await client.signWithDeviceKey(new Uint8Array([0xff]));
    expect(Array.from(sig.signature)).toEqual([1, 2, 3]);
    expect(sig.algorithm).toBe("ECDSA-P256-SHA256");
  });

  it("getDeviceCert returns the cert PEM string", async () => {
    const stub = makeStub({
      getCert: (_req, cb) => {
        cb(null, { certPem: "-----BEGIN CERTIFICATE-----\n..." });
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    const cert = await client.getDeviceCert();
    expect(cert).toContain("BEGIN CERTIFICATE");
  });

  it("requestReseal forwards the operator nonce as operatorAuthNonce", async () => {
    const sawReq: { operatorAuthNonce?: string }[] = [];
    const stub = makeStub({
      reseal: (req, cb) => {
        sawReq.push(req);
        cb(null, {
          resealed: true,
          sealedAt: "2026-05-11T03:00:00Z",
          newPcrSnapshotIndices: [0, 2, 4, 7],
        });
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    const result = await client.requestReseal("operator-nonce-abc");
    expect(sawReq[0].operatorAuthNonce).toBe("operator-nonce-abc");
    expect(result.resealed).toBe(true);
    expect(result.sealedAt).toBe("2026-05-11T03:00:00Z");
    expect(result.newPcrSnapshotIndices).toEqual([0, 2, 4, 7]);
  });

  it("propagates gRPC ServiceError from the stub", async () => {
    const stub = makeStub({
      getStatus: (_req, cb) => {
        const err = new Error("UNAVAILABLE") as ServiceError;
        cb(err, null);
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    await expect(client.getDeviceIdentityStatus()).rejects.toThrow(
      "UNAVAILABLE",
    );
  });

  it("treats null gRPC response as an error", async () => {
    const stub = makeStub({
      getCert: (_req, cb) => {
        cb(null, null);
        return undefined;
      },
    });
    const client = createDeviceIdentityClient({ stubFactory: () => stub });
    await expect(client.getDeviceCert()).rejects.toThrow(
      /empty gRPC response/,
    );
  });

  // Ensures the constructor doesn't actually open a Unix socket when a
  // stubFactory is provided — protects the test seam from regressions.
  it("does not call the default gRPC client constructor when stubFactory is supplied", () => {
    const factory = vi.fn(() => makeStub());
    createDeviceIdentityClient({ stubFactory: factory });
    expect(factory).toHaveBeenCalled();
  });

  // A wedged sidecar that never invokes the gRPC callback must not hang the
  // caller forever — the per-call deadline rejects (ADR-023 PR-3 regression
  // guard: factory-reset's tls-deregister can't block at Phase 0b).
  it("rejects when the sidecar never invokes the gRPC callback (deadline)", async () => {
    vi.useFakeTimers();
    try {
      const stub = makeStub({
        // Never calls cb — simulates a present-but-hung sidecar.
        getStatus: () => undefined,
      });
      const client = createDeviceIdentityClient({ stubFactory: () => stub });
      const pending = client.getDeviceIdentityStatus();
      // Surface the rejection now so it isn't reported as unhandled when the
      // fake clock advances past the deadline below.
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(20_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
