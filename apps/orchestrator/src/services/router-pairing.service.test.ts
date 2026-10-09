/**
 * ADR-071 slice B — router pairing orchestration. Routing, the device-bridge and
 * the device identity are all faked; nothing here touches a router, a socket or
 * a disk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { DEVICE_BRIDGE_URL: "http://bridge.invalid:9090", NODE_ENV: "test" },
}));

import { createRouterPairingService, getBoxFingerprint } from "./router-pairing.service.js";
import { RouterError } from "../types/router-error.js";

// Self-signed certificate + the SHA-256 of its DER SPKI, computed with openssl:
//   openssl x509 -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBgTCCASegAwIBAgIUJy8eO7OZGTK1wU7FWh1iN05FBYkwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLZHJvcGxldC1ib3gwHhcNMjYxMDA2MjA1NTI1WhcNMzYxMDAz
MjA1NTI1WjAWMRQwEgYDVQQDDAtkcm9wbGV0LWJveDBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABOId+kNvfpQ+CW3ufAWm0a2aUMzdbHC8JN+FBgJ4OP+ZVMzXCzFZ
nrZ5QwKGoDITvyT4ZPuC3mhcKHayvMGt9SKjUzBRMB0GA1UdDgQWBBSl9RqA0emW
gI9VoaXnW68YAGTqhzAfBgNVHSMEGDAWgBSl9RqA0emWgI9VoaXnW68YAGTqhzAP
BgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIGR+g9Trxnqsi+xk2u8M
4fZMV/GbHLy3hBSLlQ2/ChxHAiEAghBUTcpHFQM8BvultphdvWgwsZuqaXTEI0W8
0kgLO+0=
-----END CERTIFICATE-----
`;
const FINGERPRINT = "08da5f6e29ab99b5657b99da02f61d2480e379252ded634aa10bfbacc370cec8";
const PASSWORD = "0123456789abcdef0123456789abcdef";
const OTHER_BOX = "cd".repeat(32);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Handler = (init: { method?: string; body?: string }) => Response | Promise<Response>;

function setup(
  routes: Record<string, Handler>,
  bridge?: (body: Record<string, unknown>) => Response | Promise<Response>,
) {
  const routingCalls: Array<{ path: string; method?: string; body?: any }> = [];
  const routingFetch = vi.fn(async (path: string, init: { method?: string; body?: string } = {}) => {
    routingCalls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const h = routes[`${init.method ?? "GET"} ${path}`];
    if (!h) throw RouterError.unreachable(`no route ${path}`);
    return h(init);
  });
  const bridgeCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    bridgeCalls.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
    return bridge ? bridge(body) : json(200, { ok: true });
  });
  const auditRows: Array<Record<string, any>> = [];
  const prisma = {
    commandAuditLog: {
      create: vi.fn(async (a: { data: Record<string, any> }) => {
        auditRows.push(a.data);
        return a.data;
      }),
    },
  };
  const svc = createRouterPairingService({
    prisma: prisma as never,
    identity: { getDeviceCert: async () => CERT_PEM },
    routingFetch: routingFetch as never,
    probeRouter: vi.fn(async () => {
      throw RouterError.auth("Credentials rejected");
    }),
    fetchImpl: fetchImpl as never,
    bridgeUrl: "http://bridge.invalid:9090",
    bridgeToken: () => "bridge-admin-token",
  });
  return { svc, routingCalls, bridgeCalls, auditRows, prisma };
}

const claimOk = (): Handler => () =>
  json(200, { ok: true, password: PASSWORD, host: "192.168.9.1", model: "RB5009", paired_at: "2026-10-06T10:00:00Z" });
const identityOk: Handler = () => json(200, { ok: true });
const persistedOk: Handler = () => json(200, { ok: true });

/** The password must be in exactly one place: the bridge request body. */
function expectNoPasswordAnywhere(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(PASSWORD);
}

describe("getBoxFingerprint", () => {
  it("is the SHA-256 of the DER SPKI, lowercase hex", async () => {
    expect(await getBoxFingerprint({ getDeviceCert: async () => CERT_PEM })).toBe(FINGERPRINT);
  });
});

