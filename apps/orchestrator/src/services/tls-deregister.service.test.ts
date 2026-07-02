import { describe, it, expect, vi } from "vitest";

import {
  signChallenge,
  deregisterFromHq,
  CHALLENGE_PREFIX,
  DEREGISTER_RESULT_OK,
  DEREGISTER_RESULT_SKIPPED,
  DEREGISTER_RESULT_FAILED,
  type HqIssuanceClient,
  type HqDeregisterRequest,
  type SignChallengeDeps,
  type DeregisterDeps,
} from "./tls-issuance.service.js";

// ---------------------------------------------------------------------------
// ADR-023 PR-3 — signed factory-reset HQ deregistration.
//
// The deployed HQ Worker's DELETE /api/issuance/registration REQUIRES a signed
// TPM-PoP body (device_id, nonce, signature, sig_alg, key_fingerprint) — a
// bodyless DELETE 422s and HQ never unbinds. The box CAN compute the PoP: it
// signs a FRESH HQ challenge nonce with the device-identity sidecar, exactly the
// way the order flow does (the signed bytes are byte-identical:
// `droplet-cert:v1:<nonce>:<key_fingerprint>:<public_label>`).
//
// These tests pin: the signed-message bytes, that a deregister re-fetches a
// fresh challenge (no cached nonce), the non-fatal failure posture (returns a
// sentinel, never throws), the 422-shape regression (all four auth keys present
// + truthy), and that the adapter DELETE carries the right url/method/query/body.
// ---------------------------------------------------------------------------

const FQDN = "d-abc123def456.devices.warp-lab.ai";
const DEVICE_ID = "droplet-test-01";
const KEY_FINGERPRINT = "sha256:deadbeef";
const PUBLIC_LABEL = "d-abc123def456";
const NONCE = "nonce-xyz";

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function makeHqClient(overrides: Partial<HqIssuanceClient> = {}): HqIssuanceClient {
  return {
    challenge: vi.fn(async () => ({
      nonce: NONCE,
      expires_at: daysFromNow(1),
      public_label: PUBLIC_LABEL,
      fqdn: FQDN,
    })),
    order: vi.fn(async () => ({
      order_id: "ord-1",
      status: "pending" as const,
      fqdn: FQDN,
    })),
    poll: vi.fn(async () => ({ status: "active" as const })),
    renew: vi.fn(async () => ({
      order_id: "ord-2",
      status: "pending" as const,
      fqdn: FQDN,
    })),
    deregister: vi.fn(async () => ({
      device_id: DEVICE_ID,
      status: "revoked" as const,
    })),
    provision: vi.fn(async () => ({
      device_id: DEVICE_ID,
      status: "registered" as const,
      idempotent: false,
    })),
    claimName: vi.fn(async (req) => ({
      device_id: req.device_id,
      name: req.name,
      fqdn: `${req.name}.droplet-us.com`,
      status: "claimed" as const,
    })),
    release: vi.fn(async () => ({
      device_id: DEVICE_ID,
      status: "released" as const,
    })),
    ...overrides,
  };
}

function makeDeviceIdentity() {
  return {
    signWithDeviceKey: vi.fn(async () => ({
      signature: new Uint8Array([1, 2, 3, 4]),
      algorithm: "ecdsa-sha256",
    })),
    getDeviceIdentityStatus: vi.fn(async () => ({
      provisioned: true,
      backend: "mock" as const,
      certSubject: "CN=device",
      certFingerprint: KEY_FINGERPRINT,
      certExpiresAt: daysFromNow(3650),
      sealingPcrs: [0, 2, 4, 7],
      sealValid: true,
      lastResealAt: daysFromNow(-1),
      currentPcrSnapshot: {},
    })),
  };
}

function makeSignDeps(over: Partial<SignChallengeDeps> = {}): SignChallengeDeps {
  return {
    deviceId: DEVICE_ID,
    hq: makeHqClient(),
    identity: makeDeviceIdentity() as unknown as SignChallengeDeps["identity"],
    ...over,
  };
}

