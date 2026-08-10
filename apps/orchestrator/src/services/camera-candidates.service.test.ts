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
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { CAMERA_DISCOVERY_URL: "http://camera-discovery.test:8085" },
}));

const internalFetch = vi.fn();
vi.mock("../lib/internal-tls.js", () => ({
  internalFetch: (...args: unknown[]) => internalFetch(...args),
  internalBaseUrl: (url: string) => url,
}));

import {
  deriveCandidateStatus,
  getCameraCandidates,
  isLiveCandidateId,
  macFromCandidateId,
  redactRtspCredentials,
} from "./camera-candidates.service.js";

type DbRow = {
  id: string;
  name: string;
  displayName: string;
  manufacturer: string | null;
  model: string | null;
  ipAddress: string;
  macAddress: string | null;
  createdAt: Date;
};

function makePrisma(rows: DbRow[] = []) {
  return {
    camera: { findMany: vi.fn().mockResolvedValue(rows) },
  } as unknown as Parameters<typeof getCameraCandidates>[0];
}

function dbRow(over: Partial<DbRow> = {}): DbRow {
  return {
    id: "db-1",
    name: "old_cam",
    displayName: "Old Cam",
    manufacturer: null,
    model: null,
    ipAddress: "192.168.9.50",
    macAddress: "AA:BB:CC:DD:EE:FF",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...over,
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
  rtsp_url: "rtsp://admin:Droplet123%21@192.168.9.219:554/profile2/media.smp",
  status: "needs_setup",
  detection_method: "rtsp_default_credentials",
};

beforeEach(() => {
  internalFetch.mockReset();
});

describe("redactRtspCredentials", () => {
  it("strips embedded credentials and reports that they existed", () => {
    expect(
      redactRtspCredentials("rtsp://admin:Droplet123%21@192.168.9.219:554/profile2/media.smp"),
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
    expect(JSON.stringify(cam)).not.toContain("Droplet123");
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