describe("pair()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes identity, claims, dispatches to the bridge, marks persisted, writes ONE audit row without the password", async () => {
    const t = setup({
      "PUT /pairing/identity": identityOk,
      "POST /pairing/claim": claimOk(),
      "POST /pairing/persisted": persistedOk,
    });
    const r = await t.svc.pair("user-1");

    expect(r).toMatchObject({ ok: true, persisted: true, host: "192.168.9.1", model: "RB5009", httpStatus: 200 });
    expect(r.error).toBeUndefined();
    expectNoPasswordAnywhere(r);

    expect(t.routingCalls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /pairing/identity",
      "POST /pairing/claim",
      "POST /pairing/persisted",
    ]);
    expect(t.routingCalls[0].body).toEqual({ box_fingerprint: FINGERPRINT });
    expect(t.routingCalls[1].body).toEqual({ box_fingerprint: FINGERPRINT });

    expect(t.bridgeCalls).toHaveLength(1);
    expect(t.bridgeCalls[0].url).toBe("http://bridge.invalid:9090/host/router-pairing");
    expect(t.bridgeCalls[0].headers["X-Droplet-Auth"]).toBe("bridge-admin-token");
    expect(t.bridgeCalls[0].body).toEqual({ target: "router", password: PASSWORD });

    expect(t.auditRows).toHaveLength(1);
    expect(t.auditRows[0]).toMatchObject({
      userId: "user-1",
      domain: "network",
      service: "router-pairing",
      confirmed: true,
      blocked: false,
      reason: null,
      data: { host: "192.168.9.1", model: "RB5009", box_fingerprint: FINGERPRINT, paired_at: "2026-10-06T10:00:00Z" },
    });
    expectNoPasswordAnywhere(t.auditRows);
    expect(JSON.stringify(t.auditRows)).not.toMatch(/password/i);
  });

  it("claim ok + bridge failing = ok:true persisted:false, no persisted ack to routing, still one audit row", async () => {
    const t = setup(
      { "PUT /pairing/identity": identityOk, "POST /pairing/claim": claimOk(), "POST /pairing/persisted": persistedOk },
      () => json(502, { ok: false, code: "executor_failed", error: "boom" }),
    );
    const r = await t.svc.pair("u");
    expect(r).toMatchObject({ ok: true, persisted: false, host: "192.168.9.1" });
    expect(r.error).toMatch(/could not be saved/);
    expect(t.routingCalls.some((c) => c.path === "/pairing/persisted")).toBe(false);
    expect(t.auditRows).toHaveLength(1);
    expect(t.auditRows[0]).toMatchObject({ confirmed: true, blocked: false, reason: "persist_failed" });
    expectNoPasswordAnywhere([r, t.auditRows]);
  });

  it("a bridge that is not listening is persisted:false, not a thrown error", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const t = setup({ "PUT /pairing/identity": identityOk, "POST /pairing/claim": claimOk() }, () => {
      throw refused;
    });
    const r = await t.svc.pair();
    expect(r).toMatchObject({ ok: true, persisted: false });
    expect(t.auditRows[0].reason).toBe("persist_failed");
  });

  it.each([
    ["PAIR_WINDOW_CLOSED", 409, 409],
    ["ROUTER_PAIRED_ELSEWHERE", 409, 409],
    ["PAIR_UNSUPPORTED", 502, 502],
    ["PAIR_CLAIM_FAILED", 502, 502],
    ["PAIR_VERIFY_FAILED", 502, 502],
  ])("claim refused with %s -> ok:false, no bridge call, one audit row with the reason", async (code, routingStatus, expected) => {
    const t = setup({
      "PUT /pairing/identity": identityOk,
      "POST /pairing/claim": () => json(routingStatus, { detail: { code, message: "no" } }),
    });
    const r = await t.svc.pair("u");
    expect(r).toMatchObject({ ok: false, persisted: false, code, httpStatus: expected });
    expect(r.error).toBeTruthy();
    expect(t.bridgeCalls).toHaveLength(0);
    expect(t.auditRows).toHaveLength(1);
    expect(t.auditRows[0]).toMatchObject({ confirmed: true, blocked: false, reason: code });
  });

  it("degrades when routing has no pairing endpoints (404): unsupported, nothing dispatched", async () => {
    const t = setup({
      "PUT /pairing/identity": () => json(404, { detail: "Not Found" }),
      "POST /pairing/claim": () => json(404, { detail: "Not Found" }),
    });
    const r = await t.svc.pair("u");
    expect(r).toMatchObject({ ok: false, code: "pairing_unsupported", httpStatus: 501 });
    expect(t.bridgeCalls).toHaveLength(0);
    expect(t.auditRows).toHaveLength(1);
  });

  it("a malformed password from routing is never forwarded", async () => {
    const t = setup({
      "PUT /pairing/identity": identityOk,
      "POST /pairing/claim": () => json(200, { ok: true, password: "not-hex", host: "h", model: "m", paired_at: "x" }),
    });
    const r = await t.svc.pair();
    expect(r.ok).toBe(false);
    expect(t.bridgeCalls).toHaveLength(0);
  });

  it("routing unreachable -> 503 with a row", async () => {
    const t = setup({ "PUT /pairing/identity": identityOk });
    const r = await t.svc.pair("u");
    expect(r).toMatchObject({ ok: false, code: "routing_unavailable", httpStatus: 503 });
    expect(t.auditRows).toHaveLength(1);
  });

  it("refuses a second concurrent pairing", async () => {
    let release: (r: Response) => void = () => undefined;
    const gate = new Promise<Response>((res) => (release = res));
    const t = setup({
      "PUT /pairing/identity": identityOk,
      "POST /pairing/claim": () => gate,
      "POST /pairing/persisted": persistedOk,
    });
    const first = t.svc.pair("a");
    await vi.waitFor(() => expect(t.routingCalls.some((c) => c.path === "/pairing/claim")).toBe(true));
    const second = await t.svc.pair("b");
    expect(second).toMatchObject({ ok: false, code: "busy", httpStatus: 409 });
    release(json(200, { ok: true, password: PASSWORD, host: "h", model: "m", paired_at: "t" }));
    expect((await first).ok).toBe(true);
    expect(t.auditRows).toHaveLength(1);
  });
});

