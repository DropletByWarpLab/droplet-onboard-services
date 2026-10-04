/**
 * WARP-1847 — the discovered-camera candidate list.
 *
 * The defect this covers: GET /api/cameras/discovered answered from Postgres
 * with `enabled: false, autoDiscovered: true`, a shape the discovery upsert
 * never wrote (Camera.enabled defaults to true), so the operator's "what's on
 * my network" list was structurally always empty while camera-discovery held a
 * live pending map the orchestrator never read.
 *
 * Each test drives getCameraCandidates() with a faked camera-discovery so the
 * merge, the credential redaction, the status derivation and the degrade path
 * are all exercised through the real code path.
 *
 * WARP-3508 adds the other half of "what is NOT a candidate": a camera the
 * operator already has. camera-discovery only knows what IT adopted, so a camera
 * added by hand (a Camera row with `enabled: true` and no MAC) kept showing as a
 * "Needs sign-in" card forever. The orchestrator is the one place that knows
 * about manual adds and about Frigate's own camera inputs, so the exclusion has
 * to happen here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { CAMERA_DISCOVERY_URL: "http://camera-discovery.test:8085" },
}));

const internalFetch = vi.fn();
vi.mock("../lib/internal-tls.js", () => ({
  internalFetch: (...args: unknown[]) => internalFetch(...args),
  internalBaseUrl: (url: string) => url,
}));

const fetchConfig = vi.fn();
vi.mock("./frigate.client.js", () => ({
  fetchConfig: (...args: unknown[]) => fetchConfig(...args),
}));

import {
  deriveCandidateStatus,
  frigateInputHosts,
  getCameraCandidates,
  isLiveCandidateId,
  isManagedCameraRow,
  macFromCandidateId,
  mutateLiveCandidate,
  redactRtspCredentials,
  submitLiveCandidateCredentials,
} from "./camera-candidates.service.js";

type DbRow = {
  id: string;
  name: string;
  displayName: string;
  manufacturer: string | null;
  model: string | null;
  ipAddress: string;
  macAddress: string | null;
  enabled: boolean;
  autoDiscovered: boolean;
  createdAt: Date;
};

/** `findMany` returns every Camera row; the service decides which are candidates. */
function makePrisma(rows: DbRow[] = []) {
  return {
    camera: { findMany: vi.fn().mockResolvedValue(rows) },
  } as unknown as Parameters<typeof getCameraCandidates>[0];
}

/** A discovery-only row: what `upsertCameraRecord` writes for a candidate still being probed. */
function dbRow(over: Partial<DbRow> = {}): DbRow {
  return {
    id: "db-1",
    name: "old_cam",
    displayName: "Old Cam",
    manufacturer: null,
    model: null,
    ipAddress: "192.168.9.50",
    macAddress: "AA:BB:CC:DD:EE:FF",
    enabled: false,
    autoDiscovered: true,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...over,
  };
}

/** A camera the operator added by hand: live in the grid, never seen a MAC. */
function manualRow(over: Partial<DbRow> = {}): DbRow {
  return dbRow({
    id: "manual-1",
    name: "front_door",
    displayName: "Front Door",
    ipAddress: "192.168.9.219",
    macAddress: null,
    enabled: true,
    autoDiscovered: false,
    ...over,
  });
}

/** The resolved Frigate config shape: cameras.<name>.ffmpeg.inputs[].path. */
function frigateConfigWith(...paths: string[]) {
  return {
    cameras: Object.fromEntries(
      paths.map((path, i) => [`cam_${i}`, { ffmpeg: { inputs: [{ path, roles: ["detect"] }] } }]),
    ),
  };
}

/** Route the faked camera-discovery by path so a test only states what it cares about. */
function discovery(opts: {
  pending?: unknown[] | Error;
  known?: unknown[] | Error;
}) {
  internalFetch.mockImplementation(async (url: string) => {
    const which = url.includes("/cameras/known") ? opts.known : opts.pending;
    if (which instanceof Error) throw which;
    return new Response(JSON.stringify(which ?? []), { status: 200 });
  });
}

