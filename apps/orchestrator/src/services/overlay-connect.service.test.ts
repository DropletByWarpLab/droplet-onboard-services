import { describe, it, expect, vi } from "vitest";
import {
  buildOverlayPollMessage,
  buildOverlayAnswerMessage,
  buildOverlayEnrollMessage,
  sha256Hex,
  runOverlayConnectTick,
  pollOverlaySession,
  probeBoxEndpoint,
  expireIdleOverlayPeers,
  enrollOverlayDevice,
  type OverlayConnectDeps,
  type OverlayVpnPeerRow,
} from "./overlay-connect.service.js";

// --- Fakes -----------------------------------------------------------------

/** Records every payload passed to the device signer + returns a deterministic
 *  signature so we can assert the exact base64 that goes on the wire. */
function makeIdentity() {
  const signedPayloads: string[] = [];
  const identity = {
    getDeviceIdentityStatus: async () =>
      ({
        provisioned: true,
        backend: "mock" as const,
        certSubject: "CN=box",
        certFingerprint: "BOXFP",
        certExpiresAt: "",
        sealingPcrs: [],
        sealValid: true,
        lastResealAt: "",
        currentPcrSnapshot: {},
      }),
    signWithDeviceKey: async (payload: Uint8Array) => {
      signedPayloads.push(new TextDecoder().decode(payload));
      return { signature: new Uint8Array([1, 2, 3, 4]), algorithm: "ecdsa-sha256" };
    },
  };
  return { identity, signedPayloads };
}

const SIG_B64 = Buffer.from([1, 2, 3, 4]).toString("base64"); // "AQIDBA=="

function jsonResponse(status: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** URL-routing fetch mock. Records each call (parsing the JSON body) so the
 *  tests can assert the REAL wire shapes that go over the wire. */
function makeFetch(route: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const k of Object.keys(h)) headers[k] = h[k];
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: FetchCall = {
      url: String(url),
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body,
    };
    calls.push(call);
    return route(call);
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

function makePrisma(seed: OverlayVpnPeerRow[] = []) {
  const rows: Array<OverlayVpnPeerRow & Record<string, unknown>> = seed.map(
    (r) => ({ ...r }),
  );
  let counter = 0;
  const prisma = {
    rows,
    vpnPeer: {
      findUnique: async ({ where }: { where: { publicKey: string } }) =>
        rows.find((r) => r.publicKey === where.publicKey) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `vp-${++counter}`, ...data } as OverlayVpnPeerRow &
          Record<string, unknown>;
        rows.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { publicKey: string };
        data: Record<string, unknown>;
      }) => {
        const row = rows.find((r) => r.publicKey === where.publicKey)!;
        Object.assign(row, data);
        return row;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) => {
        return rows.filter((r) => {
          if (where.kind && r.kind !== where.kind) return false;
          if (where.status && r.status !== where.status) return false;
          const ls = where.lastSessionAt as { lt?: Date } | undefined;
          if (ls?.lt) {
            const t = (r as { lastSessionAt?: Date }).lastSessionAt;
            if (!t || t.getTime() >= ls.lt.getTime()) return false;
          }
          return true;
        });
      },
    },
  };
  return prisma;
}

function makePeers() {
  const installed: unknown[] = [];
  const removed: unknown[] = [];
  const peers = {
    install: async (p: unknown) => {
      installed.push(p);
    },
    remove: async (p: unknown) => {
      removed.push(p);
    },
  };
  return { peers, installed, removed };
}

const FIXED_NOW = new Date("2026-07-18T12:00:00.000Z");
const TS = FIXED_NOW.toISOString();

function baseConfig() {
  return {
    hqBaseUrl: "https://hq.test",
    deviceId: "droplet-abc",
    bridgeUrl: "http://bridge.test:9090",
    bridgeToken: "BRIDGETOKEN",
    vpnInterface: "wg0",
    keepaliveSeconds: 25,
    idleExpiryHours: 12,
  };
}

// --- Message builders ------------------------------------------------------

describe("overlay message contracts", () => {
  it("builds the poll / answer / enroll domain-prefixed strings", () => {
    expect(buildOverlayPollMessage("droplet-abc", TS)).toBe(
      `droplet-overlay-poll:v1:droplet-abc:${TS}`,
    );
    expect(buildOverlayAnswerMessage("sess-1", "1.2.3.4:51820", TS)).toBe(
      `droplet-overlay-answer:v1:sess-1:1.2.3.4:51820:${TS}`,
    );
    expect(
      buildOverlayEnrollMessage("droplet-abc", "fp", "WGPUB"),
    ).toBe("droplet-overlay-enroll:v1:droplet-abc:fp:WGPUB");
  });
});

