import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFleetRegistrationClient } from "./fleet-registration.service.js";
import { config } from "../config.js";

describe("createFleetRegistrationClient.deregister", () => {
  const realFetch = globalThis.fetch;
  const realHqUrl = config.HQ_ISSUANCE_URL;
  beforeEach(() => {
    // config is a plain object — override the base URL so hqFetch can build it.
    (config as { HQ_ISSUANCE_URL: string }).HQ_ISSUANCE_URL =
      "https://hq.example.test/";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (config as { HQ_ISSUANCE_URL: string }).HQ_ISSUANCE_URL = realHqUrl;
  });

  it("DELETEs /api/issuance/registration with device_id in BOTH query and body + the PoP body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ device_id: "droplet-test-01", status: "revoked" }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;

    const client = createFleetRegistrationClient();
    const res = await client.deregister({
      device_id: "droplet-test-01",
      nonce: "nonce-xyz",
      signature: "c2ln",
      sig_alg: "ecdsa-sha256",
      key_fingerprint: "sha256:deadbeef",
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    // Trailing slash on the base URL is stripped; the path is exact.
    expect(url).toBe(
      "https://hq.example.test/api/issuance/registration?device_id=droplet-test-01",
    );
    expect(init.method).toBe("DELETE");
    // device_id present in BOTH the query string AND the JSON body.
    expect(url).toContain("device_id=droplet-test-01");
    const body = JSON.parse(init.body as string);
    expect(body.device_id).toBe("droplet-test-01");
    expect(body.nonce).toBe("nonce-xyz");
    expect(body.signature).toBe("c2ln");
    expect(body.sig_alg).toBe("ecdsa-sha256");
    expect(body.key_fingerprint).toBe("sha256:deadbeef");
    expect(res.status).toBe("revoked");
  });
});

// ---------------------------------------------------------------------------
// WARP-983 — HQ provision adapter (POST /api/issuance/provision).
//
// The box self-enrolls into the HQ registry with a one-time token + a TPM PoP.
// Pin the exact HTTP shape (path + method + body fields) and confirm a non-2xx
// surfaces the `HQ … returned <status>: <body>` error the service classifies —
// this is the SAME error string the service's isNotInRegistryError detector and
// the transient-error classifier key off, so a wire regression is caught here.
// ---------------------------------------------------------------------------
describe("createFleetRegistrationClient.provision", () => {
  const realFetch = globalThis.fetch;
  const realHqUrl = config.HQ_ISSUANCE_URL;
  beforeEach(() => {
    (config as { HQ_ISSUANCE_URL: string }).HQ_ISSUANCE_URL =
      "https://hq.example.test/";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (config as { HQ_ISSUANCE_URL: string }).HQ_ISSUANCE_URL = realHqUrl;
  });

  it("POSTs /api/issuance/provision with the full provision body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_id: "droplet-test-01",
          status: "registered",
          idempotent: false,
        }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;

    const client = createFleetRegistrationClient();
    const res = await client.provision({
      device_id: "droplet-test-01",
      public_key_pem: "-----BEGIN PUBLIC KEY-----\nMFk\n-----END PUBLIC KEY-----\n",
      key_fingerprint: "sha256:deadbeef",
      token: "prov-token-abcdef0123456789",
      signature: "c2ln",
      sig_alg: "ecdsa-sha256",
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe("https://hq.example.test/api/issuance/provision");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.device_id).toBe("droplet-test-01");
    expect(body.public_key_pem).toContain("BEGIN PUBLIC KEY");
    expect(body.key_fingerprint).toBe("sha256:deadbeef");
    expect(body.token).toBe("prov-token-abcdef0123456789");
    expect(body.signature).toBe("c2ln");
    expect(body.sig_alg).toBe("ecdsa-sha256");
    expect(res.status).toBe("registered");
    expect(res.idempotent).toBe(false);
  });

  it("surfaces a non-2xx as `HQ … returned <status>: <body>` (fail-safe classification)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => '{"error":"provisioning token expired"}',
    })) as unknown as typeof fetch;

    const client = createFleetRegistrationClient();
    await expect(
      client.provision({
        device_id: "droplet-test-01",
        public_key_pem: "pk",
        key_fingerprint: "sha256:deadbeef",
        token: "expired",
        signature: "c2ln",
        sig_alg: "ecdsa-sha256",
      }),
    ).rejects.toThrow(/HQ \/api\/issuance\/provision returned 401/);
  });
});

// ---------------------------------------------------------------------------
// Factory reset releases the old fleet name and certificate while retaining
// the registry identity used for private OTA pulls and telemetry.
// ---------------------------------------------------------------------------
describe("createFleetRegistrationClient.release", () => {
  const realFetch = globalThis.fetch;
  const realHqUrl = config.HQ_ISSUANCE_URL;
  beforeEach(() => {
    (config as { HQ_ISSUANCE_URL: string }).HQ_ISSUANCE_URL =
      "https://hq.example.test/";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    (config as { HQ_ISSUANCE_URL: string }).HQ_ISSUANCE_URL = realHqUrl;
  });

  it("POSTs /api/issuance/release with device_id in the QUERY and a PoP-only body", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ device_id: "droplet-test-01", status: "released" }),
        text: async () => "",
      } as Response;
    }) as unknown as typeof fetch;

    const client = createFleetRegistrationClient();
    const res = await client.release("droplet-test-01", {
      nonce: "nonce-xyz",
      signature: "c2ln",
      sig_alg: "ecdsa-sha256",
      key_fingerprint: "sha256:deadbeef",
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe(
      "https://hq.example.test/api/issuance/release?device_id=droplet-test-01",
    );
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    // device_id is ONLY in the query string, never the body.
    expect(body).not.toHaveProperty("device_id");
    expect(body.nonce).toBe("nonce-xyz");
    expect(body.signature).toBe("c2ln");
    expect(body.sig_alg).toBe("ecdsa-sha256");
    expect(body.key_fingerprint).toBe("sha256:deadbeef");
    expect(res.status).toBe("released");
  });

  it("surfaces a non-2xx as `HQ … returned <status>: <body>` (fail-safe)", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "down",
    })) as unknown as typeof fetch;

    const client = createFleetRegistrationClient();
    await expect(
      client.release("droplet-test-01", {
        nonce: "n",
        signature: "c2ln",
        sig_alg: "ecdsa-sha256",
        key_fingerprint: "sha256:deadbeef",
      }),
      // The path in the error carries the query string; the status follows it.
    ).rejects.toThrow(/HQ \/api\/issuance\/release\?device_id=\S+ returned 503/);
  });
});
