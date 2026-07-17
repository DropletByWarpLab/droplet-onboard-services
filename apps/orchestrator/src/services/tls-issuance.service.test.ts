import { describe, it, expect, vi, beforeEach } from "vitest";
import * as forge from "node-forge";

import {
  createTlsIssuanceService,
  CHALLENGE_PREFIX,
  buildProvisionMessage,
  type TlsIssuanceDeps,
  type HqIssuanceClient,
  type HqProvisionRequest,
  type TlsCertStore,
  type TlsFileOps,
} from "./tls-issuance.service.js";

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const FQDN = "d-abc123def456.devices.warp-lab.ai";
const DEVICE_ID = "droplet-test-01";
const KEY_FINGERPRINT = "sha256:deadbeef";
const NONCE = "nonce-xyz";
const PROVISION_TOKEN = "prov-token-abcdef0123456789";

/**
 * A device-identity X.509 cert (PEM) plus the SubjectPublicKeyInfo PEM the
 * service must extract from it for the HQ provision `public_key_pem`. The real
 * TPM identity key is EC P-256, but the box-side extraction is key-type-agnostic
 * (it lifts the SPKI straight out of the cert with node-forge), so an RSA cert
 * exercises the exact code path deterministically. Cached per-module so every
 * `makeDeviceIdentity()` returns a stable cert/SPKI pair (tests assert the
 * extracted PEM is forwarded verbatim).
 */
