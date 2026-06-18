import { describe, it, expect, vi, beforeEach } from "vitest";
import * as forge from "node-forge";

import {
  createTlsIssuanceService,
  CHALLENGE_PREFIX,
  type TlsIssuanceDeps,
  type HqIssuanceClient,
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
  it("skips entirely (no HQ calls, no throw) when no fqdn is configured yet", async () => {
    const hq = makeHqClient();
    const deps = makeDeps({ fqdn: "", hq });
    const svc = createTlsIssuanceService(deps);

    await expect(svc.runOnce()).resolves.not.toThrow();
    expect(hq.challenge).not.toHaveBeenCalled();
  });
});
