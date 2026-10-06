/**
 * ADR-071 slice C — the switch and AP roles of the shared device-pairing service.
 * The router role is pinned in router-pairing.service.test.ts (unchanged by the
 * generalisation). The owning services, the device-bridge and the device identity
 * are all faked; nothing here touches a device, a socket or a disk.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { DEVICE_BRIDGE_URL: "http://bridge.invalid:9090", NODE_ENV: "test" },
}));

import {
  AP_PROFILE,
  ROUTER_PROFILE,
  SWITCH_PROFILE,
  createDevicePairingService,
  type DevicePairingProfile,
} from "./device-pairing.service.js";

// Same self-signed certificate + SPKI fingerprint as router-pairing.service.test.ts.
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
const MAC = "AA:BB:CC:DD:EE:01";
const MAC_PATH = encodeURIComponent(MAC);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

type Handler = (init: { method?: string; body?: string }) => Response | Promise<Response>;

function setup(
  profile: DevicePairingProfile,
  routes: Record<string, Handler>,
  bridge?: (body: Record<string, unknown>) => Response | Promise<Response>,
  probeDevice?: () => Promise<unknown>,
) {
  const calls: Array<{ path: string; method?: string; body?: any }> = [];
  const serviceFetch = vi.fn(async (path: string, init: { method?: string; body?: string } = {}) => {
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
    const h = routes[`${init.method ?? "GET"} ${path}`];
    if (!h) throw new Error(`no route ${init.method ?? "GET"} ${path}`);
    return h(init);
  });
  const bridgeCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    bridgeCalls.push({ url: String(url), body });
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
  const svc = createDevicePairingService({
    profile,
    prisma: prisma as never,
    identity: { getDeviceCert: async () => CERT_PEM },
    serviceFetch: serviceFetch as never,
    probeDevice,
    fetchImpl: fetchImpl as never,
    bridgeUrl: "http://bridge.invalid:9090",
    bridgeToken: () => "bridge-admin-token",
  });
  return { svc, calls, bridgeCalls, auditRows, serviceFetch };
}

const claimOk = (extra: Record<string, unknown> = {}): Handler => () =>
  json(200, { ok: true, password: PASSWORD, host: "192.168.9.2", model: "GS1900-10HP", paired_at: "2026-10-06T10:00:00Z", ...extra });
const ok: Handler = () => json(200, { ok: true });

function expectNoPassword(value: unknown) {
  expect(JSON.stringify(value)).not.toContain(PASSWORD);
}

// ---------------------------------------------------------------------------
describe("switch role", () => {
  beforeEach(() => vi.clearAllMocks());

  const routes = (claim: Handler = claimOk()) => ({
    "PUT /pairing/identity": ok,
    "POST /pairing/claim": claim,
    "POST /pairing/persisted": ok,
  });

  it("pairs through the switch service, dispatches target=switch, writes ONE switch-pairing row without the password", async () => {
    const t = setup(SWITCH_PROFILE, routes());
    const r = await t.svc.pair("user-1");

    expect(r).toMatchObject({ ok: true, persisted: true, host: "192.168.9.2", model: "GS1900-10HP", httpStatus: 200 });
    expectNoPassword(r);
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "PUT /pairing/identity",
      "POST /pairing/claim",
      "POST /pairing/persisted",
    ]);
    expect(t.calls[1].body).toEqual({ box_fingerprint: FINGERPRINT });

    expect(t.bridgeCalls).toHaveLength(1);
    expect(t.bridgeCalls[0].url).toBe("http://bridge.invalid:9090/host/router-pairing");
    expect(t.bridgeCalls[0].body).toEqual({ target: "switch", password: PASSWORD });

    expect(t.auditRows).toHaveLength(1);
    expect(t.auditRows[0]).toMatchObject({
      userId: "user-1",
      domain: "network",
      service: "switch-pairing",
      entityId: "network.switch_pairing",
      confirmed: true,
      blocked: false,
      reason: null,
    });
    expect(t.auditRows[0].data).toEqual({
      host: "192.168.9.2",
      model: "GS1900-10HP",
      box_fingerprint: FINGERPRINT,
      paired_at: "2026-10-06T10:00:00Z",
    });
    expectNoPassword(t.auditRows);
  });

  it("claim ok + bridge failing = ok:true persisted:false, no persisted ack, still one row", async () => {
    const t = setup(SWITCH_PROFILE, routes(), () => json(502, { ok: false, code: "executor_failed" }));
    const r = await t.svc.pair("user-1");
    expect(r).toMatchObject({ ok: true, persisted: false, httpStatus: 200 });
    expect(r.error).toMatch(/could not be saved/);
    expect(t.calls.map((c) => c.path)).not.toContain("/pairing/persisted");
    expect(t.auditRows).toHaveLength(1);
    expect(t.auditRows[0].reason).toBe("persist_failed");
    expectNoPassword([r, t.auditRows]);
  });

  it.each([
    ["SWITCH_PAIRED_ELSEWHERE", 409, /This switch is paired to another device\. Press the switch's button, or reset it to factory settings to re-pair\./],
    ["PAIR_WINDOW_CLOSED", 409, /The switch is not accepting a pairing right now\. Press the switch's button/],
    ["PAIR_BUSY", 409, /already in progress/],
    ["PAIR_UNSUPPORTED", 502, /This switch does not support pairing\./],
    ["PAIR_CLAIM_FAILED", 502, /The switch did not accept the pairing/],
    ["PAIR_VERIFY_FAILED", 502, /The switch accepted the pairing but the new credential did not work/],
    ["SWITCH_UNREACHABLE", 503, /The switch could not be reached/],
  ])("claim refusal %s -> %i with switch copy and a row naming the code", async (code, status, copy) => {
    const t = setup(SWITCH_PROFILE, routes(() => json(status as number, { code, detail: "refused" })));
    const r = await t.svc.pair("user-1");
    expect(r).toMatchObject({ ok: false, persisted: false, code, httpStatus: status });
    expect(r.error).toMatch(copy as RegExp);
    expect(t.bridgeCalls).toHaveLength(0);
    expect(t.auditRows).toHaveLength(1);
    expect(t.auditRows[0]).toMatchObject({ service: "switch-pairing", reason: code, confirmed: true });
  });

  it("the router's ROUTER_PAIRED_ELSEWHERE code is NOT the switch's: unknown code gets the generic switch copy", async () => {
    const t = setup(SWITCH_PROFILE, routes(() => json(409, { code: "ROUTER_PAIRED_ELSEWHERE" })));
    const r = await t.svc.pair("u");
    expect(r.error).toBe("The switch did not accept the pairing. Try again.");
  });

  it("a switch service without the endpoints (404) is unsupported, naming the switch service", async () => {
    const t = setup(SWITCH_PROFILE, routes(() => json(404, { detail: "Not Found" })));
    const r = await t.svc.pair("u");
    expect(r).toMatchObject({ ok: false, code: "pairing_unsupported", httpStatus: 501 });
    expect(r.error).toBe("This Droplet's switch service does not support pairing yet.");
    expect(t.bridgeCalls).toHaveLength(0);
  });

  it("switch service unreachable -> 503 naming the switch service, with a row", async () => {
    const t = setup(SWITCH_PROFILE, { "PUT /pairing/identity": ok });
    const r = await t.svc.pair("u");
    expect(r).toMatchObject({ ok: false, code: "routing_unavailable", httpStatus: 503 });
    expect(r.error).toBe("The switch service could not be reached. Try again in a moment.");
    expect(t.auditRows).toHaveLength(1);
  });

  describe("getPairingView()", () => {
    const health = (over: Record<string, unknown> = {}) =>
      json(200, {
        status: "disconnected",
        connected: false,
        switch_host: "192.168.9.2",
        error_code: "SWITCH_AUTH",
        pairing: { state: "open", window_ends_at: "2026-10-07T00:00:00Z", paired_box: null, paired_elsewhere: false, pending_persist: false },
        ...over,
      });

    it("AUTH + open window: state open, code AUTH from the body, no authenticated probe", async () => {
      const probe = vi.fn();
      const t = setup(SWITCH_PROFILE, { "GET /health": () => health() }, undefined, probe);
      // `probeDevice` is not given for the switch in production; passing one proves it is not what decides.
      const v = await createDevicePairingService({
        profile: SWITCH_PROFILE,
        prisma: { commandAuditLog: { create: vi.fn() } } as never,
        identity: { getDeviceCert: async () => CERT_PEM },
        serviceFetch: t.serviceFetch as never,
      }).getPairingView();
      expect(v).toEqual({
        available: true,
        state: "open",
        windowEndsAt: "2026-10-07T00:00:00Z",
        pairedBox: null,
        pairedElsewhere: false,
        pendingPersist: false,
        routerErrorCode: "AUTH",
        host: "192.168.9.2",
        model: null,
      });
      expect(probe).not.toHaveBeenCalled();
    });

    it("healthy switch: no error code", async () => {
      const t = setup(SWITCH_PROFILE, {
        "GET /health": () => health({ connected: true, status: "ok", error_code: null, pairing: { state: "unknown", paired_elsewhere: false } }),
      });
      const v = await t.svc.getPairingView();
      expect(v).toMatchObject({ available: true, state: "unknown", routerErrorCode: null });
    });

    it("paired elsewhere: PAIRED_ELSEWHERE, ONE switch-pairing row per distinct foreign fingerprint", async () => {
      const t = setup(SWITCH_PROFILE, {
        "GET /health": () =>
          health({
            error_code: "SWITCH_PAIRED_ELSEWHERE",
            pairing: { state: "paired", paired_box: OTHER_BOX, paired_elsewhere: true },
          }),
      });
      const a = await t.svc.getPairingView();
      await t.svc.getPairingView();
      expect(a).toMatchObject({ routerErrorCode: "PAIRED_ELSEWHERE", pairedElsewhere: true, pairedBox: OTHER_BOX });
      expect(t.auditRows).toHaveLength(1);
      expect(t.auditRows[0]).toMatchObject({
        service: "switch-pairing",
        entityId: "network.switch_pairing",
        reason: "paired_elsewhere",
        confirmed: false,
        data: { host: "192.168.9.2", paired_box: OTHER_BOX },
      });
    });

    it("a switch service without a pairing block is available:false", async () => {
      const t = setup(SWITCH_PROFILE, { "GET /health": () => json(200, { status: "ok", connected: true, switch_host: "192.168.9.2" }) });
      expect(await t.svc.getPairingView()).toMatchObject({ available: false, host: "192.168.9.2" });
    });

    it("switch service down is available:false, never throws", async () => {
      const t = setup(SWITCH_PROFILE, {});
      expect(await t.svc.getPairingView()).toMatchObject({ available: false });
    });
  });

  it("persistPending re-runs step 4 with target=switch", async () => {
    const t = setup(SWITCH_PROFILE, {
      "GET /pairing/pending": () => json(200, { pending: true, password: PASSWORD, paired_at: "2026-10-06T10:00:00Z" }),
      "POST /pairing/persisted": ok,
    });
    const r = await t.svc.persistPending("user-1");
    expect(r).toMatchObject({ ok: true, persisted: true, httpStatus: 200 });
    expect(t.bridgeCalls[0].body).toEqual({ target: "switch", password: PASSWORD });
    expect(t.auditRows[0]).toMatchObject({ service: "switch-pairing" });
    expectNoPassword([r, t.auditRows]);
  });

  it("reconcile publishes the identity and audits a foreign pairing", async () => {
    const t = setup(SWITCH_PROFILE, {
      "PUT /pairing/identity": ok,
      "GET /health": () =>
        json(200, {
          switch_host: "192.168.9.2",
          pairing: { state: "paired", paired_box: OTHER_BOX, paired_elsewhere: true },
        }),
    });
    await t.svc.reconcile();
    expect(t.calls[0]).toMatchObject({ method: "PUT", path: "/pairing/identity", body: { box_fingerprint: FINGERPRINT } });
    expect(t.auditRows).toHaveLength(1);
    expect(t.auditRows[0]).toMatchObject({ service: "switch-pairing", reason: "paired_elsewhere" });
  });
});

// ---------------------------------------------------------------------------
describe("ap role", () => {
  beforeEach(() => vi.clearAllMocks());

  const routes = (claim: Handler = claimOk({ mac: MAC, host: "192.168.9.42", model: "Zyxel NWA50BE" })) => ({
    [`POST /aps/${MAC_PATH}/pairing/claim`]: claim,
    "POST /aps/pairing/persisted": ok,
  });

  it("claims THAT AP, dispatches target=ap, and writes ONE ap-pairing row carrying the MAC", async () => {
    const t = setup(AP_PROFILE, routes());
    const r = await t.svc.pair("user-1", MAC);

    expect(r).toMatchObject({ ok: true, persisted: true, host: "192.168.9.42", model: "Zyxel NWA50BE", httpStatus: 200 });
    expectNoPassword(r);
    // no identity publish of its own (routing shares the router's), claim on the per-AP path
    expect(t.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST /aps/${MAC_PATH}/pairing/claim`,
      "POST /aps/pairing/persisted",
    ]);
    expect(t.calls[0].body).toEqual({ box_fingerprint: FINGERPRINT });
    expect(t.bridgeCalls[0].body).toEqual({ target: "ap", password: PASSWORD });
    expect(t.auditRows).toHaveLength(1);
    expect(t.auditRows[0]).toMatchObject({
      userId: "user-1",
      domain: "network",
      service: "ap-pairing",
      entityId: "network.ap_pairing",
      confirmed: true,
      reason: null,
    });
    expect(t.auditRows[0].data).toEqual({
      host: "192.168.9.42",
      model: "Zyxel NWA50BE",
      box_fingerprint: FINGERPRINT,
      paired_at: "2026-10-06T10:00:00Z",
      mac: MAC,
    });
    expectNoPassword(t.auditRows);
  });

  it.each([
    ["AP_PAIRED_ELSEWHERE", 409, /This access point is paired to another device\. Press the access point's button to re-pair\./],
    ["PAIR_WINDOW_CLOSED", 409, /The access point is not accepting a pairing right now/],
    ["AP_UNREACHABLE", 503, /The access point could not be reached/],
    ["PAIR_VERIFY_FAILED", 502, /The access point accepted the pairing but the new credential did not work/],
  ])("claim refusal %s -> %i with access point copy; the row carries the MAC", async (code, status, copy) => {
    const t = setup(AP_PROFILE, routes(() => json(status as number, { code, detail: "refused" })));
    const r = await t.svc.pair("user-1", MAC);
    expect(r).toMatchObject({ ok: false, code, httpStatus: status });
    expect(r.error).toMatch(copy as RegExp);
    expect(t.auditRows[0]).toMatchObject({ service: "ap-pairing", reason: code, data: { box_fingerprint: FINGERPRINT, mac: MAC } });
  });

  it("routing without the AP endpoints (404) is unsupported, naming the routing service", async () => {
    const t = setup(AP_PROFILE, routes(() => json(404, { detail: "Not Found" })));
    const r = await t.svc.pair("u", MAC);
    expect(r).toMatchObject({ code: "pairing_unsupported", httpStatus: 501 });
    expect(r.error).toBe("This Droplet's routing service does not support pairing yet.");
  });

  describe("getPairingView(mac)", () => {
    const apStatus = (over: Record<string, unknown> = {}) =>
      json(200, {
        mac: MAC,
        host: "192.168.9.42",
        connected: null,
        error_code: null,
        pairing: { state: "open", window_ends_at: "2026-10-07T00:00:00+00:00", paired_box: null, paired_elsewhere: false, pending_persist: false },
        ...over,
      });

    it("reads THAT AP's status and reports an open window with the AP's host", async () => {
      const t = setup(AP_PROFILE, { [`GET /aps/${MAC_PATH}/pairing`]: () => apStatus() });
      const v = await t.svc.getPairingView(MAC);
      expect(v).toMatchObject({
        available: true,
        state: "open",
        windowEndsAt: "2026-10-07T00:00:00+00:00",
        routerErrorCode: null,
        host: "192.168.9.42",
      });
    });

    it("an unreachable AP is UNREACHABLE; an unknown one carries no code", async () => {
      const t = setup(AP_PROFILE, {
        [`GET /aps/${MAC_PATH}/pairing`]: () => apStatus({ error_code: "AP_UNREACHABLE", pairing: { state: "unknown" } }),
      });
      expect(await t.svc.getPairingView(MAC)).toMatchObject({ state: "unknown", routerErrorCode: "UNREACHABLE" });
    });

    it("paired elsewhere is audited ONCE per (AP, fingerprint), with the MAC", async () => {
      const t = setup(AP_PROFILE, {
        [`GET /aps/${MAC_PATH}/pairing`]: () =>
          apStatus({ error_code: "AP_PAIRED_ELSEWHERE", pairing: { state: "paired", paired_box: OTHER_BOX, paired_elsewhere: true } }),
        [`GET /aps/${encodeURIComponent("AA:BB:CC:DD:EE:02")}/pairing`]: () =>
          apStatus({ error_code: "AP_PAIRED_ELSEWHERE", pairing: { state: "paired", paired_box: OTHER_BOX, paired_elsewhere: true } }),
      });
      await t.svc.getPairingView(MAC);
      await t.svc.getPairingView(MAC);
      await t.svc.getPairingView("AA:BB:CC:DD:EE:02");
      expect(t.auditRows).toHaveLength(2);
      expect(t.auditRows.map((r) => r.data.mac)).toEqual([MAC, "AA:BB:CC:DD:EE:02"]);
      expect(t.auditRows[0]).toMatchObject({ service: "ap-pairing", reason: "paired_elsewhere" });
    });

    it("an AP the routing service cannot see (404 body without a pairing block) is available:false", async () => {
      const t = setup(AP_PROFILE, { [`GET /aps/${MAC_PATH}/pairing`]: () => json(404, { detail: "Invalid MAC" }) });
      expect(await t.svc.getPairingView(MAC)).toMatchObject({ available: false });
    });
  });

  it("persistPending audits against the AP routing says is pending, not the caller's MAC", async () => {
    const t = setup(AP_PROFILE, {
      "GET /aps/pairing/pending": () =>
        json(200, { pending: true, password: PASSWORD, paired_at: "2026-10-06T10:00:00Z", mac: "AA:BB:CC:DD:EE:02" }),
      "POST /aps/pairing/persisted": ok,
    });
    const r = await t.svc.persistPending("user-1", MAC);
    expect(r).toMatchObject({ ok: true, persisted: true });
    expect(t.bridgeCalls[0].body).toEqual({ target: "ap", password: PASSWORD });
    expect(t.auditRows[0].data.mac).toBe("AA:BB:CC:DD:EE:02");
    expectNoPassword([r, t.auditRows]);
  });

  it("reconcile is a no-op (an AP has no standing status)", async () => {
    const t = setup(AP_PROFILE, {});
    await t.svc.reconcile();
    expect(t.calls).toHaveLength(0);
  });

  it("refuses a second concurrent pairing (one shared AP secret)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = setup(AP_PROFILE, routes(async () => {
      await gate;
      return claimOk()({});
    }));
    const first = t.svc.pair("u", MAC);
    // let the first reach the claim
    await new Promise((r) => setTimeout(r, 10));
    const second = await t.svc.pair("u", "AA:BB:CC:DD:EE:02");
    expect(second).toMatchObject({ ok: false, code: "busy", httpStatus: 409 });
    release();
    expect((await first).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("profiles", () => {
  it("each role dispatches to its own bridge target and audit service", () => {
    expect([ROUTER_PROFILE, SWITCH_PROFILE, AP_PROFILE].map((p) => [p.role, p.auditService])).toEqual([
      ["router", "router-pairing"],
      ["switch", "switch-pairing"],
      ["ap", "ap-pairing"],
    ]);
  });
});