// --- Full connect state machine --------------------------------------------

describe("runOverlayConnectTick — offer → stun-probe → answer → peer install", () => {
  it("signs, probes, answers, and installs the phone peer with the real wire shapes", async () => {
    const { identity, signedPayloads } = makeIdentity();
    const { peers, installed } = makePeers();
    const prisma = makePrisma();
    const { impl: fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith("/api/overlay/poll")) {
        return jsonResponse(200, {
          session_id: "sess-42",
          client_endpoint: "198.51.100.9:41000",
          client_public_key: "PHONEWGPUBKEY",
          client_label: "Alice iPhone",
          expires_at: "2026-07-18T12:05:00.000Z",
        });
      }
      if (call.url.endsWith("/host/stun-probe")) {
        return jsonResponse(200, {
          ip: "203.0.113.7",
          port: 51820,
          server: "stun.cloudflare.com:3478",
        });
      }
      if (call.url.endsWith("/api/overlay/answer")) {
        return jsonResponse(200, { status: "box_acked" });
      }
      return jsonResponse(500, { error: "unexpected url " + call.url });
    });

    const deps: OverlayConnectDeps = {
      config: baseConfig(),
      identity,
      prisma,
      peers,
      allocateIp: async () => "10.13.13.9",
      now: () => FIXED_NOW,
      fetchImpl,
    };

    const result = await runOverlayConnectTick(deps);
    expect(result).toBe("connected");

    // 1. Poll — exact HQ URL + PoP body + signed message.
    const poll = calls.find((c) => c.url.endsWith("/api/overlay/poll"))!;
    expect(poll.url).toBe("https://hq.test/api/overlay/poll");
    expect(poll.method).toBe("POST");
    expect(poll.body).toEqual({
      device_id: "droplet-abc",
      key_fingerprint: "BOXFP",
      sig: SIG_B64,
      sig_alg: "ecdsa-sha256",
      ts: TS,
    });
    expect(signedPayloads[0]).toBe(`droplet-overlay-poll:v1:droplet-abc:${TS}`);

    // 2. STUN probe — bridge URL + bearer-equivalent header.
    const probe = calls.find((c) => c.url.endsWith("/host/stun-probe"))!;
    expect(probe.url).toBe("http://bridge.test:9090/host/stun-probe");
    expect(probe.method).toBe("GET");
    expect(probe.headers["X-Droplet-Auth"]).toBe("BRIDGETOKEN");

    // 3. Answer — box_endpoint is the observed STUN mapping; signed message
    //    binds session_id + box_endpoint.
    const answer = calls.find((c) => c.url.endsWith("/api/overlay/answer"))!;
    expect(answer.url).toBe("https://hq.test/api/overlay/answer");
    expect(answer.body).toEqual({
      device_id: "droplet-abc",
      key_fingerprint: "BOXFP",
      sig: SIG_B64,
      sig_alg: "ecdsa-sha256",
      ts: TS,
      session_id: "sess-42",
      box_endpoint: "203.0.113.7:51820",
    });
    expect(signedPayloads[1]).toBe(
      `droplet-overlay-answer:v1:sess-42:203.0.113.7:51820:${TS}`,
    );

    // 4. Peer install — phone's key + observed endpoint + 25s keepalive.
    expect(installed).toHaveLength(1);
    expect(installed[0]).toEqual({
      interface: "wg0",
      publicKey: "PHONEWGPUBKEY",
      allowedIps: ["10.13.13.9/32"],
      endpoint: "198.51.100.9:41000",
      persistentKeepalive: 25,
      description: "Alice iPhone",
    });

    // 5. Explicit-state VpnPeer row: kind='overlay', lastSessionAt=now.
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({
      publicKey: "PHONEWGPUBKEY",
      assignedIp: "10.13.13.9",
      kind: "overlay",
      status: "active",
      lastSessionAt: FIXED_NOW,
    });
  });

  it("is a clean no-op on 204 (idle) — no probe, no answer, no peer", async () => {
    const { identity } = makeIdentity();
    const { peers, installed } = makePeers();
    const prisma = makePrisma();
    const { impl: fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith("/api/overlay/poll")) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(500, { error: "should not be called: " + call.url });
    });
    const deps: OverlayConnectDeps = {
      config: baseConfig(),
      identity,
      prisma,
      peers,
      allocateIp: async () => "10.13.13.9",
      now: () => FIXED_NOW,
      fetchImpl,
    };
    const result = await runOverlayConnectTick(deps);
    expect(result).toBe("idle");
    expect(calls).toHaveLength(1); // only the poll
    expect(installed).toHaveLength(0);
    expect(prisma.rows).toHaveLength(0);
  });

  it("fails closed when the STUN probe fails — no answer, no peer install", async () => {
    const { identity } = makeIdentity();
    const { peers, installed } = makePeers();
    const prisma = makePrisma();
    const { impl: fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith("/api/overlay/poll")) {
        return jsonResponse(200, {
          session_id: "sess-1",
          client_endpoint: "198.51.100.9:41000",
          client_public_key: "PHONEWGPUBKEY",
        });
      }
      if (call.url.endsWith("/host/stun-probe")) {
        return jsonResponse(502, { error: "no STUN response" });
      }
      return jsonResponse(500, { error: "unexpected " + call.url });
    });
    const deps: OverlayConnectDeps = {
      config: baseConfig(),
      identity,
      prisma,
      peers,
      allocateIp: async () => "10.13.13.9",
      now: () => FIXED_NOW,
      fetchImpl,
    };
    await expect(runOverlayConnectTick(deps)).rejects.toThrow(/STUN probe/);
    // Never answered HQ, never installed a peer, never wrote a row.
    expect(calls.some((c) => c.url.endsWith("/api/overlay/answer"))).toBe(false);
    expect(installed).toHaveLength(0);
    expect(prisma.rows).toHaveLength(0);
  });

  it("refreshes an existing overlay peer (reuses its IP, bumps lastSessionAt)", async () => {
    const { identity } = makeIdentity();
    const { peers, installed } = makePeers();
    const prisma = makePrisma([
      {
        id: "vp-old",
        publicKey: "PHONEWGPUBKEY",
        assignedIp: "10.13.13.5",
        status: "revoked",
        kind: "overlay",
      },
    ]);
    const { impl: fetchImpl } = makeFetch((call) => {
      if (call.url.endsWith("/api/overlay/poll")) {
        return jsonResponse(200, {
          session_id: "sess-2",
          client_endpoint: "203.0.113.50:5000",
          client_public_key: "PHONEWGPUBKEY",
        });
      }
      if (call.url.endsWith("/host/stun-probe")) {
        return jsonResponse(200, { ip: "203.0.113.7", port: 51820 });
      }
      if (call.url.endsWith("/api/overlay/answer")) {
        return jsonResponse(200, { status: "box_acked" });
      }
      return jsonResponse(500, {});
    });
    const allocateIp = vi.fn(async () => "10.13.13.99");
    const deps: OverlayConnectDeps = {
      config: baseConfig(),
      identity,
      prisma,
      peers,
      allocateIp,
      now: () => FIXED_NOW,
      fetchImpl,
    };
    await runOverlayConnectTick(deps);
    // Did NOT allocate a new IP — reused the existing row's IP.
    expect(allocateIp).not.toHaveBeenCalled();
    expect(prisma.rows).toHaveLength(1);
    expect(prisma.rows[0]).toMatchObject({
      publicKey: "PHONEWGPUBKEY",
      assignedIp: "10.13.13.5",
      status: "active",
      kind: "overlay",
      lastSessionAt: FIXED_NOW,
    });
    expect(installed[0]).toMatchObject({
      allowedIps: ["10.13.13.5/32"],
      endpoint: "203.0.113.50:5000",
    });
  });
});

