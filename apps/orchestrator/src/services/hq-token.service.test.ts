/**
 * WARP-3503 — the box's one HQ device-token client (fleet contract v1 §2).
 * Fake fetch + fake device identity: nothing here touches a network, gRPC or
 * a real HQ.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createHqTokenService,
  HqTokenError,
  HQ_TOKEN_SIGNED_PREFIX,
  type HqTokenFailure,
} from "./hq-token.service.js";

// A throwaway self-signed EC P-256 cert. EXPECTED_FP is the SHA-256 of its DER
// SubjectPublicKeyInfo, lowercase hex, computed OUTSIDE this code with
//   openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBcjCCARigAwIBAgIUDQmVdpxm7gi8G+1wn5vecQj4qScwCgYIKoZIzj0EAwIw
HjEcMBoGA1UEAwwTZHJvcGxldC10ZXN0LWRldmljZTAgFw0yNjEwMDMxOTEzNTRa
GA8yMTI2MDkwOTE5MTM1NFowHjEcMBoGA1UEAwwTZHJvcGxldC10ZXN0LWRldmlj
ZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABJaDdxqeXxE2GF1gC1Y4FDF3Y35G
FEx6HL5+DlRJFfRzoi1zdGo3DCrtfs+uABwASxlY528zrjl6j1n5q5vYkFOjMjAw
MB0GA1UdDgQWBBTxDhulZRx9Rcoi1x3vHBekFOML0zAPBgNVHRMBAf8EBTADAQH/
MAoGCCqGSM49BAMCA0gAMEUCIG4pIi2wJMQDqjS+Zi7pV0JpZKxPnm8kbdIlR+wk
0R/LAiEAhVEp5kk9Jo2+fSfdsQAFJUmackGKG5Vds/QLuxicOko=
-----END CERTIFICATE-----
`;
const EXPECTED_FP = "04492b52e9cde4ee60828a42a06e3ac5c01575c92b8f20a48c094ea435b626ba";

const BASE = "https://hq.example";
const NONCE = "bm9uY2Utbm9uY2Utbm9uY2Utbm9uY2Utbm9uY2Utbm9uY2U";
const JWT = "eyJhbGciOiJFUzI1NiIsImtpZCI6ImsxIn0.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
const SIG = new Uint8Array([0x30, 0x44, 0x02, 0x20, 1, 2, 3]);

type Reply = { status?: number; body?: unknown } | Error;

/** A fetch fake answering challenge then token from the given replies. */
function makeFetch(challenge: Reply, token?: Reply) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    const reply = url.endsWith("/v1/device/challenge") ? challenge : token;
    if (reply === undefined) throw new Error(`unexpected call to ${url}`);
    if (reply instanceof Error) throw reply;
    const body = reply.body === undefined ? "" : JSON.stringify(reply.body);
    return new Response(body, { status: reply.status ?? 200 });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const OK_CHALLENGE: Reply = { body: { nonce: NONCE, expires_at: "2026-10-03T12:01:00Z" } };
const okToken = (extra: Record<string, unknown> = {}): Reply => ({
  body: { token: JWT, token_type: "Bearer", expires_in: 600, scope: "registry:pull", ...extra },
});

function makeIdentity() {
  return {
    getDeviceCert: vi.fn(async () => CERT_PEM),
    signWithDeviceKey: vi.fn(async (_payload: Uint8Array) => ({ signature: SIG, algorithm: "ecdsa" })),
  };
}

function service(fetchFn: typeof fetch, opts: { now?: () => number; baseUrl?: string } = {}) {
  const identity = makeIdentity();
  const svc = createHqTokenService({
    baseUrl: opts.baseUrl ?? BASE,
    identity,
    fetch: fetchFn,
    now: opts.now,
  });
  return { svc, identity };
}

async function failure(p: Promise<unknown>): Promise<HqTokenError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HqTokenError);
    return err as HqTokenError;
  }
  throw new Error("expected the token request to fail");
}

