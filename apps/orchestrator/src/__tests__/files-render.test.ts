/**
 * WARP-2211 — POST /api/files/render.
 *
 * The policy front for services/doc-render. What matters here is not that it
 * proxies, but that it refuses correctly:
 *
 *   - It will NOT overwrite. The plain upload path silently clobbers a
 *     same-name file (WARP-2096), and a model asked twice for "Q3 summary"
 *     has no way to know the first one exists. A 409 with the path is what
 *     lets it pick another name.
 *   - It fails CLOSED when the service bearer is missing, rather than calling
 *     the renderer unauthenticated.
 *   - A 400 from the renderer is the CALLER's bad spec and keeps its reason;
 *     only genuine upstream faults collapse to 502.
 *
 * Mock scaffolding mirrors files.test.ts.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { PrismaClient } from "@prisma/client";

vi.mock("../services/ai-gateway.client.js", () => ({
  healthCheck: vi.fn().mockResolvedValue(true),
  listModels: vi.fn().mockResolvedValue({ models: [] }),
  chat: vi.fn(),
  saveKey: vi.fn(),
  listKeys: vi.fn().mockResolvedValue([]),
  deleteKey: vi.fn(),
}));

vi.mock("../config.js", () => ({
  config: {
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    PORT: 3000,
    NODE_ENV: "test",
    MAX_UPLOAD_SIZE_MB: 10,
    NEXTCLOUD_URL: "http://nextcloud.test",
    AUTH_ENABLED: false,
    DROPLET_SHARED_FOLDER_NAME: "Household",
    FRIGATE_URL: "http://frigate:5000",
    DOC_RENDER_URL: "http://doc-render:8020",
    DOC_RENDER_SERVICE_TOKEN: "render-token",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/nextcloud.client.js", async () => {
  const actual = await vi.importActual<typeof import("../services/nextcloud.client.js")>(
    "../services/nextcloud.client.js",
  );
  return {
    NextcloudOcsError: actual.NextcloudOcsError,
    ncListFiles: vi.fn(),
    ncUploadFile: vi.fn(),
    ncDownloadFile: vi.fn(),
    ncDeleteFile: vi.fn(),
    ncCreateDirectory: vi.fn(),
    ncCreateShare: vi.fn(),
    ncListShares: vi.fn(),
    ncMoveFile: vi.fn(),
    ncCopyFile: vi.fn(),
    ncGetFileId: vi.fn(),
    ncListTrash: vi.fn(),
    ncRestoreTrashItem: vi.fn(),
    ncDeleteTrashItem: vi.fn(),
    ncEmptyTrash: vi.fn(),
    ncListVersions: vi.fn(),
    ncRestoreVersion: vi.fn(),
    ncSetFavorite: vi.fn(),
    ncListFavorites: vi.fn(),
    ncSearchFiles: vi.fn(),
    ncListRecents: vi.fn(),
    ncFetchThumbnail: vi.fn(),
    ncCreateShareV2: vi.fn(),
    ncUpdateShare: vi.fn(),
    ncDeleteShare: vi.fn(),
    ncListSharedWithMe: vi.fn(),
    ncGetUserQuota: vi.fn(),
  };
});

import { createApp } from "../app.js";
import * as nc from "../services/nextcloud.client.js";
import { initDeviceService } from "../services/device.service.js";
import { config } from "../config.js";

const ncMock = nc as unknown as Record<string, ReturnType<typeof vi.fn>>;

const PDF_BYTES = Buffer.from("%PDF-1.4 fake");

function renderOk(bytes: Buffer = PDF_BYTES) {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

describe("POST /api/files/render (WARP-2211)", () => {
  let app: ReturnType<typeof createApp>;
  const fetchMock = vi.fn();

  /**
   * Only the calls that went to doc-render. Stubbing global fetch also
   * catches unrelated app traffic, so "did not call the renderer" has to be
   * asked about the renderer specifically or it is a false pass.
   */
  const renderCalls = () =>
    fetchMock.mock.calls.filter(([u]) => String(u).includes("/render"));

  beforeAll(() => {
    const prisma = new PrismaClient();
    initDeviceService(prisma);
    app = createApp(prisma);
  });

  beforeEach(() => {
    for (const key of Object.keys(ncMock)) {
      if (typeof ncMock[key]?.mockReset === "function") ncMock[key].mockReset();
    }
    // No file at the target unless a test says otherwise.
    ncMock.ncGetFileId.mockResolvedValue(null);
    ncMock.ncUploadFile.mockResolvedValue(undefined);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(renderOk());
    vi.stubGlobal("fetch", fetchMock);
    (config as { DOC_RENDER_SERVICE_TOKEN: string }).DOC_RENDER_SERVICE_TOKEN =
      "render-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders, uploads, and returns the path and size", async () => {
    ncMock.ncGetFileId.mockResolvedValueOnce(null).mockResolvedValueOnce(4242);

    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/Documents/q3.pdf", format: "pdf", title: "Q3", body_markdown: "# H" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      path: "/Documents/q3.pdf",
      filename: "q3.pdf",
      bytes: PDF_BYTES.byteLength,
      mimeType: "application/pdf",
    });
    expect(ncMock.ncUploadFile).toHaveBeenCalledWith(
      expect.any(String),
      "dev",
      "/Documents",
      "q3.pdf",
      expect.any(Buffer),
    );
  });

  it("sends the spec upstream with the service bearer", async () => {
    await request(app)
      .post("/api/files/render")
      .send({ path: "/a.xlsx", format: "xlsx", sheets: [{ columns: ["A"], rows: [] }] });

    // Stubbing global fetch catches unrelated app traffic (the display
    // sidecar, for one), so select OUR call rather than assuming it is first.
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/render"));
    expect(call, "no request reached doc-render").toBeDefined();
    const [url, init] = call!;
    expect(url).toBe("http://doc-render:8020/render");
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe(
      "Bearer render-token",
    );
    expect(JSON.parse((init as { body: string }).body)).toMatchObject({
      format: "xlsx",
      sheets: [{ columns: ["A"], rows: [] }],
    });
  });

  it("refuses to overwrite an existing file, and names it", async () => {
    ncMock.ncGetFileId.mockResolvedValue(99);

    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/Documents/q3.pdf", format: "pdf", title: "Q3" });

    expect(res.status).toBe(409);
    expect(res.body.path).toBe("/Documents/q3.pdf");
    // And it never rendered — the refusal is before the work.
    expect(renderCalls()).toHaveLength(0);
    expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });

  it("rejects an unknown format", async () => {
    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/a.rtf", format: "rtf" });
    expect(res.status).toBe(400);
    expect(renderCalls()).toHaveLength(0);
  });

  it("rejects a path whose extension contradicts the format", async () => {
    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/Documents/q3.txt", format: "pdf", title: "Q3" });
    expect(res.status).toBe(400);
    expect(renderCalls()).toHaveLength(0);
  });

  it("rejects a filename that tries to traverse", async () => {
    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/Documents/", format: "pdf", title: "Q3" });
    expect(res.status).toBe(400);
  });

  it("fails closed with 502 when the service bearer is unset", async () => {
    (config as { DOC_RENDER_SERVICE_TOKEN: string }).DOC_RENDER_SERVICE_TOKEN = "";

    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/a.pdf", format: "pdf", title: "T" });

    expect(res.status).toBe(502);
    // Never called the renderer unauthenticated.
    expect(renderCalls()).toHaveLength(0);
  });

  it("passes a renderer 400 through with its reason", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ detail: "at least one sheet is required" }),
    });

    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/a.xlsx", format: "xlsx", sheets: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("at least one sheet is required");
    expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });

  it("collapses a genuine upstream fault to 502", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });

    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/a.pdf", format: "pdf", title: "T" });

    expect(res.status).toBe(502);
    expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });

  it("502s when the renderer is unreachable, without writing anything", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/a.pdf", format: "pdf", title: "T" });

    expect(res.status).toBe(502);
    expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });
});