const HANWHA = {
  ip: "192.168.9.219",
  mac: "e4:30:22:50:2a:fd",
  hostname: "XNV-C8083R-E43022502AFD",
  manufacturer: "Hanwha",
  model: "XNV-C8083R",
  rtsp_url: "rtsp://admin:T3stCamPw%21@192.168.9.219:554/profile2/media.smp",
  status: "needs_setup",
  detection_method: "rtsp_default_credentials",
};

beforeEach(() => {
  internalFetch.mockReset();
  // Frigate with no cameras unless a test says otherwise.
  fetchConfig.mockReset();
  fetchConfig.mockResolvedValue({ cameras: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("redactRtspCredentials", () => {
  it("strips embedded credentials and reports that they existed", () => {
    expect(
      redactRtspCredentials("rtsp://admin:T3stCamPw%21@192.168.9.219:554/profile2/media.smp"),
    ).toEqual({
      rtspUrl: "rtsp://192.168.9.219:554/profile2/media.smp",
      hasCredentials: true,
    });
  });

  it("leaves a credential-free URL untouched", () => {
    expect(redactRtspCredentials("rtsp://192.168.9.219:554/stream1")).toEqual({
      rtspUrl: "rtsp://192.168.9.219:554/stream1",
      hasCredentials: false,
    });
  });

  it("does not mistake an @ inside the path for credentials", () => {
    expect(redactRtspCredentials("rtsp://host:554/live@main")).toEqual({
      rtspUrl: "rtsp://host:554/live@main",
      hasCredentials: false,
    });
  });

  it("handles rtsps:// too", () => {
    expect(redactRtspCredentials("rtsps://u:p@host/s")).toEqual({
      rtspUrl: "rtsps://host/s",
      hasCredentials: true,
    });
  });
});

describe("deriveCandidateStatus", () => {
  it("is unverified with no stream URL at all", () => {
    expect(deriveCandidateStatus({ status: "pending" })).toBe("unverified");
  });

  it("is ready when default credentials answered", () => {
    expect(deriveCandidateStatus(HANWHA)).toBe("ready");
  });

  it("is ready for an ONVIF stream URI", () => {
    expect(
      deriveCandidateStatus({ rtsp_url: "rtsp://h/s", detection_method: "onvif" }),
    ).toBe("ready");
  });

  it("treats a bare port-open guess as needing credentials", () => {
    // rtsp_port_open is explicitly a placeholder URL, never a verified stream.
    expect(
      deriveCandidateStatus({
        rtsp_url: "rtsp://192.168.9.176:554/stream1",
        status: "needs_setup",
        detection_method: "rtsp_port_open",
      }),
    ).toBe("needs_credentials");
  });

  it("is ready once the record is active in Frigate", () => {
    expect(deriveCandidateStatus({ rtsp_url: "rtsp://h/s", status: "active" })).toBe("ready");
  });
});

describe("getCameraCandidates", () => {
  it("surfaces the live pending list with credentials stripped", async () => {
    discovery({ pending: [HANWHA] });
    const result = await getCameraCandidates(makePrisma());

    expect(result.discoveryOnline).toBe(true);
    expect(result.candidates).toHaveLength(1);
    const cam = result.candidates[0];
    expect(cam.ip).toBe("192.168.9.219");
    expect(cam.mac).toBe("E4:30:22:50:2A:FD");
    expect(cam.id).toBe("mac:E4:30:22:50:2A:FD");
    expect(cam.manufacturer).toBe("Hanwha");
    expect(cam.status).toBe("ready");
    expect(cam.hasCredentials).toBe(true);
    expect(cam.source).toBe("live");
    // The whole point of the redaction: no password reaches a browser client.
    expect(JSON.stringify(cam)).not.toContain("T3stCamPw");
  });

  it("names a leaseless camera from its IP", async () => {
    discovery({ pending: [{ ip: "192.168.9.77", mac: "11:22:33:44:55:66" }] });
    const { candidates } = await getCameraCandidates(makePrisma());
    expect(candidates[0].name).toBe("camera_192_168_9_77");
    expect(candidates[0].displayName).toBe("Camera 192 168 9 77");
  });

  it("drops a record with no address — there is nothing to act on", async () => {
    discovery({ pending: [{ mac: "11:22:33:44:55:66" }] });
    const { candidates } = await getCameraCandidates(makePrisma());
    expect(candidates).toEqual([]);
  });

  it("excludes cameras already adopted into Frigate", async () => {
    // Same camera in both lists: it is a real camera in the grid, not something
    // left to add. Match is on MAC, case-insensitively.
    discovery({
      pending: [HANWHA],
      known: [{ ip: "192.168.9.219", mac: "E4:30:22:50:2A:FD", status: "active" }],
    });
    const { candidates } = await getCameraCandidates(makePrisma());
    expect(candidates).toEqual([]);
  });

  it("still lists candidates when the known-cameras read fails", async () => {
    discovery({ pending: [HANWHA], known: new Error("fetch failed") });
    const { candidates, discoveryOnline } = await getCameraCandidates(makePrisma());
    expect(discoveryOnline).toBe(true);
    expect(candidates).toHaveLength(1);
  });

  it("degrades to the DB rows when camera-discovery is unreachable", async () => {
    discovery({ pending: new Error("fetch failed"), known: new Error("fetch failed") });
    const { candidates, discoveryOnline } = await getCameraCandidates(
      makePrisma([dbRow()]),
    );

    expect(discoveryOnline).toBe(false);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      id: "db-1",
      name: "old_cam",
      status: "unverified",
      source: "database",
      rtspUrl: null,
      hasCredentials: false,
    });
  });

  it("does not list the same camera twice when it is both live and in the DB", async () => {
    discovery({ pending: [HANWHA] });
    const { candidates } = await getCameraCandidates(
      makePrisma([dbRow({ id: "db-hanwha", macAddress: "e4:30:22:50:2a:fd" })]),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("live");
  });

  it("dedupes on IP when the DB row has no MAC", async () => {
    discovery({ pending: [HANWHA] });
    const { candidates } = await getCameraCandidates(
      makePrisma([dbRow({ macAddress: null, ipAddress: "192.168.9.219" })]),
    );
    expect(candidates).toHaveLength(1);
  });

  it("appends DB rows the live sweep has not seen", async () => {
    discovery({ pending: [HANWHA] });
    const { candidates } = await getCameraCandidates(
      makePrisma([dbRow({ id: "db-other", ipAddress: "192.168.9.60", macAddress: "99:88:77:66:55:44" })]),
    );
    expect(candidates.map((c) => c.source)).toEqual(["live", "database"]);
  });

  it("sends the device secret to camera-discovery", async () => {
    // /cameras/discovered is gated behind DEVICE_SECRET (NET-05) — without the
    // header every call 403s and the list silently reads as empty.
    process.env.DEVICE_SECRET = "test-secret";
    discovery({ pending: [] });
    await getCameraCandidates(makePrisma());
    const [, init] = internalFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers.Authorization).toBe("Bearer test-secret");
    delete process.env.DEVICE_SECRET;
  });
});

describe("isManagedCameraRow", () => {
  // The one place that decides "the operator already has this camera" from the
  // columns that exist today. WARP-3506/3510 replaces its body with an explicit
  // adoption state; every caller goes through here so that stays a one-line swap.
  it.each([
    // [enabled, autoDiscovered, managed, why]
    [true, true, true, "adopted through discovery and live in the grid"],
    [true, false, true, "added by hand"],
    [false, false, true, "added by hand, then switched off — still the operator's camera"],
    [false, true, false, "found by discovery and never adopted — the only real candidate shape"],
  ])("enabled=%s autoDiscovered=%s → managed=%s (%s)", (enabled, autoDiscovered, managed) => {
    expect(isManagedCameraRow({ enabled, autoDiscovered })).toBe(managed);
  });
});

describe("frigateInputHosts", () => {
  it("collects the host of every camera input, credentials and port stripped", () => {
    const hosts = frigateInputHosts(
      frigateConfigWith(
        "rtsp://admin:T3stCamPw%21@192.168.9.219:554/profile2/media.smp",
        "rtsp://192.168.9.50/stream1",
        "rtsps://10.0.0.7:322/live",
      ),
    );
    expect([...hosts].sort()).toEqual(["10.0.0.7", "192.168.9.219", "192.168.9.50"]);
  });

  it("reads every input of a camera that has more than one", () => {
    const hosts = frigateInputHosts({
      cameras: {
        patio: {
          ffmpeg: {
            inputs: [
              { path: "rtsp://192.168.9.60/main", roles: ["record"] },
              { path: "rtsp://192.168.9.60/sub", roles: ["detect"] },
              { path: "rtsp://192.168.9.61/main", roles: ["audio"] },
            ],
          },
        },
      },
    });
    expect([...hosts].sort()).toEqual(["192.168.9.60", "192.168.9.61"]);
  });

  it("copes with an unencoded @ inside the password", () => {
    expect([...frigateInputHosts(frigateConfigWith("rtsp://admin:p@ss@192.168.9.219/s"))]).toEqual([
      "192.168.9.219",
    ]);
  });

  it("skips anything that is not a URL with a host, and never throws on odd shapes", () => {
    expect(frigateInputHosts(frigateConfigWith("/dev/video0", "ffmpeg:rtsp://x#video=copy")).size).toBe(0);
    expect(frigateInputHosts(null).size).toBe(0);
    expect(frigateInputHosts({}).size).toBe(0);
    expect(frigateInputHosts({ cameras: null }).size).toBe(0);
    expect(frigateInputHosts({ cameras: { a: null, b: {}, c: { ffmpeg: {} }, d: { ffmpeg: { inputs: "x" } } } }).size).toBe(0);
    expect(
      frigateInputHosts({ cameras: { a: { ffmpeg: { inputs: [null, {}, { path: 7 }] } } } }).size,
    ).toBe(0);
  });
});

describe("managed cameras are never candidates (WARP-3508)", () => {
  // The live repro: 192.168.9.219 was added by hand (Camera row enabled, no MAC),
  // while camera-discovery's pending map still held it as needs_setup.
  const PENDING_MANUAL = {
    ip: "192.168.9.219",
    mac: "e4:30:22:50:2a:fd",
    status: "needs_setup",
    rtsp_url: "rtsp://192.168.9.219:554/stream1",
    name: "xnv_c8083r_e43022502afd",
  };

  it("drops a candidate whose IP matches a camera added by hand", async () => {
    discovery({ pending: [PENDING_MANUAL] });
    const { candidates } = await getCameraCandidates(makePrisma([manualRow()]));
    expect(candidates).toEqual([]);
  });

  it("drops a candidate whose MAC matches a managed row, in any letter case, at any IP", async () => {
    discovery({ pending: [PENDING_MANUAL] });
    const { candidates } = await getCameraCandidates(
      makePrisma([
        manualRow({ ipAddress: "192.168.9.10", macAddress: "E4:30:22:50:2A:FD" }),
      ]),
    );
    expect(candidates).toEqual([]);

    discovery({ pending: [{ ...PENDING_MANUAL, mac: "E4:30:22:50:2A:FD" }] });
    const lower = await getCameraCandidates(
      makePrisma([manualRow({ ipAddress: "192.168.9.10", macAddress: "e4:30:22:50:2a:fd" })]),
    );
    expect(lower.candidates).toEqual([]);
  });

  it("drops a candidate matching a camera discovery itself adopted (enabled, autoDiscovered)", async () => {
    discovery({ pending: [PENDING_MANUAL] });
    const { candidates } = await getCameraCandidates(
      makePrisma([
        dbRow({ ipAddress: "192.168.9.219", macAddress: "e4:30:22:50:2a:fd", enabled: true }),
      ]),
    );
    expect(candidates).toEqual([]);
  });

  it("drops a candidate matching a hand-added camera that was switched off", async () => {
    discovery({ pending: [PENDING_MANUAL] });
    const { candidates } = await getCameraCandidates(makePrisma([manualRow({ enabled: false })]));
    expect(candidates).toEqual([]);
  });

  it("keeps a candidate that only resembles a discovery-only row", async () => {
    // enabled=false + autoDiscovered=true is a candidate still being probed, not a camera.
    discovery({ pending: [PENDING_MANUAL] });
    const { candidates } = await getCameraCandidates(
      makePrisma([dbRow({ ipAddress: "192.168.9.219", macAddress: null })]),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].source).toBe("live");
  });

  it("keeps a candidate on a different IP and MAC from every managed row", async () => {
    discovery({ pending: [PENDING_MANUAL] });
    const { candidates } = await getCameraCandidates(
      makePrisma([manualRow({ ipAddress: "192.168.9.10", macAddress: "99:88:77:66:55:44" })]),
    );
    expect(candidates).toHaveLength(1);
  });

  it("does not offer a stale discovery-only row for a camera the operator already has", async () => {
    // Discovery is down, so only DB rows are left to offer. The discovery-only
    // row shares its IP with the managed camera — a leftover duplicate, not a
    // second camera.
    discovery({ pending: new Error("fetch failed"), known: new Error("fetch failed") });
    const { candidates, discoveryOnline } = await getCameraCandidates(
      makePrisma([
        manualRow({ ipAddress: "192.168.9.219" }),
        dbRow({ id: "dup", ipAddress: "192.168.9.219", macAddress: "aa:aa:aa:aa:aa:aa" }),
        dbRow({ id: "other", ipAddress: "192.168.9.60", macAddress: "bb:bb:bb:bb:bb:bb" }),
      ]),
    );
    expect(discoveryOnline).toBe(false);
    expect(candidates.map((c) => c.id)).toEqual(["other"]);
  });

  it("drops a candidate whose IP is the host of a Frigate camera input", async () => {
    fetchConfig.mockResolvedValue(
      frigateConfigWith("rtsp://admin:secret@192.168.9.219:554/stream1"),
    );
    discovery({ pending: [PENDING_MANUAL] });
    // No Camera row at all — Frigate alone says this address is a camera.
    const { candidates } = await getCameraCandidates(makePrisma());
    expect(candidates).toEqual([]);
  });

  it("keeps a candidate on a host no Frigate camera input uses", async () => {
    fetchConfig.mockResolvedValue(frigateConfigWith("rtsp://192.168.9.50/stream1"));
    discovery({ pending: [PENDING_MANUAL] });
    const { candidates } = await getCameraCandidates(makePrisma());
    expect(candidates).toHaveLength(1);
  });

  it("also hides a discovery-only DB row that sits on a Frigate camera host", async () => {
    fetchConfig.mockResolvedValue(frigateConfigWith("rtsp://192.168.9.50/stream1"));
    discovery({ pending: [] });
    const { candidates } = await getCameraCandidates(
      makePrisma([dbRow({ ipAddress: "192.168.9.50" })]),
    );
    expect(candidates).toEqual([]);
  });

  it("treats a failed Frigate read as non-fatal and still lists the candidate", async () => {
    fetchConfig.mockRejectedValue(new Error("Frigate config: 502"));
    discovery({ pending: [PENDING_MANUAL] });
    const { candidates, discoveryOnline } = await getCameraCandidates(makePrisma());
    expect(discoveryOnline).toBe(true);
    expect(candidates).toHaveLength(1);
  });

  it("does not let a stalled Frigate stall the candidate list", async () => {
    // A restarting Frigate can hold the connection open. The list is polled by
    // the dashboard, so the Frigate read gets a short leash.
    vi.useFakeTimers();
    fetchConfig.mockReturnValue(new Promise(() => undefined));
    discovery({ pending: [PENDING_MANUAL] });

    const pending = getCameraCandidates(makePrisma());
    await vi.advanceTimersByTimeAsync(3_000);
    const { candidates } = await pending;

    expect(candidates).toHaveLength(1);
  });
});

describe("mutateLiveCandidate — what camera-discovery is sent", () => {
  // camera-discovery keys its pending map by LOWER-case MAC and looks it up
  // exactly. A candidate id carries the upper-case form (normaliseMac), and the
  // old code forwarded it verbatim — so every ✕ and Add on a discovered camera
  // answered 404 (WARP-3508). The matching test on the other side of this
  // contract is services/camera-discovery/tests/test_camera_key_contract.py.
  /** URL of the most recent request camera-discovery received. */
  function calledUrl(): string {
    return (internalFetch.mock.calls.at(-1) as [string])[0];
  }

  it.each(["accept", "reject"] as const)(
    "sends the MAC lower-case on %s, whatever case the candidate id carried",
    async (action) => {
      internalFetch.mockResolvedValue(new Response("{}", { status: 200 }));

      const result = await mutateLiveCandidate("E4:30:22:50:2A:FD", action);

      expect(result).toEqual({ ok: true, status: 200 });
      expect(calledUrl()).toBe(
        `http://camera-discovery.test:8085/cameras/discovered/e4%3A30%3A22%3A50%3A2a%3Afd/${action}`,
      );
    },
  );

  it("lower-cases the synthetic keys discovery mints for a camera with no lease", async () => {
    // normaliseMac upper-cases these too: `ip:192.168.9.77` arrives as `IP:…`.
    internalFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await mutateLiveCandidate("IP:192.168.9.77", "reject");
    expect(calledUrl()).toContain("/cameras/discovered/ip%3A192.168.9.77/reject");

    internalFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await mutateLiveCandidate("ONVIF_192_168_9_77", "accept");
    expect(calledUrl()).toContain("/cameras/discovered/onvif_192_168_9_77/accept");
  });

  it("still mirrors the upstream status and prose on failure", async () => {
    internalFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Camera not found" }), { status: 404 }),
    );
    expect(await mutateLiveCandidate("E4:30:22:50:2A:FD", "accept")).toEqual({
      ok: false,
      status: 404,
      message: "Camera not found",
    });
  });
});

