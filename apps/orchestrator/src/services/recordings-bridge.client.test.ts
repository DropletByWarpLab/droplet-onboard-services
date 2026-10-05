import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRecordingsBridge, parseNvrHostStatus, parseNvrMigration } from "./recordings-bridge.client.js";
import { RecordingsError } from "./recordings.types.js";

const HOST = {
  ok: true,
  source: "/mnt/droplet/bay-0a1b2c3d/nvr",
  kind: "path",
  fsUuid: "0a1b2c3d-1111-2222-3333-444455556666",
  mountPath: "/mnt/droplet/bay-0a1b2c3d",
  physicalDisk: "sdb",
  backingDevices: ["sdb", "sdb1", "droplet-bay-ab12cd34"],
  isSystemDisk: false,
  encrypted: true,
  mounted: true,
  rw: true,
  projectId: 4096,
  limitBytes: 100,
  usedBytes: 10,
  fsSizeBytes: 1000,
  fsFreeBytes: 800,
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("recordings bridge client (WARP-3514)", () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const bridge = createRecordingsBridge();

  beforeEach(() => {
    process.env.BRIDGE_AUTH_TOKEN = "unit-test-bridge-secret";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BRIDGE_AUTH_TOKEN;
    delete process.env.SERVICE_TOKEN_DISPLAY;
  });

  it("sends the shared secret on every call and parses the host status", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, HOST));
    const status = await bridge.getNvrStatus();
    expect(status.source).toBe(HOST.source);
    expect(status.kind).toBe("path");
    expect(status.backingDevices).toEqual(HOST.backingDevices);
    expect(status.limitBytes).toBe(100);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toMatch(/\/host\/nvr-storage$/);
    expect((init?.headers as Record<string, string>)["X-Droplet-Auth"]).toBe("unit-test-bridge-secret");
  });

  it("falls back to SERVICE_TOKEN_DISPLAY like routes/storage.ts", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    process.env.SERVICE_TOKEN_DISPLAY = "display-token";
    fetchMock.mockResolvedValueOnce(reply(200, HOST));
    await bridge.getNvrStatus();
    expect(((fetchMock.mock.calls[0]![1]?.headers) as Record<string, string>)["X-Droplet-Auth"]).toBe("display-token");
  });

  it("fails closed with no secret configured — nothing is sent", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    await expect(bridge.getNvrStatus()).rejects.toMatchObject({ code: "bridge_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("apply sends limitBytes for reserved and omits it for full", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, applied: {} }));
    await bridge.applyNvrTarget({ fsUuid: "0a1b2c3d-1111", mode: "reserved", limitBytes: 5_000 });
    await bridge.applyNvrTarget({ fsUuid: "0a1b2c3d-1111", mode: "full", limitBytes: 5_000 });
    const sent = fetchMock.mock.calls.map((c) => JSON.parse(String(c[1]?.body)) as Record<string, unknown>);
    expect(sent[0]).toEqual({ fsUuid: "0a1b2c3d-1111", mode: "reserved", limitBytes: 5_000 });
    expect(sent[1]).toEqual({ fsUuid: "0a1b2c3d-1111", mode: "full" });
    expect(fetchMock.mock.calls[0]![1]?.method).toBe("POST");
  });

  it("resize, migrate, delete hit their endpoints with their bodies", async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true }));
    await bridge.resizeNvr(777);
    await bridge.startMigration("0a1b2c3d-1111");
    await bridge.deleteOldFootage();
    expect(fetchMock.mock.calls.map((c) => [c[0].replace(/^.*\/host/, "/host"), JSON.parse(String(c[1]?.body))])).toEqual([
      ["/host/nvr-storage/resize", { limitBytes: 777 }],
      ["/host/nvr-storage/migrate", { fsUuid: "0a1b2c3d-1111" }],
      ["/host/nvr-storage/old/delete", {}],
    ]);
  });

  it("409 is `busy`, keyed on the status, with the bridge's code kept", async () => {
    fetchMock.mockResolvedValueOnce(reply(409, { ok: false, code: "migration_running", error: "a migration is running" }));
    const err = await bridge.resizeNvr(1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordingsError);
    expect(err).toMatchObject({ code: "busy", hostCode: "migration_running" });
  });

  it("422 is `host_refused` and carries the writer's machine code (never parsed from text)", async () => {
    fetchMock.mockResolvedValueOnce(reply(422, { ok: false, code: "files_not_empty", error: "whatever words" }));
    const err = await bridge.applyNvrTarget({ fsUuid: "0a1b2c3d-1111", mode: "full" }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "host_refused", hostCode: "files_not_empty" });
  });

  it("503 topology refusal remains unavailable with its machine code", async () => {
    fetchMock.mockResolvedValueOnce(reply(503, { ok: false, code: "recordings_status_unavailable", error: "Recording storage could not be verified" }));
    await expect(bridge.applyNvrTarget({ fsUuid: "0a1b2c3d-1111", mode: "full" })).rejects.toMatchObject({
      code: "bridge_unavailable", hostCode: "recordings_status_unavailable",
    });
  });

  it("any other failure status is a plain error with the status attached", async () => {
    fetchMock.mockResolvedValueOnce(reply(502, { ok: false, code: "executor_failed", error: "unit failed" }));
    const err = (await bridge.getNvrStatus().catch((e: unknown) => e)) as Error & { status?: number };
    expect(err).not.toBeInstanceOf(RecordingsError);
    expect(err.status).toBe(502);
  });

  it("a refused connection is `bridge_unavailable`", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    await expect(bridge.getMigration()).rejects.toMatchObject({ code: "bridge_unavailable" });
  });

  it("a malformed status body is an error, not a guess", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { ok: true, source: "nvrdata" }));
    await expect(bridge.getNvrStatus()).rejects.toThrow(/malformed/);
  });

  it("the drives snapshot keeps os_disk and disks, and rejects a body with no drives list", async () => {
    fetchMock.mockResolvedValueOnce(reply(200, { drives: [{ uuid: "x" }], os_disk: "nvme0n1", disks: [{ name: "sdb" }] }));
    await expect(bridge.getDrivesSnapshot()).resolves.toEqual({
      drives: [{ uuid: "x" }],
      os_disk: "nvme0n1",
      disks: [{ name: "sdb" }],
    });
    fetchMock.mockResolvedValueOnce(reply(200, { nope: true }));
    await expect(bridge.getDrivesSnapshot()).rejects.toThrow(/malformed/);
  });
});

