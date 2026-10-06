import { describe, it, expect, vi } from "vitest";
import { createPublicKey } from "node:crypto";
import { provisionWithHq, extractPublicKeyPem, createFleetRegistrationClient } from "./fleet-registration.service.js";
import type { HqProvisionRequest } from "./fleet-registration.service.js";

// Test-only P-256 certificate; its discarded private key is never needed.
const EC_CERT = `-----BEGIN CERTIFICATE-----
MIIBojCCAUmgAwIBAgIUZ0rjcvVmLINsWCnUepsNJlPF8sIwCgYIKoZIzj0EAwIw
JzElMCMGA1UEAwwcVEVTVC1PTkxZLWZsZWV0LXJlZ2lzdHJhdGlvbjAeFw0yNjEw
MDUyMjM2MDlaFw0yNjEwMDYyMjM2MDlaMCcxJTAjBgNVBAMMHFRFU1QtT05MWS1m
bGVldC1yZWdpc3RyYXRpb24wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASstIa5
smLBmDZMiIX4ICC+ZcQtnadJ+6QxAPCmlLhVYiWKgjSr4hnbRBrJE/hiZN+3WO+X
brDJj61eSaKUaQz5o1MwUTAdBgNVHQ4EFgQU5v6wPZyKRZtjYjhXvCilOo+KfLow
HwYDVR0jBBgwFoAU5v6wPZyKRZtjYjhXvCilOo+KfLowDwYDVR0TAQH/BAUwAwEB
/zAKBggqhkjOPQQDAgNHADBEAiB73+mnh7YQ3S2Y9o92cYWaT8GHd306B7outsBf
t7itGwIgFVnj67GttNtTffwfgtgfXu0xldZCi87cMW3ciaIRRlE=
-----END CERTIFICATE-----`;

describe("fleet registry provisioning", () => {
  it("extracts an EC identity SPKI and signs the provision token contract", async () => {
    const identity = {
      getDeviceIdentityStatus: vi.fn(async () => ({ certFingerprint: "sha256:test" } as never)),
      getDeviceCert: vi.fn(async () => EC_CERT),
      signWithDeviceKey: vi.fn(async () => ({
        signature: new Uint8Array([1, 2, 3]), algorithm: "ecdsa-sha256",
      } as never)),
    };
    const provision = vi.fn(async (_req: HqProvisionRequest) => ({ device_id: "box", status: "registered" as const, idempotent: false }));
    const response = await provisionWithHq({
      deviceId: "box", provisionToken: "test-token", identity, hq: { provision },
    });
    expect(response.status).toBe("registered");
    expect(identity.signWithDeviceKey).toHaveBeenCalledWith(
      new TextEncoder().encode("droplet-provision:v1:test-token:box:sha256:test"),
    );
    const req = provision.mock.calls[0][0] as unknown as Record<string, string>;
    expect(req).toMatchObject({
      device_id: "box", key_fingerprint: "sha256:test", token: "test-token",
      signature: "AQID", sig_alg: "ecdsa-sha256",
    });
    expect(createPublicKey(req.public_key_pem).asymmetricKeyType).toBe("ec");
    expect(req.public_key_pem).toBe(extractPublicKeyPem(EC_CERT));
  });

  it("has no certificate issuance, renewal, polling or name-claim methods", () => {
    expect(Object.keys(createFleetRegistrationClient()).sort()).toEqual([
      "challenge", "deregister", "provision", "release",
    ]);
  });
});