describe("persistPending()", () => {
  it("re-runs step 4 only: pending -> bridge -> persisted", async () => {
    const t = setup({
      "GET /pairing/pending": () => json(200, { pending: true, password: PASSWORD, paired_at: "2026-10-06T10:00:00Z" }),
      "POST /pairing/persisted": persistedOk,
    });
    const r = await t.svc.persistPending("u");
    expect(r).toMatchObject({ ok: true, persisted: true });
    expectNoPasswordAnywhere([r, t.auditRows]);
    expect(t.bridgeCalls[0].body).toEqual({ target: "router", password: PASSWORD });
    expect(t.routingCalls.map((c) => c.path)).toEqual(["/pairing/pending", "/pairing/persisted"]);
    expect(t.routingCalls.some((c) => c.path === "/pairing/claim")).toBe(false);
    expect(t.auditRows).toHaveLength(1);
  });

  it("nothing pending = already persisted, no bridge call", async () => {
    const t = setup({ "GET /pairing/pending": () => json(200, { pending: false, password: null, paired_at: null }) });
    const r = await t.svc.persistPending();
    expect(r).toMatchObject({ ok: true, persisted: true });
    expect(t.bridgeCalls).toHaveLength(0);
  });

  it("bridge still down = ok:true persisted:false", async () => {
    const t = setup(
      { "GET /pairing/pending": () => json(200, { pending: true, password: PASSWORD, paired_at: "t" }) },
      () => json(502, { ok: false, code: "executor_failed" }),
    );
    const r = await t.svc.persistPending();
    expect(r).toMatchObject({ ok: true, persisted: false });
    expect(t.routingCalls.some((c) => c.path === "/pairing/persisted")).toBe(false);
  });

  it("404 from an older routing build = unsupported", async () => {
    const t = setup({ "GET /pairing/pending": () => json(404, { detail: "Not Found" }) });
    expect((await t.svc.persistPending()).code).toBe("pairing_unsupported");
  });
});

