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
    deregister: vi.fn(async () => ({
      device_id: DEVICE_ID,
      status: "revoked" as const,
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