describe("candidate id helpers", () => {
  it("recognises a live id and extracts its MAC", () => {
    expect(isLiveCandidateId("mac:AA:BB")).toBe(true);
    expect(macFromCandidateId("mac:AA:BB")).toBe("AA:BB");
  });

  it("treats a uuid as a database id", () => {
    expect(isLiveCandidateId("6f0c7f10-6e5b-4a1e-9a2f-1d3c5b7e9f11")).toBe(false);
    expect(macFromCandidateId("6f0c7f10-6e5b-4a1e-9a2f-1d3c5b7e9f11")).toBeNull();
  });
});

describe("submitLiveCandidateCredentials (WARP-3505)", () => {
  it("POSTs the credentials to camera-discovery's credentials route, keyed by lower-case MAC, with the device secret", async () => {
    process.env.DEVICE_SECRET = "test-secret";
    internalFetch.mockResolvedValue(new Response(JSON.stringify({ status: "accepted" }), { status: 200 }));

    const r = await submitLiveCandidateCredentials("E4:30:22:50:2A:FD", "admin", "s3cret!");

    expect(r).toEqual({ ok: true, status: 200 });
    const [url, init] = internalFetch.mock.calls[0];
    expect(url).toBe(
      "http://camera-discovery.test:8085/cameras/discovered/e4%3A30%3A22%3A50%3A2a%3Afd/credentials",
    );
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-secret");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ username: "admin", password: "s3cret!" });
    delete process.env.DEVICE_SECRET;
  });

  it("carries which camera was added (and only that — never a stream URL) so the caller can match its DB row", async () => {
    internalFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "accepted",
          camera: {
            name: "xnv_c8083r",
            ip: "192.168.9.219",
            mac: "e4:30:22:50:2a:fd",
            status: "active",
            rtsp_url: "rtsp://admin:s3cret%21@192.168.9.219:554/profile2/media.smp",
          },
        }),
        { status: 200 },
      ),
    );
    const r = await submitLiveCandidateCredentials("E4:30:22:50:2A:FD", "admin", "s3cret!");
    expect(r).toEqual({
      ok: true,
      status: 200,
      camera: { name: "xnv_c8083r", ip: "192.168.9.219", mac: "e4:30:22:50:2a:fd" },
    });
    expect(JSON.stringify(r)).not.toContain("rtsp");
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });

  it.each([
    ["E4:30:22:50:2A:FD", "e4%3A30%3A22%3A50%3A2a%3Afd"],
    [" E4:30:22:50:2A:FD ", "e4%3A30%3A22%3A50%3A2a%3Afd"], // surrounding whitespace is not part of the key
    ["IP:192.168.9.77", "ip%3A192.168.9.77"], // synthetic keys discovery mints for a camera with no lease
    ["ONVIF_192_168_9_77", "onvif_192_168_9_77"],
  ])("files %j under the key camera-discovery uses (lower-case, trimmed): %s", async (mac, wire) => {
    // The same normalisation accept/reject use (WARP-3508's discoveryKey): one
    // way of talking to camera-discovery about a camera, not one per call.
    internalFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await submitLiveCandidateCredentials(mac, "admin", "s3cret!");
    expect(String(internalFetch.mock.calls[0][0])).toBe(
      `http://camera-discovery.test:8085/cameras/discovered/${wire}/credentials`,
    );
  });

  it.each([
    [422, "auth_failed"],
    [423, "locked"],
    [422, "no_stream_path"],
    [502, "unreachable"],
    [504, "timeout"],
    [400, "invalid_credentials"],
    [400, "unsupported_password"],
    [400, "unsupported_stream_address"],
    [422, "basic_auth_only"],
  ])("carries upstream %i / %s through as a structured failure", async (status, code) => {
    internalFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Operator-facing prose.", code }), { status }),
    );
    const r = await submitLiveCandidateCredentials("AA:BB", "admin", "s3cret!");
    expect(r).toEqual({ ok: false, status, code, message: "Operator-facing prose." });
  });

  it("never reflects the password in a failure result", async () => {
    internalFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: "The camera rejected that username and password.", code: "auth_failed" }), {
        status: 422,
      }),
    );
    const r = await submitLiveCandidateCredentials("AA:BB", "admin", "s3cret!");
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });

  it("tells a timeout apart from camera-discovery being down", async () => {
    // The wait is 60 s; camera-discovery bounds its own work to ~52 s worst
    // case, so this means it hung, not that it is not running. Calling that
    // "Camera discovery isn't running" would send the operator off to fix the
    // wrong thing, and the camera may in fact have been added.
    internalFetch.mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }),
    );
    const r = await submitLiveCandidateCredentials("AA:BB", "admin", "s3cret!");
    expect(r.ok).toBe(false);
    expect(r.code).toBe("timeout");
    expect(r.message).toMatch(/too long/);
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });

  it("reports camera-discovery being down as a 502 unreachable, not a thrown error", async () => {
    internalFetch.mockRejectedValue(new Error("ECONNREFUSED"));
    const r = await submitLiveCandidateCredentials("AA:BB", "admin", "s3cret!");
    expect(r.ok).toBe(false);
    expect(r.status).toBe(502);
    expect(r.code).toBe("discovery_unavailable");
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });
});
