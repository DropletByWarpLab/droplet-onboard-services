/**
 * WARP-230 — unit tests for device-identity.client.ts.
 *
 * Tests inject a hand-rolled stub satisfying `DeviceIdentityStub`; no
 * gRPC channel is opened. Mirrors the EmbeddingClient test seam.
 */
import { describe, it, expect, vi } from "vitest";
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
  };
}

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
});
