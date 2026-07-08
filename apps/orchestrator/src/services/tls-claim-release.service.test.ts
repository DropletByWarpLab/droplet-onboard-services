import { describe, it, expect, vi } from "vitest";

import {
  claimBoxName,
  releaseFromHq,
  buildClaimNameMessage,
  buildReleaseMessage,
  parseClaimConflict,
  CLAIM_RESULT_CLAIMED,
  CLAIM_RESULT_NAME_TAKEN,
  CLAIM_RESULT_ALREADY_NAMED,
  CLAIM_RESULT_NOT_REGISTERED,
  CLAIM_RESULT_INVALID,
  CLAIM_RESULT_FAILED,
  RELEASE_RESULT_OK,
  RELEASE_RESULT_SKIPPED,
  RELEASE_RESULT_FAILED,
  type HqIssuanceClient,
  type HqClaimNameRequest,
  type HqReleaseRequest,
  type ClaimBoxNameDeps,
  type ReleaseDeps,
} from "./tls-issuance.service.js";

// ---------------------------------------------------------------------------
// WARP-980 — device-auth self-heal: claim-name (rename → PoP claim) + release
// (factory-reset frees the name but KEEPS the device registered).
//
// The HQ worker half (feat/warp-980-device-auth-claim on droplet-fleet-hq) is
// already built; the box calls its contract byte-for-byte:
//
//   claim-name  POST /api/issuance/claim-name
//               body {device_id, name, nonce, signature, sig_alg, key_fingerprint}
//               signed `droplet-claim:v1:<nonce>:<name>:<device_id>:<key_fingerprint>`
//               (<name> is the RAW owner-entered name — HQ slugs it)
//   release     POST /api/issuance/release?device_id=<id>  (device_id in QUERY)
//               body {nonce, signature, sig_alg, key_fingerprint}
//               signed `droplet-release:v1:<nonce>:<device_id>:<key_fingerprint>`
//
// These tests pin: the exact signed-message bytes for BOTH domains, a fresh
// challenge per call (single-use nonce), the typed claim outcomes (claimed /
// owned / name-taken-with-suggestions / not-registered / invalid / failed) —
// all NON-fatal (never crash issuance), and the release non-fatal posture
// (sentinel, never throws — a reset must always complete).
// ---------------------------------------------------------------------------