describe("createHqTokenService — happy path", () => {
  it("challenges, signs droplet-hq-token:v1:<nonce>:<spki fingerprint>, and returns the token", async () => {
    const { fn, calls } = makeFetch(OK_CHALLENGE, okToken());
    const { svc, identity } = service(fn, { now: () => 1_000_000 });

    const got = await svc.getToken(["registry:pull"]);

    expect(got).toEqual({ token: JWT, expiresAt: 1_000_000 + 600_000 });
    expect(calls.map((c) => c.url)).toEqual([`${BASE}/v1/device/challenge`, `${BASE}/v1/device/token`]);
    // The fingerprint is the SPKI hash, lowercase hex, no "sha256:" prefix.
    expect(calls[0]!.body).toEqual({ key_fingerprint: EXPECTED_FP });
    const signed = new TextDecoder().decode(identity.signWithDeviceKey.mock.calls[0]![0]);
    expect(signed).toBe(`${HQ_TOKEN_SIGNED_PREFIX}${NONCE}:${EXPECTED_FP}`);
    expect(signed).toBe(`droplet-hq-token:v1:${NONCE}:${EXPECTED_FP}`);
    expect(calls[1]!.body).toEqual({
      key_fingerprint: EXPECTED_FP,
      nonce: NONCE,
      sig_alg: "ecdsa-p256-sha256",
      signature: Buffer.from(SIG).toString("base64"),
      scopes: ["registry:pull"],
    });
  });

  it("strips a trailing slash from the base URL and exposes the origin host", async () => {
    const { fn, calls } = makeFetch(OK_CHALLENGE, okToken());
    const { svc } = service(fn, { baseUrl: "https://HQ.Example:8443/" });
    expect(svc.host).toBe("hq.example:8443");
    await svc.getToken(["registry:pull"]);
    expect(calls[0]!.url).toBe("https://HQ.Example:8443/v1/device/challenge");
  });

  it("a malformed base URL gives an empty host (matches no image ref) instead of throwing", () => {
    const { svc } = service(makeFetch(OK_CHALLENGE).fn, { baseUrl: "not a url" });
    expect(svc.host).toBe("");
  });
});

