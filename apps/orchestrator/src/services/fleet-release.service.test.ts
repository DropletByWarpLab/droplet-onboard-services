import { describe, it, expect, vi } from "vitest";
import { releaseFromHq, buildReleaseMessage, RELEASE_RESULT_OK, RELEASE_RESULT_SKIPPED, RELEASE_RESULT_FAILED, type FleetRegistrationClient, type HqReleaseRequest, type ReleaseDeps } from "./fleet-registration.service.js";

const DEVICE_ID = "droplet-test-01";
const KEY_FINGERPRINT = "sha256:deadbeef";
const PUBLIC_LABEL = "d-abc123def456";
const OPAQUE_FQDN = "d-abc123def456.devices.warp-lab.ai";
const NONCE = "nonce-xyz";

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function makeHqClient(overrides: Partial<FleetRegistrationClient> = {}): FleetRegistrationClient {
  return {
    challenge: vi.fn(async () => ({
      nonce: NONCE,
      expires_at: daysFromNow(1),
      public_label: PUBLIC_LABEL,
      fqdn: OPAQUE_FQDN,
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
    release: vi.fn(async () => ({
      device_id: DEVICE_ID,
      status: "released" as const,
    })),
    ...overrides,
  };
}

function makeDeviceIdentity(provisioned = true) {
  return {
    signWithDeviceKey: vi.fn(async () => ({
      signature: new Uint8Array([1, 2, 3, 4]),
      algorithm: "ecdsa-sha256",
    })),
    getDeviceIdentityStatus: vi.fn(async () => ({
      provisioned,
      backend: "mock" as const,
      certSubject: "CN=device",
      certFingerprint: provisioned ? KEY_FINGERPRINT : "",
      certExpiresAt: daysFromNow(3650),
      sealingPcrs: [0, 2, 4, 7],
      sealValid: true,
      lastResealAt: daysFromNow(-1),
      currentPcrSnapshot: {},
    })),
  };
}

function makeReleaseDeps(over: Partial<ReleaseDeps> = {}): ReleaseDeps {
  return {
    deviceId: DEVICE_ID,
    hq: makeHqClient(),
    identity: makeDeviceIdentity() as unknown as ReleaseDeps["identity"],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

describe("releaseFromHq", () => {
  it("happy path: signs droplet-release:v1 and POSTs the release with the PoP body", async () => {
    const hq = makeHqClient();
    const identity = makeDeviceIdentity();
    const deps = makeReleaseDeps({
      hq,
      identity: identity as unknown as ReleaseDeps["identity"],
    });

    const result = await releaseFromHq(deps);

    expect(result).toBe(RELEASE_RESULT_OK);
    expect(hq.challenge).toHaveBeenCalledTimes(1);
    expect(hq.release).toHaveBeenCalledTimes(1);

    // The signed bytes are the release PoP (distinct domain from claim/cert).
    const signedBytes = (identity.signWithDeviceKey as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as Uint8Array;
    expect(Buffer.from(signedBytes).toString("utf8")).toBe(
      buildReleaseMessage(NONCE, DEVICE_ID, KEY_FINGERPRINT),
    );

    // device_id travels as the FIRST arg (→ QUERY); the body is the PoP only.
    const [deviceIdArg, req] = (hq.release as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, HqReleaseRequest];
    expect(deviceIdArg).toBe(DEVICE_ID);
    expect(req.nonce).toBe(NONCE);
    expect(req.signature.length).toBeGreaterThan(0);
    expect(req.sig_alg).toBe("ecdsa-sha256");
    expect(req.key_fingerprint).toBe(KEY_FINGERPRINT);
    // The release body must NOT carry a device_id (it rides in the query).
    expect(req).not.toHaveProperty("device_id");
  });

  it("no-ops with SKIPPED when the device is not provisioned (nothing to release)", async () => {
    const hq = makeHqClient();
    const identity = makeDeviceIdentity(false);
    const result = await releaseFromHq(
      makeReleaseDeps({
        hq,
        identity: identity as unknown as ReleaseDeps["identity"],
      }),
    );
    expect(result).toBe(RELEASE_RESULT_SKIPPED);
    expect(hq.challenge).not.toHaveBeenCalled();
    expect(hq.release).not.toHaveBeenCalled();
  });

  it("transient HQ error is NON-FATAL: returns FAILED, never throws", async () => {
    const hq = makeHqClient({
      release: vi.fn(async () => {
        throw new Error("HQ /api/issuance/release returned 503: down");
      }),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let result: string | undefined;
    await expect(
      (async () => {
        result = await releaseFromHq(makeReleaseDeps({ hq, logger }));
      })(),
    ).resolves.toBeUndefined();
    expect(result).toBe(RELEASE_RESULT_FAILED);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("a thrown challenge fetch is also non-fatal (FAILED, no release)", async () => {
    const hq = makeHqClient({
      challenge: vi.fn(async () => {
        throw new Error("HQ /api/issuance/order/challenge returned 500: boom");
      }),
    });
    const result = await releaseFromHq(makeReleaseDeps({ hq }));
    expect(result).toBe(RELEASE_RESULT_FAILED);
    expect(hq.release).not.toHaveBeenCalled();
  });

  it("uses a FRESH challenge nonce per release (not a stale/cached one)", async () => {
    const hq = makeHqClient();
    const deps = makeReleaseDeps({ hq });
    await releaseFromHq(deps);
    const [, req] = (hq.release as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      HqReleaseRequest,
    ];
    expect(req.nonce).toBe(NONCE);
    expect(hq.challenge).toHaveBeenCalledTimes(1);
  });
});