describe("getPairingView()", () => {
  const health = (extra: Record<string, unknown>, pairing?: Record<string, unknown>) =>
    json(200, {
      status: "disconnected",
      connected: false,
      router_host: "192.168.9.1",
      ...extra,
      ...(pairing ? { pairing } : {}),
    });

  it("open window + AUTH: returns the open state and routerErrorCode AUTH", async () => {
    const t = setup({
      "GET /health": () =>
        health(
          {},
          { state: "open", window_ends_at: "2026-10-07T00:00:00Z", paired_box: null, paired_elsewhere: false, pending_persist: false },
        ),
    });
    const v = await t.svc.getPairingView();
    expect(v).toMatchObject({
      available: true,
      state: "open",
      windowEndsAt: "2026-10-07T00:00:00Z",
      pairedElsewhere: false,
      pendingPersist: false,
      routerErrorCode: "AUTH",
      host: "192.168.9.1",
    });
  });

  it("paired elsewhere: PAIRED_ELSEWHERE, with ONE audit row per distinct foreign fingerprint", async () => {
    const t = setup({
      "GET /health": () =>
        health({}, { state: "paired", window_ends_at: null, paired_box: OTHER_BOX, paired_elsewhere: true, pending_persist: false }),
    });
    const a = await t.svc.getPairingView();
    await t.svc.getPairingView();
    await t.svc.getPairingView();
    expect(a).toMatchObject({ routerErrorCode: "PAIRED_ELSEWHERE", pairedBox: OTHER_BOX, pairedElsewhere: true });
    expect(t.auditRows).toHaveLength(1);
    expect(t.auditRows[0]).toMatchObject({
      reason: "paired_elsewhere",
      service: "router-pairing",
      data: { host: "192.168.9.1", paired_box: OTHER_BOX },
    });
  });

  it("a second distinct foreign fingerprint is audited again", async () => {
    let box = OTHER_BOX;
    const t = setup({
      "GET /health": () => health({}, { state: "paired", paired_box: box, paired_elsewhere: true }),
    });
    await t.svc.getPairingView();
    box = "ef".repeat(32);
    await t.svc.getPairingView();
    expect(t.auditRows.map((r) => r.data.paired_box)).toEqual([OTHER_BOX, "ef".repeat(32)]);
  });

  it("pending_persist is surfaced for the Retry card", async () => {
    const t = setup({
      "GET /health": () =>
        json(200, { connected: true, router_host: "h", pairing: { state: "paired", pending_persist: true } }),
    });
    const v = await t.svc.getPairingView();
    expect(v.pendingPersist).toBe(true);
    expect(v.routerErrorCode).toBeNull();
  });

  it("routing without a pairing block = available:false (the plain AUTH card stands)", async () => {
    const t = setup({ "GET /health": () => health({}) });
    const v = await t.svc.getPairingView();
    expect(v.available).toBe(false);
    expect(v.state).toBeNull();
  });

  it("routing down = available:false, never throws", async () => {
    const t = setup({});
    expect((await t.svc.getPairingView()).available).toBe(false);
  });
});

describe("reconcile()", () => {
  it("publishes the identity and audits a foreign pairing without the dashboard", async () => {
    const t = setup({
      "PUT /pairing/identity": identityOk,
      "GET /health": () =>
        json(200, {
          connected: false,
          router_host: "192.168.9.1",
          pairing: { state: "paired", paired_box: OTHER_BOX, paired_elsewhere: true },
        }),
    });
    await t.svc.reconcile();
    await t.svc.reconcile();
    expect(t.routingCalls[0]).toMatchObject({ path: "/pairing/identity", body: { box_fingerprint: FINGERPRINT } });
    expect(t.auditRows).toHaveLength(1);
  });

  it("is silent when routing lacks the endpoints", async () => {
    const t = setup({
      "PUT /pairing/identity": () => json(404, {}),
      "GET /health": () => json(200, { connected: true }),
    });
    await expect(t.svc.reconcile()).resolves.toBeUndefined();
    expect(t.auditRows).toHaveLength(0);
  });
});