function makeDeregDeps(over: Partial<DeregisterDeps> = {}): DeregisterDeps {
  return {
    deviceId: DEVICE_ID,
    hq: makeHqClient(),
    identity: makeDeviceIdentity() as unknown as DeregisterDeps["identity"],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// signChallenge — the shared PoP builder
// ---------------------------------------------------------------------------

describe("signChallenge — shared PoP", () => {
  it("signs the exact contract bytes droplet-cert:v1:<nonce>:<key_fingerprint>:<public_label>", async () => {
    const identity = makeDeviceIdentity();
    const deps = makeSignDeps({
      identity: identity as unknown as SignChallengeDeps["identity"],
    });

    const signed = await signChallenge(deps);

    // Byte-pin: the exact message handed to the TPM signer.
    const signedBytes = (identity.signWithDeviceKey as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as Uint8Array;
    const signedStr = Buffer.from(signedBytes).toString("utf8");
    expect(signedStr).toBe(
      `${CHALLENGE_PREFIX}${NONCE}:${KEY_FINGERPRINT}:${PUBLIC_LABEL}`,
    );

    // The returned PoP material carries every field HQ checks.
    expect(signed.nonce).toBe(NONCE);
    expect(signed.key_fingerprint).toBe(KEY_FINGERPRINT);
    expect(signed.sig_alg).toBe("ecdsa-sha256");
    expect(typeof signed.signature).toBe("string");
    expect(signed.signature.length).toBeGreaterThan(0);
    expect(signed.signature).toBe(
      Buffer.from(new Uint8Array([1, 2, 3, 4])).toString("base64"),
    );
    expect(signed.fqdn).toBe(FQDN);
    expect(signed.public_label).toBe(PUBLIC_LABEL);
  });

  it("requests a FRESH challenge each call (single-use nonce, never cached)", async () => {
    const hq = makeHqClient();
    const deps = makeSignDeps({ hq });

    await signChallenge(deps);
    await signChallenge(deps);

    // Two calls → two challenge fetches. HQ nonces are single-use; reusing one
    // is rejected (401 "nonce already used"), so a cached nonce would silently
    // break the second flow.
    expect(hq.challenge).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// deregisterFromHq — non-throwing, signed DELETE
// ---------------------------------------------------------------------------

describe("deregisterFromHq", () => {
  it("happy path: signs a fresh challenge and DELETEs the registration with the full PoP body", async () => {
    const hq = makeHqClient();
    const deps = makeDeregDeps({ hq });

    const result = await deregisterFromHq(deps);

    expect(result).toBe(DEREGISTER_RESULT_OK);
    expect(hq.challenge).toHaveBeenCalledTimes(1);
    expect(hq.deregister).toHaveBeenCalledTimes(1);

    // 422-shape regression: ALL four PoP keys present AND truthy in the body.
    const req = (hq.deregister as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as HqDeregisterRequest;
    expect(req.device_id).toBe(DEVICE_ID);
    expect(req.device_id).toBeTruthy();
    expect(req.nonce).toBe(NONCE);
    expect(req.nonce).toBeTruthy();
    expect(req.signature).toBeTruthy();
    expect(req.sig_alg).toBe("ecdsa-sha256");
    expect(req.sig_alg).toBeTruthy();
    expect(req.key_fingerprint).toBe(KEY_FINGERPRINT);
    expect(req.key_fingerprint).toBeTruthy();
  });

  it("uses a FRESH challenge nonce per deregister (not a stale/cached one)", async () => {
    const hq = makeHqClient();
    const deps = makeDeregDeps({ hq });

    await deregisterFromHq(deps);

    // The nonce that authenticated the DELETE is the one HQ just minted.
    const req = (hq.deregister as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as HqDeregisterRequest;
    expect(req.nonce).toBe(NONCE);
    expect(hq.challenge).toHaveBeenCalledTimes(1);
  });

  it("transient HQ error is NON-FATAL: returns the failure sentinel, never throws", async () => {
    const hq = makeHqClient({
      deregister: vi.fn(async () => {
        throw new Error("HQ /api/issuance/registration returned 503: down");
      }),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const deps = makeDeregDeps({ hq, logger });

    let result: string | undefined;
    await expect(
      (async () => {
        result = await deregisterFromHq(deps);
      })(),
    ).resolves.toBeUndefined();

    expect(result).toBe(DEREGISTER_RESULT_FAILED);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("a thrown challenge fetch is also non-fatal (sentinel, no throw)", async () => {
    const hq = makeHqClient({
      challenge: vi.fn(async () => {
        throw new Error("HQ /api/issuance/order/challenge returned 500: boom");
      }),
    });
    const deps = makeDeregDeps({ hq });

    const result = await deregisterFromHq(deps);

    expect(result).toBe(DEREGISTER_RESULT_FAILED);
    expect(hq.deregister).not.toHaveBeenCalled();
  });

  it("a sign failure (sidecar down at reset time) is non-fatal (sentinel, no throw)", async () => {
    const identity = makeDeviceIdentity();
    (identity.signWithDeviceKey as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("device-identity socket unreachable"),
    );
    const hq = makeHqClient();
    const deps = makeDeregDeps({
      hq,
      identity: identity as unknown as DeregisterDeps["identity"],
    });

    const result = await deregisterFromHq(deps);

    expect(result).toBe(DEREGISTER_RESULT_FAILED);
    expect(hq.deregister).not.toHaveBeenCalled();
  });

  it("no-ops with the SKIPPED sentinel when the device is not provisioned", async () => {
    const identity = makeDeviceIdentity();
    (identity.getDeviceIdentityStatus as ReturnType<typeof vi.fn>).mockResolvedValue(
      {
        provisioned: false,
        backend: "mock" as const,
        certSubject: "",
        certFingerprint: "",
        certExpiresAt: "",
        sealingPcrs: [],
        sealValid: false,
        lastResealAt: "",
        currentPcrSnapshot: {},
      },
    );
    const hq = makeHqClient();
    const deps = makeDeregDeps({
      hq,
      identity: identity as unknown as DeregisterDeps["identity"],
    });

    const result = await deregisterFromHq(deps);

    expect(result).toBe(DEREGISTER_RESULT_SKIPPED);
    // Never even reaches HQ — no challenge, no DELETE.
    expect(hq.challenge).not.toHaveBeenCalled();
    expect(hq.deregister).not.toHaveBeenCalled();
  });
});