const DEVICE_ID = "droplet-test-01";
const KEY_FINGERPRINT = "sha256:deadbeef";
const PUBLIC_LABEL = "d-abc123def456";
const OPAQUE_FQDN = "d-abc123def456.devices.warp-lab.ai";
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
      fqdn: OPAQUE_FQDN,
    })),
    order: vi.fn(async () => ({
      order_id: "ord-1",
      status: "pending" as const,
      fqdn: OPAQUE_FQDN,
    })),
    poll: vi.fn(async () => ({ status: "active" as const })),
    renew: vi.fn(async () => ({
      order_id: "ord-2",
      status: "pending" as const,
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
    claimName: vi.fn(async (req: HqClaimNameRequest) => ({
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

function makeClaimDeps(over: Partial<ClaimBoxNameDeps> = {}): ClaimBoxNameDeps {
  return {
    deviceId: DEVICE_ID,
    hq: makeHqClient(),
    identity: makeDeviceIdentity() as unknown as ClaimBoxNameDeps["identity"],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
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

// ---------------------------------------------------------------------------
// Message builders — byte-for-byte with the HQ worker
// ---------------------------------------------------------------------------

describe("buildClaimNameMessage / buildReleaseMessage", () => {
  it("claim message is droplet-claim:v1:<nonce>:<name>:<device_id>:<key_fingerprint>", () => {
    expect(buildClaimNameMessage(NONCE, "My Studio", DEVICE_ID, KEY_FINGERPRINT)).toBe(
      `droplet-claim:v1:${NONCE}:My Studio:${DEVICE_ID}:${KEY_FINGERPRINT}`,
    );
  });

  it("claim message carries the RAW (un-slugged) name — HQ slugs it", () => {
    // A mixed-case name with a space is passed VERBATIM; HQ owns normalization.
    expect(
      buildClaimNameMessage(NONCE, "Studio", DEVICE_ID, KEY_FINGERPRINT),
    ).toContain(":Studio:");
  });

  it("release message is droplet-release:v1:<nonce>:<device_id>:<key_fingerprint>", () => {
    expect(buildReleaseMessage(NONCE, DEVICE_ID, KEY_FINGERPRINT)).toBe(
      `droplet-release:v1:${NONCE}:${DEVICE_ID}:${KEY_FINGERPRINT}`,
    );
  });

  it("claim + release use DISTINCT domain prefixes (no cross-replay)", () => {
    const claim = buildClaimNameMessage(NONCE, "studio", DEVICE_ID, KEY_FINGERPRINT);
    const release = buildReleaseMessage(NONCE, DEVICE_ID, KEY_FINGERPRINT);
    expect(claim.startsWith("droplet-claim:v1:")).toBe(true);
    expect(release.startsWith("droplet-release:v1:")).toBe(true);
    expect(claim).not.toBe(release);
  });
});

// ---------------------------------------------------------------------------
// claimBoxName — rename → device-auth PoP name claim
// ---------------------------------------------------------------------------

describe("claimBoxName", () => {
  it("happy path: challenge → sign droplet-claim:v1 → claim → authoritative CLAIMED", async () => {
    const hq = makeHqClient();
    const identity = makeDeviceIdentity();
    const deps = makeClaimDeps({
      hq,
      identity: identity as unknown as ClaimBoxNameDeps["identity"],
    });

    const result = await claimBoxName("My Studio", deps);

    expect(result.outcome).toBe(CLAIM_RESULT_CLAIMED);
    expect(result.authoritative).toBe(true);
    // HQ slugs "My Studio" — the response name/fqdn is what we surface.
    expect(result.slug).toBe("My Studio");
    expect(result.fqdn).toBe("My Studio.droplet-us.com");

    // The signed bytes are the claim PoP, with the RAW name.
    const signedBytes = (identity.signWithDeviceKey as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as Uint8Array;
    expect(Buffer.from(signedBytes).toString("utf8")).toBe(
      buildClaimNameMessage(NONCE, "My Studio", DEVICE_ID, KEY_FINGERPRINT),
    );

    // The claim body carries every PoP field + the RAW name.
    expect(hq.challenge).toHaveBeenCalledTimes(1);
    expect(hq.claimName).toHaveBeenCalledTimes(1);
    const req = (hq.claimName as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as HqClaimNameRequest;
    expect(req.device_id).toBe(DEVICE_ID);
    expect(req.name).toBe("My Studio");
    expect(req.nonce).toBe(NONCE);
    expect(req.sig_alg).toBe("ecdsa-sha256");
    expect(req.key_fingerprint).toBe(KEY_FINGERPRINT);
    expect(req.signature.length).toBeGreaterThan(0);
  });

  it("HQ status 'owned' (device already holds this name) → CLAIMED + authoritative", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async (req: HqClaimNameRequest) => ({
        device_id: req.device_id,
        name: "studio",
        fqdn: "studio.droplet-us.com",
        status: "owned" as const,
      })),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_CLAIMED);
    expect(result.authoritative).toBe(true);
    expect(result.slug).toBe("studio");
  });

  it("409 name taken → NAME_TAKEN with parsed suggestions, non-fatal", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 409: {"error":"name taken","suggestions":["studio-2","studio-hq"]}',
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_NAME_TAKEN);
    expect(result.authoritative).toBe(true);
    expect(result.suggestions).toEqual(["studio-2", "studio-hq"]);
  });

  it("409 with no suggestions in the body → NAME_TAKEN, empty suggestions", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 409: {"error":"device holds a different name"}',
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_NAME_TAKEN);
    expect(result.suggestions).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // WARP-1109 (box half) — the 409 body discriminator. HQ hides TWO distinct
  // conflicts behind a 409:
  //   (a) name held by ANOTHER device            → NAME_TAKEN (+ suggestions)
  //   (b) THIS device already holds a DIFFERENT   → ALREADY_NAMED (+ current_name)
  //       name (rename is now supported, so the wizard offers the rename flow
  //       instead of the false "that name is taken")
  //
  // The coupled fleet-hq change adds a MACHINE-READABLE `code` field
  // (`code: "already_named" | "name_taken"`). The box PREFERS `code`, falls back
  // to the legacy `reason` discriminator (`device_already_named` | `name_taken`,
  // shipped by an interim worker), and finally falls back to the STABLE distinct
  // message text so this is forward-compatible whether or not HQ's `code` is
  // deployed. Absent / unparseable ⇒ NAME_TAKEN (fail-open to old workers).
  // -------------------------------------------------------------------------

  it("409 code 'already_named' → ALREADY_NAMED carrying current_name (preferred HQ code)", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 409: {"error":"device already named \\"scruceru\\" (rename not supported yet)","code":"already_named","current_name":"scruceru"}',
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_ALREADY_NAMED);
    expect(result.authoritative).toBe(true);
    expect(result.currentName).toBe("scruceru");
  });

  it("409 code 'name_taken' → NAME_TAKEN with suggestions (preferred HQ code)", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 409: {"error":"name \\"studio\\" is taken; try: studio-2","code":"name_taken","suggestions":["studio-2"]}',
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_NAME_TAKEN);
    expect(result.authoritative).toBe(true);
    expect(result.suggestions).toEqual(["studio-2"]);
  });

  it("409 with NO code but the stable already-named MESSAGE → ALREADY_NAMED + current_name (message fallback)", async () => {
    // The coupled HQ `code` isn't deployed yet — discriminate on the stable
    // distinct message text so the wizard is correct today.
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 409: {"error":"device already named \\"scruceru\\" (rename not supported yet)"}',
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_ALREADY_NAMED);
    // current_name is recovered from the quoted name in the stable message.
    expect(result.currentName).toBe("scruceru");
  });

  it("409 with the taken MESSAGE (name is taken; try:) → NAME_TAKEN (message fallback)", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 409: {"error":"name \\"studio\\" is taken; try: studio-2, studio-hq","suggestions":["studio-2","studio-hq"]}',
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_NAME_TAKEN);
    expect(result.suggestions).toEqual(["studio-2", "studio-hq"]);
  });

  it("still honors the legacy reason 'device_already_named' discriminator → ALREADY_NAMED (back-compat)", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 409: {"error":"device already holds a name","reason":"device_already_named","current_name":"scruceru"}',
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_ALREADY_NAMED);
    expect(result.currentName).toBe("scruceru");
  });

  it("409 code 'already_named' WITHOUT current_name → ALREADY_NAMED, currentName undefined", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 409: {"code":"already_named"}',
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_ALREADY_NAMED);
    expect(result.currentName).toBeUndefined();
  });

  it("409 with NO body at all → NAME_TAKEN (fail-open to old workers)", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error("HQ /api/issuance/claim-name returned 409: ");
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_NAME_TAKEN);
    expect(result.suggestions).toEqual([]);
  });

  it("409 with a garbage (non-JSON) body → NAME_TAKEN (fail-open to old workers)", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          "HQ /api/issuance/claim-name returned 409: {not json at all",
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_NAME_TAKEN);
    expect(result.suggestions).toEqual([]);
  });

  it("409 with an UNKNOWN reason value → NAME_TAKEN (fail-open, forward-compatible)", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 409: {"reason":"some_future_reason","current_name":42}',
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_NAME_TAKEN);
  });

  it("403 not registered / fp mismatch → NOT_REGISTERED (graceful fallback)", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 403: {"error":"device not registered"}',
        );
      }),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await claimBoxName("studio", makeClaimDeps({ hq, logger }));
    expect(result.outcome).toBe(CLAIM_RESULT_NOT_REGISTERED);
    // Non-authoritative: we fell back, HQ never confirmed the name.
    expect(result.authoritative).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("422 invalid/reserved → INVALID, non-fatal", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 422: {"error":"reserved name"}',
        );
      }),
    });
    const result = await claimBoxName("admin", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_INVALID);
  });

  it("401 bad/expired nonce or sig → FAILED (retryable), non-fatal", async () => {
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        throw new Error(
          'HQ /api/issuance/claim-name returned 401: {"error":"nonce expired"}',
        );
      }),
    });
    const result = await claimBoxName("studio", makeClaimDeps({ hq }));
    expect(result.outcome).toBe(CLAIM_RESULT_FAILED);
  });

  it("device not provisioned → NOT_REGISTERED, never reaches HQ", async () => {
    const hq = makeHqClient();
    const identity = makeDeviceIdentity(false);
    const result = await claimBoxName(
      "studio",
      makeClaimDeps({
        hq,
        identity: identity as unknown as ClaimBoxNameDeps["identity"],
      }),
    );
    expect(result.outcome).toBe(CLAIM_RESULT_NOT_REGISTERED);
    expect(hq.challenge).not.toHaveBeenCalled();
    expect(hq.claimName).not.toHaveBeenCalled();
  });

  it("a challenge/sign network failure → FAILED, never throws (issuance is never crashed)", async () => {
    const hq = makeHqClient({
      challenge: vi.fn(async () => {
        throw new Error("HQ /api/issuance/order/challenge returned 503: down");
      }),
    });
    let result: { outcome: string } | undefined;
    await expect(
      (async () => {
        result = await claimBoxName("studio", makeClaimDeps({ hq }));
      })(),
    ).resolves.toBeUndefined();
    expect(result?.outcome).toBe(CLAIM_RESULT_FAILED);
    expect(hq.claimName).not.toHaveBeenCalled();
  });

  it("requests a FRESH challenge per claim (single-use nonce)", async () => {
    const hq = makeHqClient();
    const deps = makeClaimDeps({ hq });
    await claimBoxName("studio", deps);
    await claimBoxName("studio", deps);
    expect(hq.challenge).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// releaseFromHq — factory-reset frees the NAME but keeps the device registered
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// parseClaimConflict — code → reason → message-text precedence (WARP-1109)
// ---------------------------------------------------------------------------

function conflictErr(body: string): Error {
  return new Error(`HQ /api/issuance/claim-name returned 409: ${body}`);
}

describe("parseClaimConflict (discriminator precedence)", () => {
  it("prefers the machine-readable `code` over everything", () => {
    const c = parseClaimConflict(
      conflictErr('{"code":"already_named","current_name":"scruceru"}'),
    );
    expect(c.reason).toBe("already_named");
    expect(c.currentName).toBe("scruceru");
  });

  it("maps code 'name_taken' to name_taken", () => {
    const c = parseClaimConflict(conflictErr('{"code":"name_taken"}'));
    expect(c.reason).toBe("name_taken");
  });

  it("falls back to the legacy `reason` when no `code` is present", () => {
    const c = parseClaimConflict(
      conflictErr('{"reason":"device_already_named","current_name":"warp"}'),
    );
    expect(c.reason).toBe("already_named");
    expect(c.currentName).toBe("warp");
  });

  it("falls back to the stable already-named MESSAGE text (no code, no reason)", () => {
    const c = parseClaimConflict(
      conflictErr(
        '{"error":"device already named \\"scruceru\\" (rename not supported yet)"}',
      ),
    );
    expect(c.reason).toBe("already_named");
    // The quoted current name is recovered from the message.
    expect(c.currentName).toBe("scruceru");
  });

  it("falls back to the stable taken MESSAGE text (…is taken; try:)", () => {
    const c = parseClaimConflict(
      conflictErr('{"error":"name \\"studio\\" is taken; try: studio-2"}'),
    );
    expect(c.reason).toBe("name_taken");
  });

  it("returns reason:null for a body with no discriminator at all (fail-open)", () => {
    const c = parseClaimConflict(conflictErr('{"error":"conflict"}'));
    expect(c.reason).toBeNull();
  });

  it("returns reason:null for a non-JSON body (fail-open)", () => {
    const c = parseClaimConflict(conflictErr("{not json"));
    expect(c.reason).toBeNull();
  });

  it("ignores an unknown code value (forward-compatible fail-open)", () => {
    const c = parseClaimConflict(conflictErr('{"code":"some_future_code"}'));
    expect(c.reason).toBeNull();
  });
});