describe("createHqTokenService — caching", () => {
  it("reuses a token until 60 s before expiry, then mints a new one", async () => {
    let now = 0;
    const { fn } = makeFetch(OK_CHALLENGE, okToken());
    const { svc } = service(fn, { now: () => now });

    await svc.getToken(["registry:pull"]);
    now = 539_000; // 61 s left
    await svc.getToken(["registry:pull"]);
    expect(fn).toHaveBeenCalledTimes(2); // one mint = challenge + token

    now = 541_000; // 59 s left
    await svc.getToken(["registry:pull"]);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("minRemainingMs makes a cached token too old for a long operation", async () => {
    let now = 0;
    const { fn } = makeFetch(OK_CHALLENGE, okToken());
    const { svc } = service(fn, { now: () => now });

    await svc.getToken(["registry:pull"], { minRemainingMs: 300_000 });
    now = 200_000; // 400 s left
    await svc.getToken(["registry:pull"], { minRemainingMs: 300_000 });
    expect(fn).toHaveBeenCalledTimes(2);

    now = 350_000; // 250 s left: under the caller's floor
    await svc.getToken(["registry:pull"], { minRemainingMs: 300_000 });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("caches per scope set, whatever the order or repeats", async () => {
    const { fn, calls } = makeFetch(OK_CHALLENGE, okToken());
    const { svc } = service(fn);

    await svc.getToken(["telemetry:ingest", "registry:pull"]);
    await svc.getToken(["registry:pull", "telemetry:ingest", "registry:pull"]);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls[1]!.body.scopes).toEqual(["registry:pull", "telemetry:ingest"]);

    await svc.getToken(["registry:pull"]);
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("does not cache a failure", async () => {
    const { fn } = makeFetch({ status: 503, body: { error: "token_service_not_configured" } });
    const { svc } = service(fn);
    await failure(svc.getToken(["registry:pull"]));
    await failure(svc.getToken(["registry:pull"]));
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("createHqTokenService — HQ refusals", () => {
  const refusals: Array<[string, Reply, Reply | undefined, HqTokenFailure]> = [
    ["token: 403 not_enrolled", OK_CHALLENGE, { status: 403, body: { error: "not_enrolled" } }, "not_enrolled"],
    ["token: 403 revoked", OK_CHALLENGE, { status: 403, body: { error: "revoked" } }, "revoked"],
    ["token: 401 bad_signature", OK_CHALLENGE, { status: 401, body: { error: "bad_signature" } }, "bad_signature"],
    ["challenge: 403 not_enrolled", { status: 403, body: { error: "not_enrolled" } }, undefined, "not_enrolled"],
    ["challenge: 403 revoked", { status: 403, body: { error: "revoked" } }, undefined, "revoked"],
  ];

  it.each(refusals)("%s → %s", async (_label, challenge, token, reason) => {
    const { fn, calls } = makeFetch(challenge, token);
    const { svc } = service(fn);

    const err = await failure(svc.getToken(["registry:pull"]));

    expect(err.reason).toBe(reason);
    // A refusal at the challenge never reaches the token endpoint.
    if (token === undefined) expect(calls).toHaveLength(1);
  });
});

describe("createHqTokenService — unreachable (no definitive answer, retry later)", () => {
  const cases: Array<[string, Reply, Reply | undefined]> = [
    ["network error", new Error("connect ECONNREFUSED"), undefined],
    ["challenge 429 rate_limited", { status: 429, body: { error: "rate_limited" } }, undefined],
    ["challenge 503 not configured", { status: 503, body: { error: "token_service_not_configured" } }, undefined],
    ["challenge 500 with a non-JSON body", { status: 500 }, undefined],
    ["challenge reply without a nonce", { body: {} }, undefined],
    ["token 401 bad_nonce", OK_CHALLENGE, { status: 401, body: { error: "bad_nonce" } }],
    ["token 400 unknown_scope", OK_CHALLENGE, { status: 400, body: { error: "unknown_scope" } }],
    ["token 500", OK_CHALLENGE, { status: 500, body: { error: "internal" } }],
    ["token reply without expires_in", OK_CHALLENGE, { body: { token: JWT } }],
    ["token reply with an empty token", OK_CHALLENGE, { body: { token: "", expires_in: 600 } }],
    ["token request times out", OK_CHALLENGE, Object.assign(new Error("The operation timed out"), { name: "TimeoutError" })],
  ];

  it.each(cases)("%s → unreachable", async (_label, challenge, token) => {
    const { fn } = makeFetch(challenge, token);
    const { svc } = service(fn);
    expect((await failure(svc.getToken(["registry:pull"]))).reason).toBe("unreachable");
  });

  it("a failing device-identity sidecar is unreachable and HQ is never called", async () => {
    const { fn } = makeFetch(OK_CHALLENGE, okToken());
    const { svc, identity } = service(fn);
    identity.getDeviceCert.mockRejectedValueOnce(new Error("sidecar down"));
    const err = await failure(svc.getToken(["registry:pull"]));
    expect(err.reason).toBe("unreachable");
    expect(err.detail).toContain("device identity");
    expect(fn).not.toHaveBeenCalled();

    identity.signWithDeviceKey.mockRejectedValueOnce(new Error("tpm wedged"));
    expect((await failure(svc.getToken(["registry:pull"]))).reason).toBe("unreachable");
  });

  it("a 429 and a 5xx are retryable: the next call mints normally", async () => {
    let n = 0;
    const calls: string[] = [];
    const fn = (async (input: string | URL | Request) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/challenge")) {
        n += 1;
        return n === 1
          ? new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 })
          : new Response(JSON.stringify({ nonce: NONCE }), { status: 200 });
      }
      return new Response(JSON.stringify({ token: JWT, expires_in: 600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const { svc } = service(fn);

    expect((await failure(svc.getToken(["registry:pull"]))).reason).toBe("unreachable");
    await expect(svc.getToken(["registry:pull"])).resolves.toMatchObject({ token: JWT });
  });
});

describe("createHqTokenService — the token never leaks", () => {
  it("no error message or detail carries the token, even for a malformed reply that contained it", async () => {
    const { fn } = makeFetch(OK_CHALLENGE, { body: { token: JWT, token_type: "Bearer" } });
    const { svc } = service(fn);
    const err = await failure(svc.getToken(["registry:pull"]));
    expect(err.message).not.toContain(JWT);
    expect(err.detail).not.toContain(JWT);
    expect(JSON.stringify(err)).not.toContain(JWT);
  });

  it("logs nothing at all", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { fn } = makeFetch(OK_CHALLENGE, okToken());
    await service(fn).svc.getToken(["registry:pull"]);
    for (const s of spies) {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    }
  });
});