describe("parseNvrHostStatus / parseNvrMigration", () => {
  it("unknown numbers become null, not zero (zero would read as 'an empty slice')", () => {
    const s = parseNvrHostStatus({ ...HOST, limitBytes: "lots", usedBytes: null, projectId: undefined });
    expect([s.limitBytes, s.usedBytes, s.projectId]).toEqual([null, null, null]);
  });

  it("migration: idle defaults, clamps the percentage, keeps a validated oldSource", () => {
    expect(parseNvrMigration({ state: "idle" })).toMatchObject({
      state: "idle", job: null, progressPct: 0, bytesCopied: 0, bytesTotal: 0, oldSource: null, error: null,
    });
    const m = parseNvrMigration({
      state: "running", job: "migrate", progressPct: 250, bytesCopied: 5, bytesTotal: 10,
      oldSource: { kind: "volume", source: "nvrdata", bytes: 123, deleted: false },
    });
    expect(m.progressPct).toBe(100);
    expect(m.oldSource).toEqual({ kind: "volume", source: "nvrdata", bytes: 123, deleted: false });
  });

  it("migration: an unknown state is malformed", () => {
    expect(() => parseNvrMigration({ state: "sleeping" })).toThrow(/malformed/);
    expect(() => parseNvrMigration("nope")).toThrow(/malformed/);
  });
});