let _deviceCert: { certPem: string; spkiPem: string } | null = null;
function makeDeviceCertPem(): { certPem: string; spkiPem: string } {
  if (_deviceCert) return _deviceCert;
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "03";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 3650 * 86_400_000);
  const attrs = [{ name: "commonName", value: "Droplet Device Identity" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  _deviceCert = {
    certPem: forge.pki.certificateToPem(cert),
    spkiPem: forge.pki.publicKeyToPem(keys.publicKey),
  };
  return _deviceCert;
}

/** A deterministic 90-day-out timestamp. */
function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** Self-signed bootstrap cert we pretend is already installed on disk. */
function makeSelfSignedPem(notAfterDays = 3650): string {
  const keys = forge.pki.rsa.generateKeyPair(512); // small + fast for tests
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + notAfterDays * 86_400_000);
  const attrs = [{ name: "commonName", value: "Droplet Edge Device" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs); // self-signed
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

/** An LE-style leaf cert with a controllable notAfter, used to fake fullchain. */
function makeLeafPem(notAfterDays: number): string {
  const keys = forge.pki.rsa.generateKeyPair(512);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + notAfterDays * 86_400_000);
  cert.setSubject([{ name: "commonName", value: FQDN }]);
  cert.setIssuer([{ name: "commonName", value: "Fake LE Intermediate" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(cert);
}

function makeFileOps(initial?: { cert?: string; key?: string }): TlsFileOps & {
  writes: Array<{ path: string; data: string; mode: number }>;
} {
  const store = new Map<string, string>();
  if (initial?.cert) store.set("droplet.crt", initial.cert);
  if (initial?.key) store.set("droplet.key", initial.key);
  const writes: Array<{ path: string; data: string; mode: number }> = [];
  return {
    writes,
    async readCert() {
      return store.get("droplet.crt") ?? null;
    },
    async writeAtomic(name, data, mode) {
      store.set(name, data);
      writes.push({ path: name, data, mode });
    },
  };
}

function makeStore(initial?: {
  fqdn?: string;
  state?: string;
  notAfter?: string | null;
}): TlsCertStore & { rows: Map<string, { state: string; notAfter: string | null }> } {
  const rows = new Map<string, { state: string; notAfter: string | null }>();
  if (initial?.fqdn) {
    rows.set(initial.fqdn, {
      state: initial.state ?? "BOOTSTRAP_SELF_SIGNED",
      notAfter: initial.notAfter ?? null,
    });
  }
  return {
    rows,
    async get(fqdn) {
      const r = rows.get(fqdn);
      return r ? { fqdn, state: r.state as never, notAfter: r.notAfter } : null;
    },
    async upsert(fqdn, state, notAfter) {
      rows.set(fqdn, { state, notAfter: notAfter ?? null });
    },
  };
}

function makeHqClient(overrides: Partial<HqIssuanceClient> = {}): HqIssuanceClient {
  return {
    challenge: vi.fn(async () => ({
      nonce: NONCE,
      expires_at: daysFromNow(1),
      public_label: "d-abc123def456",
      fqdn: FQDN,
    })),
    order: vi.fn(async () => ({
      order_id: "ord-1",
      status: "pending" as const,
      fqdn: FQDN,
    })),
    poll: vi.fn(async () => ({
      status: "active" as const,
      fullchain_pem: makeLeafPem(90),
      not_after: daysFromNow(90),
    })),
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

/** An HQ client whose challenge (and order/renew) 404s with the exact
 *  not-in-registry body, until `registered` flips true after a provision. Mirrors
 *  the live HQ behaviour: a deregistered device 404s on challenge; once the box
 *  re-provisions, the retry succeeds. */
function makeNotInRegistryHqClient(): HqIssuanceClient & { registered: boolean } {
  const notInRegistry = () => {
    // Exactly what hqFetch throws for the deployed HQ 404 (adapters.ts):
    //   `HQ <path> returned <status>: <body.slice(0,200)>`
    throw new Error(
      'HQ /api/issuance/order/challenge returned 404: {"error":"device_id not in registry"}',
    );
  };
  const base = makeHqClient();
  const client = {
    ...base,
    registered: false,
    challenge: vi.fn(async (deviceId: string) => {
      if (!client.registered) return notInRegistry();
      return {
        nonce: NONCE,
        expires_at: daysFromNow(1),
        public_label: "d-abc123def456",
        fqdn: FQDN,
      };
    }),
    provision: vi.fn(async (_req: HqProvisionRequest) => {
      client.registered = true;
      return {
        device_id: DEVICE_ID,
        status: "registered" as const,
        idempotent: false,
      };
    }),
  } as unknown as HqIssuanceClient & { registered: boolean };
  return client;
}

function makeDeviceIdentity() {
  const { certPem } = makeDeviceCertPem();
  return {
    signWithDeviceKey: vi.fn(async () => ({
      signature: new Uint8Array([1, 2, 3, 4]),
      algorithm: "ecdsa-sha256",
    })),
    getDeviceCert: vi.fn(async () => certPem),
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

function makeDeps(over: Partial<TlsIssuanceDeps> = {}): TlsIssuanceDeps {
  return {
    fqdn: FQDN,
    deviceId: DEVICE_ID,
    hq: makeHqClient(),
    identity: makeDeviceIdentity() as unknown as TlsIssuanceDeps["identity"],
    store: makeStore(),
    files: makeFileOps({ cert: makeSelfSignedPem(), key: "BOOTSTRAP-KEY" }),
    reloadNginx: vi.fn(async () => {}),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tls-issuance.service — CSR generation", () => {
  it("generates a CSR whose ONLY SAN is the fqdn and never returns the private key off-box", async () => {
    const files = makeFileOps({ cert: makeSelfSignedPem(), key: "x" });
    const hq = makeHqClient();
    const deps = makeDeps({ files, hq });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    // The CSR handed to HQ must carry exactly one SAN == fqdn.
    const orderCall = (hq.order as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const csr = forge.pki.certificationRequestFromPem(orderCall.csr_pem);
    const extReq = csr.getAttribute({ name: "extensionRequest" });
    const sanExt = extReq?.extensions?.find(
      (e: { name: string }) => e.name === "subjectAltName",
    );
    const altNames = sanExt?.altNames ?? [];
    expect(altNames).toHaveLength(1);
    expect(altNames[0].value).toBe(FQDN);

    // The private key is written to disk but NEVER appears in any HQ payload.
    expect(orderCall).not.toHaveProperty("private_key");
    expect(orderCall).not.toHaveProperty("key_pem");
    const serialized = JSON.stringify(orderCall);
    expect(serialized).not.toContain("PRIVATE KEY");
  });
});

describe("tls-issuance.service — challenge signing", () => {
  it("signs the exact contract string and includes the signature + alg + fingerprint in the order", async () => {
    const identity = makeDeviceIdentity();
    const hq = makeHqClient();
    const deps = makeDeps({
      identity: identity as unknown as TlsIssuanceDeps["identity"],
      hq,
    });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    // Signed payload == droplet-cert:v1:<nonce>:<key_fingerprint>:<public_label>
    const signedBytes = (identity.signWithDeviceKey as ReturnType<typeof vi.fn>)
      .mock.calls[0][0] as Uint8Array;
    const signedStr = Buffer.from(signedBytes).toString("utf8");
    expect(signedStr).toBe(
      `${CHALLENGE_PREFIX}${NONCE}:${KEY_FINGERPRINT}:d-abc123def456`,
    );

    const orderCall = (hq.order as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(orderCall.sig_alg).toBe("ecdsa-sha256");
    expect(orderCall.key_fingerprint).toBe(KEY_FINGERPRINT);
    expect(typeof orderCall.signature).toBe("string");
    expect(orderCall.signature.length).toBeGreaterThan(0);
    expect(orderCall.nonce).toBe(NONCE);
    expect(orderCall.device_id).toBe(DEVICE_ID);
  });
});

describe("tls-issuance.service — atomic install + reload", () => {
  it("installs the LE fullchain into droplet.crt (644) and the key into droplet.key (600), then reloads nginx", async () => {
    const files = makeFileOps({ cert: makeSelfSignedPem(), key: "x" });
    const reloadNginx = vi.fn(async () => {});
    const deps = makeDeps({ files, reloadNginx });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    const certWrite = files.writes.find((w) => w.path === "droplet.crt");
    const keyWrite = files.writes.find((w) => w.path === "droplet.key");
    expect(certWrite).toBeDefined();
    expect(keyWrite).toBeDefined();
    // LE fullchain goes into droplet.crt (so nginx needs no config change).
    expect(certWrite!.data).toContain("BEGIN CERTIFICATE");
    expect(certWrite!.mode).toBe(0o644);
    // The locally-generated private key goes into droplet.key, 0600.
    expect(keyWrite!.data).toContain("PRIVATE KEY");
    expect(keyWrite!.mode).toBe(0o600);
    // Reload happens after the install.
    expect(reloadNginx).toHaveBeenCalledTimes(1);
  });
});

describe("tls-issuance.service — state machine", () => {
  it("BOOTSTRAP_SELF_SIGNED → issues now → LE_ISSUED", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const deps = makeDeps({ store });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    const row = await store.get(FQDN);
    expect(row?.state).toBe("LE_ISSUED");
    expect(row?.notAfter).toBeTruthy();
  });

  it("creates a BOOTSTRAP_SELF_SIGNED row and issues when no row exists yet (never infers from IS NULL)", async () => {
    const store = makeStore(); // empty
    const hq = makeHqClient();
    const deps = makeDeps({ store, hq });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    expect(hq.order).toHaveBeenCalledTimes(1);
    expect((await store.get(FQDN))?.state).toBe("LE_ISSUED");
  });

  it("LE_ISSUED with >30d left does NOT renew", async () => {
    const store = makeStore({
      fqdn: FQDN,
      state: "LE_ISSUED",
      notAfter: daysFromNow(45),
    });
    const hq = makeHqClient();
    const deps = makeDeps({ store, hq });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    expect(hq.order).not.toHaveBeenCalled();
    expect(hq.renew).not.toHaveBeenCalled();
    expect((await store.get(FQDN))?.state).toBe("LE_ISSUED");
  });

  it("LE_ISSUED with <=30d left renews (renew threshold)", async () => {
    const store = makeStore({
      fqdn: FQDN,
      state: "LE_ISSUED",
      notAfter: daysFromNow(20),
    });
    const hq = makeHqClient();
    const deps = makeDeps({ store, hq });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    expect(hq.renew).toHaveBeenCalledTimes(1);
    expect(hq.order).not.toHaveBeenCalled();
    expect((await store.get(FQDN))?.state).toBe("LE_ISSUED");
  });

  it("exactly 30d left renews (boundary is inclusive)", async () => {
    const store = makeStore({
      fqdn: FQDN,
      state: "LE_ISSUED",
      notAfter: daysFromNow(30),
    });
    const hq = makeHqClient();
    const deps = makeDeps({ store, hq });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    expect(hq.renew).toHaveBeenCalledTimes(1);
  });
});

describe("tls-issuance.service — requested_name (WARP-979)", () => {
  async function orderBodyForName(
    requestedName: string | undefined,
  ): Promise<Record<string, unknown>> {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeHqClient();
    const svc = createTlsIssuanceService(makeDeps({ store, hq, requestedName }));
    await svc.runOnce();
    expect(hq.order).toHaveBeenCalledTimes(1);
    return (hq.order as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
  }

  it("sends the owner-chosen name as requested_name when it is valid", async () => {
    expect(await orderBodyForName("studio")).toHaveProperty(
      "requested_name",
      "studio",
    );
  });

  it("normalizes (trim + lowercase) before sending requested_name", async () => {
    expect(await orderBodyForName("  Studio  ")).toHaveProperty(
      "requested_name",
      "studio",
    );
  });

  it("omits requested_name when no name is configured (opaque d-<hmac> fallback)", async () => {
    expect(await orderBodyForName(undefined)).not.toHaveProperty("requested_name");
  });

  it("omits requested_name when DROPLET_BOX_NAME is set but invalid — defense-in-depth against a hand-edited .env — and warns", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeHqClient();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const svc = createTlsIssuanceService(
      // `bad_name` fails the charset gate (underscore) → invalid → omitted.
      makeDeps({ store, hq, requestedName: "bad_name", logger }),
    );

    await svc.runOnce();

    const body = (hq.order as ReturnType<typeof vi.fn>).mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("requested_name");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("carries requested_name on the RENEW path too", async () => {
    const store = makeStore({
      fqdn: FQDN,
      state: "LE_ISSUED",
      notAfter: daysFromNow(20),
    });
    const hq = makeHqClient();
    const svc = createTlsIssuanceService(
      makeDeps({ store, hq, requestedName: "studio" }),
    );

    await svc.runOnce();

    expect(hq.renew).toHaveBeenCalledTimes(1);
    expect(
      (hq.renew as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toHaveProperty("requested_name", "studio");
  });
});

describe("tls-issuance.service — deferred name claim on the tick (WARP-980 follow-up)", () => {
  it("claims a persisted-but-unclaimed name BEFORE ordering, so HQ honors requested_name on this very order", async () => {
    // Seed fqdn is the opaque d-<hmac> name while DROPLET_BOX_NAME is set —
    // the exact state of a box whose wizard-time claim fell back (HQ
    // unreachable / not yet registered).
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeHqClient();
    const svc = createTlsIssuanceService(
      makeDeps({ store, hq, requestedName: "studio", hqConfigured: true }),
    );

    await svc.runOnce();

    expect(hq.claimName).toHaveBeenCalledTimes(1);
    expect(
      (hq.claimName as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toMatchObject({ name: "studio" });
    // The claim happened before the order was placed.
    const claimOrder = (hq.claimName as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    const orderOrder = (hq.order as ReturnType<typeof vi.fn>).mock
      .invocationCallOrder[0];
    expect(claimOrder).toBeLessThan(orderOrder);
    expect(
      (hq.order as ReturnType<typeof vi.fn>).mock.calls[0][0],
    ).toHaveProperty("requested_name", "studio");
  });

  it("does NOT claim when the seed fqdn already IS the chosen name (claim confirmed on an earlier tick/rename)", async () => {
    const namedFqdn = "studio.droplet-us.com";
    const store = makeStore({ fqdn: namedFqdn, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeHqClient();
    const svc = createTlsIssuanceService(
      makeDeps({
        fqdn: namedFqdn,
        store,
        hq,
        requestedName: "studio",
        hqConfigured: true,
      }),
    );

    await svc.runOnce();

    expect(hq.claimName).not.toHaveBeenCalled();
    expect(hq.order).toHaveBeenCalledTimes(1);
  });

  it("does NOT claim when no name is configured", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeHqClient();
    const svc = createTlsIssuanceService(
      makeDeps({ store, hq, hqConfigured: true }),
    );

    await svc.runOnce();

    expect(hq.claimName).not.toHaveBeenCalled();
  });

  it("a failed claim is NON-FATAL — warns and proceeds with the (opaque) issuance", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeHqClient({
      claimName: vi.fn(async () => {
        // Exactly what hqFetch throws for the deployed HQ 409 (adapters.ts).
        throw new Error(
          'HQ /api/issuance/claim-name returned 409: {"error":"name taken"}',
        );
      }),
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const svc = createTlsIssuanceService(
      makeDeps({
        store,
        hq,
        requestedName: "studio",
        logger,
        hqConfigured: true,
      }),
    );

    await svc.runOnce();

    expect(hq.claimName).toHaveBeenCalledTimes(1);
    // Issuance still ran to completion (opaque fallback).
    expect(hq.order).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ name: "studio" }),
      expect.stringContaining("deferred name claim did not confirm"),
    );
  });

  it("attempts the claim at most once per tick — the self-provision retry does not re-drive it", async () => {
    const hq = makeNotInRegistryHqClient();
    const store = makeStore();
    const svc = createTlsIssuanceService(
      makeDeps({
        fqdn: FQDN,
        store,
        hq,
        requestedName: "studio",
        provisionToken: "tok-1",
        hqConfigured: true,
      }),
    );

    await svc.runOnce();

    // Three challenge fetches: the claim attempt (404s while unregistered —
    // non-fatal, claim marked attempted), issueOrRenew's own (404 → triggers
    // self-provision), and the successful retry. The retry does NOT re-enter
    // the claim (at-most-once per tick), so claimName is never reached this
    // tick — the NEXT tick claims against the now-registered device.
    expect(hq.challenge).toHaveBeenCalledTimes(3);
    expect(hq.claimName).not.toHaveBeenCalled();
    expect(hq.order).toHaveBeenCalledTimes(1);
  });
});

describe("tls-issuance.service — failure handling", () => {
  it("HQ unreachable keeps the current cert, sets LE_RENEW_FAILED, logs a warning, does NOT throw", async () => {
    const store = makeStore({
      fqdn: FQDN,
      state: "LE_ISSUED",
      notAfter: daysFromNow(10),
    });
    const files = makeFileOps({ cert: makeSelfSignedPem(), key: "x" });
    const reloadNginx = vi.fn(async () => {});
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const hq = makeHqClient({
      challenge: vi.fn(async () => {
        const e = new Error("ECONNREFUSED");
        (e as { code?: string }).code = "ECONNREFUSED";
        throw e;
      }),
    });
    const deps = makeDeps({ store, files, reloadNginx, logger, hq });
    const svc = createTlsIssuanceService(deps);

    await expect(svc.runOnce()).resolves.not.toThrow();

    // Current cert untouched (no install, no reload).
    expect(files.writes).toHaveLength(0);
    expect(reloadNginx).not.toHaveBeenCalled();
    expect((await store.get(FQDN))?.state).toBe("LE_RENEW_FAILED");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("an unexpected (non-network) error propagates so the cron canary increments", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeHqClient({
      poll: vi.fn(async () => {
        throw new TypeError("boom — programming error");
      }),
    });
    const deps = makeDeps({ store, hq });
    const svc = createTlsIssuanceService(deps);

    await expect(svc.runOnce()).rejects.toThrow(/boom/);
  });

  it("a non-active poll status (e.g. 'failed') is treated as a renew failure, not a throw", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const hq = makeHqClient({
      poll: vi.fn(async () => ({ status: "failed" as const })),
    });
    const deps = makeDeps({ store, hq, logger });
    const svc = createTlsIssuanceService(deps);

    await expect(svc.runOnce()).resolves.not.toThrow();
    expect((await store.get(FQDN))?.state).toBe("LE_RENEW_FAILED");
  });
});

describe("tls-issuance.service — no-fqdn guard", () => {
  it("skips entirely (no HQ calls, no throw) when no fqdn is configured yet AND HQ is unconfigured", async () => {
    const hq = makeHqClient();
    // hqConfigured omitted (undefined) preserves the dev/CI no-op posture.
    const deps = makeDeps({ fqdn: "", hq });
    const svc = createTlsIssuanceService(deps);

    await expect(svc.runOnce()).resolves.not.toThrow();
    expect(hq.challenge).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ADR-023 PR-1 — zero-touch FQDN write-back (Gap 1)
// ---------------------------------------------------------------------------

describe("tls-issuance.service — zero-touch FQDN write-back", () => {
  it("empty-fqdn + HQ configured + provisioned → bootstrap-issues, learns the fqdn, and keys the row on the LEARNED fqdn", async () => {
    const store = makeStore(); // no row — a fresh zero-touch box
    const hq = makeHqClient();
    const persistFqdn = vi.fn(async () => {});
    const deps = makeDeps({
      fqdn: "", // box hasn't learned its name yet
      hqConfigured: true,
      store,
      hq,
      persistFqdn,
    });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    // It reached HQ and issued despite the empty seed.
    expect(hq.challenge).toHaveBeenCalledTimes(1);
    expect(hq.order).toHaveBeenCalledTimes(1);
    // NO row was keyed on '' — the upsert lands on the LEARNED fqdn only.
    expect(store.rows.has("")).toBe(false);
    expect((await store.get(FQDN))?.state).toBe("LE_ISSUED");
    // The learned name was persisted back to .env (it differs from the '' seed).
    expect(persistFqdn).toHaveBeenCalledWith(FQDN);
  });

  it("does NOT double-persist when the learned fqdn already equals the configured seed", async () => {
    const persistFqdn = vi.fn(async () => {});
    const deps = makeDeps({ fqdn: FQDN, persistFqdn });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    expect(persistFqdn).not.toHaveBeenCalled();
  });

  it("empty-fqdn + HQ unconfigured → no-op (no HQ calls, no persist) — preserves dev/CI posture", async () => {
    const hq = makeHqClient();
    const persistFqdn = vi.fn(async () => {});
    const deps = makeDeps({ fqdn: "", hqConfigured: false, hq, persistFqdn });
    const svc = createTlsIssuanceService(deps);

    await expect(svc.runOnce()).resolves.not.toThrow();
    expect(hq.challenge).not.toHaveBeenCalled();
    expect(persistFqdn).not.toHaveBeenCalled();
  });

  it("empty-fqdn + HQ configured but device UNPROVISIONED → no-op (no HQ calls)", async () => {
    const hq = makeHqClient();
    const identity = makeDeviceIdentity();
    identity.getDeviceIdentityStatus = vi.fn(async () => ({
      provisioned: false,
      backend: "mock" as const,
      certSubject: "",
      certFingerprint: "",
      certExpiresAt: null,
      sealingPcrs: [],
      sealValid: false,
      lastResealAt: null,
      currentPcrSnapshot: {},
    })) as never;
    const deps = makeDeps({
      fqdn: "",
      hqConfigured: true,
      hq,
      identity: identity as unknown as TlsIssuanceDeps["identity"],
    });
    const svc = createTlsIssuanceService(deps);

    await expect(svc.runOnce()).resolves.not.toThrow();
    expect(hq.challenge).not.toHaveBeenCalled();
  });

  it("a persistFqdn failure is swallowed and never aborts a successful issuance", async () => {
    const store = makeStore();
    const persistFqdn = vi.fn(async () => {
      throw new Error("write-back blew up");
    });
    const deps = makeDeps({ fqdn: "", hqConfigured: true, store, persistFqdn });
    const svc = createTlsIssuanceService(deps);

    // Even though persistFqdn rejects, the issuance completes cleanly.
    await expect(svc.runOnce()).resolves.not.toThrow();
    expect((await store.get(FQDN))?.state).toBe("LE_ISSUED");
    expect(persistFqdn).toHaveBeenCalledWith(FQDN);
  });

  it("a FAILURE with an empty seed does NOT upsert an empty-key row (just warns)", async () => {
    const store = makeStore();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const hq = makeHqClient({
      challenge: vi.fn(async () => {
        const e = new Error("HQ /api/issuance/order/challenge returned 503: down");
        throw e;
      }),
    });
    const deps = makeDeps({ fqdn: "", hqConfigured: true, store, hq, logger });
    const svc = createTlsIssuanceService(deps);

    await expect(svc.runOnce()).resolves.not.toThrow();
    // No '' row was ever written (TlsCert.fqdn @id must never be empty).
    expect(store.rows.has("")).toBe(false);
    expect(store.rows.size).toBe(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("issueOrRenew returns { fqdn, notAfter } — the learned name is surfaced, not discarded", async () => {
    // White-box: drive runOnce with a seeded fqdn and assert the row keys on the
    // HQ-returned ch.fqdn (which equals FQDN here) and carries a real notAfter.
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const deps = makeDeps({ store });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    const row = await store.get(FQDN);
    expect(row?.state).toBe("LE_ISSUED");
    expect(row?.notAfter).toBeTruthy();
    expect(Number.isNaN(new Date(row!.notAfter!).getTime())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ADR-023 PR-1 — split-horizon DNS registration on issuance (Gap 2)
// ---------------------------------------------------------------------------

describe("tls-issuance.service — split-horizon DNS registration", () => {
  it("registers the LEARNED ch.fqdn after a successful install (after reloadNginx)", async () => {
    const calls: string[] = [];
    const reloadNginx = vi.fn(async () => {
      calls.push("reload");
    });
    const dns = {
      register: vi.fn(async (hostname: string) => {
        calls.push(`dns:${hostname}`);
      }),
    };
    const deps = makeDeps({ reloadNginx, dns });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    expect(dns.register).toHaveBeenCalledTimes(1);
    expect(dns.register).toHaveBeenCalledWith(FQDN);
    // DNS registration happens AFTER the nginx reload.
    expect(calls).toEqual(["reload", `dns:${FQDN}`]);
  });

  it("a DNS-registration failure does NOT abort issuance (cert stays installed, no throw)", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const dns = {
      register: vi.fn(async () => {
        throw new Error("routing service down");
      }),
    };
    const deps = makeDeps({ store, dns });
    const svc = createTlsIssuanceService(deps);

    await expect(svc.runOnce()).resolves.not.toThrow();
    // The cert was still installed and the state advanced — DNS is best-effort.
    expect((await store.get(FQDN))?.state).toBe("LE_ISSUED");
  });

  it("does NOT register DNS on the no-op branch (healthy cert, nothing to install)", async () => {
    const store = makeStore({
      fqdn: FQDN,
      state: "LE_ISSUED",
      notAfter: daysFromNow(45),
    });
    const dns = { register: vi.fn(async () => {}) };
    const deps = makeDeps({ store, dns });
    const svc = createTlsIssuanceService(deps);

    await svc.runOnce();

    expect(dns.register).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// WARP-983 — box self-provision (re-enroll into the HQ registry after a
// factory-reset deregister freed the device row, then issue the cert)
// ---------------------------------------------------------------------------

describe("tls-issuance.service — self-provision (WARP-983)", () => {
  it("(e) buildProvisionMessage equals the HQ contract string", () => {
    expect(buildProvisionMessage(PROVISION_TOKEN, DEVICE_ID, KEY_FINGERPRINT)).toBe(
      `droplet-provision:v1:${PROVISION_TOKEN}:${DEVICE_ID}:${KEY_FINGERPRINT}`,
    );
  });

  it("(a) not-in-registry + token set → provisions with a correctly-built message, retries → LE_ISSUED", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeNotInRegistryHqClient();
    const identity = makeDeviceIdentity();
    const { spkiPem } = makeDeviceCertPem();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const svc = createTlsIssuanceService(
      makeDeps({
        store,
        hq,
        identity: identity as unknown as TlsIssuanceDeps["identity"],
        provisionToken: PROVISION_TOKEN,
        logger,
      }),
    );

    await svc.runOnce();

    // provision() was called exactly once with the correctly-built fields.
    expect(hq.provision).toHaveBeenCalledTimes(1);
    const req = (hq.provision as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as HqProvisionRequest;
    expect(req.device_id).toBe(DEVICE_ID);
    expect(req.token).toBe(PROVISION_TOKEN);
    expect(req.key_fingerprint).toBe(KEY_FINGERPRINT);
    expect(req.sig_alg).toBe("ecdsa-sha256");
    expect(typeof req.signature).toBe("string");
    expect(req.signature.length).toBeGreaterThan(0);
    // public_key_pem is the SPKI extracted from the device identity cert.
    expect(req.public_key_pem).toBe(spkiPem);
    expect(req.public_key_pem).toContain("BEGIN PUBLIC KEY");

    // The signed bytes are the provision PoP message, NOT the cert challenge.
    const provisionSignCall = (
      identity.signWithDeviceKey as ReturnType<typeof vi.fn>
    ).mock.calls
      .map((c) => Buffer.from(c[0] as Uint8Array).toString("utf8"))
      .find((s) => s.startsWith("droplet-provision:v1:"));
    expect(provisionSignCall).toBe(
      buildProvisionMessage(PROVISION_TOKEN, DEVICE_ID, KEY_FINGERPRINT),
    );

    // After the successful provision, the issuance retried and installed a cert.
    expect(hq.challenge).toHaveBeenCalledTimes(2); // first 404, retry succeeds
    expect((await store.get(FQDN))?.state).toBe("LE_ISSUED");
  });

  it("(b) not-in-registry + NO token → does NOT provision, stays bootstrap, warns", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeNotInRegistryHqClient();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // provisionToken omitted (undefined) → self-provision disabled.
    const svc = createTlsIssuanceService(makeDeps({ store, hq, logger }));

    await expect(svc.runOnce()).resolves.not.toThrow();

    expect(hq.provision).not.toHaveBeenCalled();
    // The box stays on the bootstrap cert: the 404 is treated as a transient HQ
    // failure (LE_RENEW_FAILED), no cert installed, and it warns.
    expect((await store.get(FQDN))?.state).toBe("LE_RENEW_FAILED");
    expect(logger.warn).toHaveBeenCalled();
    // No retry challenge — it 404'd once and gave up.
    expect(hq.challenge).toHaveBeenCalledTimes(1);
  });

  it("(c) provision fails (expired/401 token) → no crash, keeps bootstrap, no retry", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeNotInRegistryHqClient();
    // Override provision to reject like the deployed HQ 401 (invalid/expired token).
    hq.provision = vi.fn(async () => {
      throw new Error(
        'HQ /api/issuance/provision returned 401: {"error":"provisioning token expired"}',
      );
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const svc = createTlsIssuanceService(
      makeDeps({ store, hq, provisionToken: PROVISION_TOKEN, logger }),
    );

    await expect(svc.runOnce()).resolves.not.toThrow();

    expect(hq.provision).toHaveBeenCalledTimes(1);
    // provision failed → keep the bootstrap cert, record LE_RENEW_FAILED, warn.
    expect((await store.get(FQDN))?.state).toBe("LE_RENEW_FAILED");
    expect(logger.warn).toHaveBeenCalled();
    // Only the ONE (failed) challenge — provision failed so there is no retry.
    expect(hq.challenge).toHaveBeenCalledTimes(1);
  });

  it("(d) already-registered device → provision is NEVER called (happy path unchanged)", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeHqClient(); // default: challenge succeeds
    const svc = createTlsIssuanceService(
      makeDeps({ store, hq, provisionToken: PROVISION_TOKEN }),
    );

    await svc.runOnce();

    expect(hq.provision).not.toHaveBeenCalled();
    expect((await store.get(FQDN))?.state).toBe("LE_ISSUED");
  });

  it("provisions at most ONCE — a second not-in-registry after provision does NOT loop", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeNotInRegistryHqClient();
    // Sabotage: provision returns success but does NOT actually register, so the
    // retry challenge 404s again. The service must NOT provision a second time.
    hq.provision = vi.fn(async () => ({
      device_id: DEVICE_ID,
      status: "registered" as const,
      idempotent: false,
    }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const svc = createTlsIssuanceService(
      makeDeps({ store, hq, provisionToken: PROVISION_TOKEN, logger }),
    );

    await expect(svc.runOnce()).resolves.not.toThrow();

    expect(hq.provision).toHaveBeenCalledTimes(1);
    // Two challenges total: the original + the single retry (which 404s again).
    expect(hq.challenge).toHaveBeenCalledTimes(2);
    expect((await store.get(FQDN))?.state).toBe("LE_RENEW_FAILED");
  });

  it("does NOT provision on an unrelated (non-404) HQ error even with a token set", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeHqClient({
      challenge: vi.fn(async () => {
        throw new Error("HQ /api/issuance/order/challenge returned 503: down");
      }),
    });
    const svc = createTlsIssuanceService(
      makeDeps({ store, hq, provisionToken: PROVISION_TOKEN }),
    );

    await expect(svc.runOnce()).resolves.not.toThrow();
    expect(hq.provision).not.toHaveBeenCalled();
    expect((await store.get(FQDN))?.state).toBe("LE_RENEW_FAILED");
  });

  it("does NOT provision when the token is empty-string (self-provision disabled)", async () => {
    const store = makeStore({ fqdn: FQDN, state: "BOOTSTRAP_SELF_SIGNED" });
    const hq = makeNotInRegistryHqClient();
    const svc = createTlsIssuanceService(
      makeDeps({ store, hq, provisionToken: "   " }),
    );

    await expect(svc.runOnce()).resolves.not.toThrow();
    expect(hq.provision).not.toHaveBeenCalled();
    expect((await store.get(FQDN))?.state).toBe("LE_RENEW_FAILED");
  });
});