// --- pollOverlaySession guards --------------------------------------------

describe("pollOverlaySession", () => {
  it("throws when the session omits the client public key (can't install a peer)", async () => {
    const { identity } = makeIdentity();
    const { impl: fetchImpl } = makeFetch(() =>
      jsonResponse(200, {
        session_id: "sess",
        client_endpoint: "1.2.3.4:5",
        // client_public_key missing
      }),
    );
    const deps: OverlayConnectDeps = {
      config: baseConfig(),
      identity,
      prisma: makePrisma(),
      peers: makePeers().peers,
      allocateIp: async () => "10.0.0.1",
      now: () => FIXED_NOW,
      fetchImpl,
    };
    await expect(pollOverlaySession(deps)).rejects.toThrow(/client_public_key/);
  });
});

// --- probeBoxEndpoint fail-closed -----------------------------------------

describe("probeBoxEndpoint", () => {
  it("fails closed when the bridge token is not configured", async () => {
    const { identity } = makeIdentity();
    const deps: OverlayConnectDeps = {
      config: { ...baseConfig(), bridgeToken: "" },
      identity,
      prisma: makePrisma(),
      peers: makePeers().peers,
      allocateIp: async () => "10.0.0.1",
      fetchImpl: makeFetch(() => jsonResponse(200, {})).impl,
    };
    await expect(probeBoxEndpoint(deps)).rejects.toThrow(/token/);
  });
});

// --- Idle-expiry sweep (explicit state) ------------------------------------

describe("expireIdleOverlayPeers", () => {
  it("revokes overlay peers idle past the cutoff, leaves fresh + static peers", async () => {
    const stale = new Date(FIXED_NOW.getTime() - 24 * 3_600_000); // 24h ago
    const fresh = new Date(FIXED_NOW.getTime() - 1 * 3_600_000); // 1h ago
    const prisma = makePrisma([
      { id: "a", publicKey: "STALE", assignedIp: "10.0.0.2", status: "active", kind: "overlay" },
      { id: "b", publicKey: "FRESH", assignedIp: "10.0.0.3", status: "active", kind: "overlay" },
      { id: "c", publicKey: "STATIC", assignedIp: "10.0.0.4", status: "active", kind: "static" },
    ]);
    (prisma.rows[0] as Record<string, unknown>).lastSessionAt = stale;
    (prisma.rows[1] as Record<string, unknown>).lastSessionAt = fresh;
    const { peers, removed } = makePeers();
    const deps: OverlayConnectDeps = {
      config: baseConfig(),
      identity: makeIdentity().identity,
      prisma,
      peers,
      allocateIp: async () => "x",
      now: () => FIXED_NOW,
    };
    const expired = await expireIdleOverlayPeers(deps);
    expect(expired).toBe(1);
    expect(removed).toEqual([{ interface: "wg0", publicKey: "STALE" }]);
    expect(prisma.rows.find((r) => r.publicKey === "STALE")!.status).toBe("revoked");
    expect(prisma.rows.find((r) => r.publicKey === "FRESH")!.status).toBe("active");
    expect(prisma.rows.find((r) => r.publicKey === "STATIC")!.status).toBe("active");
  });
});

// --- Enroll bridge (Part D) ------------------------------------------------

describe("enrollOverlayDevice", () => {
  it("signs the box grant over sha256(sign_pem) + wg key and forwards to HQ", async () => {
    const { identity, signedPayloads } = makeIdentity();
    const pem = "-----BEGIN PUBLIC KEY-----\nMOCK\n-----END PUBLIC KEY-----\n";
    const wgKey = "WGPUB123";
    const { impl: fetchImpl, calls } = makeFetch((call) => {
      if (call.url.endsWith("/api/overlay/devices/enroll")) {
        return jsonResponse(200, { status: "enrolled", device_ref: "dev-1" });
      }
      return jsonResponse(500, { error: "unexpected " + call.url });
    });
    const result = await enrollOverlayDevice(
      {
        config: { hqBaseUrl: "https://hq.test", deviceId: "droplet-abc" },
        identity,
        now: () => FIXED_NOW,
        fetchImpl,
      },
      { wgPublicKey: wgKey, signPublicKeyPem: pem, label: "Alice iPhone" },
    );
    expect(result).toEqual({ status: "enrolled", device_ref: "dev-1" });

    const enroll = calls.find((c) =>
      c.url.endsWith("/api/overlay/devices/enroll"),
    )!;
    expect(enroll.url).toBe("https://hq.test/api/overlay/devices/enroll");
    expect(enroll.method).toBe("POST");
    const expectedFp = sha256Hex(pem);
    expect(enroll.body).toEqual({
      device_id: "droplet-abc",
      key_fingerprint: "BOXFP",
      sig: SIG_B64,
      sig_alg: "ecdsa-sha256",
      client: {
        wg_public_key: wgKey,
        sign_public_key_pem: pem,
        label: "Alice iPhone",
      },
    });
    // The box signed the exact grant string HQ verifies.
    expect(signedPayloads[0]).toBe(
      `droplet-overlay-enroll:v1:droplet-abc:${expectedFp}:${wgKey}`,
    );
  });
});
