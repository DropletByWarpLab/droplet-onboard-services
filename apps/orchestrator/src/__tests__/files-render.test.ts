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
import express from "express";
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
    NcPreconditionFailedError: actual.NcPreconditionFailedError,
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
    ncFetchFileResponse: vi.fn(),
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

vi.mock("../services/file-registry.service.js", async (original) => ({
  ...await original<typeof import("../services/file-registry.service.js")>(),
  resolveFileDepartment: vi.fn().mockResolvedValue(null),
}));
vi.mock("../services/asserted-user.service.js", () => ({ resolveAssertedUser: vi.fn() }));
vi.mock("../services/asserted-nextcloud-login.service.js", () => ({ resolveAssertedNextcloudLogin: vi.fn(), assertedNextcloudLoginRefusal: vi.fn() }));
vi.mock("../services/nextcloud-session.service.js", async (original) => ({
  ...await original<typeof import("../services/nextcloud-session.service.js")>(),
  resolveNcToken: vi.fn(async (req: express.Request) => req.user?.id === "dev" ? "dev-mode-token" : "human-token"),
  getNcToken: vi.fn(),
}));
vi.mock("../middleware/space.js", async (original) => ({
  ...await original<typeof import("../middleware/space.js")>(),
  requireSpaceAccess: vi.fn(() => async (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.spaceDepartmentId = typeof req.query.space === "string" && req.query.space.startsWith("dept:") ? req.query.space.slice(5) : null;
    next();
  }),
  checkSpaceAccess: vi.fn().mockResolvedValue({ allowed: true, departmentId: null }),
}));
vi.mock("../services/cache.service.js", async (original) => ({
  ...await original<typeof import("../services/cache.service.js")>(),
  cacheDel: vi.fn().mockResolvedValue(undefined),
  invalidatePrefix: vi.fn().mockResolvedValue(0),
}));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn().mockResolvedValue(undefined) }));

import { createApp } from "../app.js";
import * as nc from "../services/nextcloud.client.js";
import { initDeviceService } from "../services/device.service.js";
import { config } from "../config.js";
import { createFilesRouter } from "../routes/files.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { resolveAssertedNextcloudLogin } from "../services/asserted-nextcloud-login.service.js";
import { resolveNcToken, getNcToken } from "../services/nextcloud-session.service.js";
import { requireSpaceAccess, checkSpaceAccess } from "../middleware/space.js";
import { cacheDel, invalidatePrefix } from "../services/cache.service.js";
import { recordActivity } from "../services/activity.singleton.js";

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
    vi.mocked(resolveNcToken).mockReset().mockImplementation(async (req) => req.user?.id === "dev" ? "dev-mode-token" : "human-token");
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
      expect.objectContaining({ ifNoneMatch: true }),
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

  // WARP-2523 — the exists? pre-check is a FAST PATH, not the guard. Two
  // concurrent renders (or a render racing a user upload) both read "absent"
  // and the loser clobbered the winner — the WARP-2096 defect reopened as a
  // race. The authoritative guard is `If-None-Match: *` on the PUT itself.
  it("maps a PUT-level 412 to the same already-exists 409 despite a passing pre-check", async () => {
    ncMock.ncGetFileId.mockResolvedValue(null); // pre-check: nothing there…
    // …but by PUT time a concurrent writer won, and the WebDAV
    // If-None-Match: * create answered 412.
    ncMock.ncUploadFile.mockRejectedValue(new nc.NcPreconditionFailedError());

    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/Documents/q3.pdf", format: "pdf", title: "Q3" });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: "file already exists",
      path: "/Documents/q3.pdf",
    });
    // Nothing was written, so none of the post-write bookkeeping may run —
    // the only ncGetFileId call is the pre-check, never the registry lookup.
    expect(ncMock.ncGetFileId).toHaveBeenCalledTimes(1);
  });

  it("sends the create-new option on the render upload", async () => {
    ncMock.ncGetFileId.mockResolvedValueOnce(null).mockResolvedValueOnce(4242);

    await request(app)
      .post("/api/files/render")
      .send({ path: "/Documents/q3.pdf", format: "pdf", title: "Q3" });

    expect(ncMock.ncUploadFile).toHaveBeenCalledWith(
      expect.any(String),
      "dev",
      "/Documents",
      "q3.pdf",
      expect.any(Buffer),
      expect.objectContaining({ ifNoneMatch: true }),
    );
  });

  it("rejects an unknown format", async () => {
    const res = await request(app)
      .post("/api/files/render")
      .send({ path: "/a.rtf", format: "rtf" });
    expect(res.status).toBe(400);
    expect(renderCalls()).toHaveLength(0);
  });

  it.each(["pdf", "pptx"])("forwards structured %s slides and uploads a new file", async (format) => {
    const slides = [{ title: "Summary", bullets: ["Source-backed result"] }];
    const res = await request(app).post("/api/files/render")
      .send({ path: `/Documents/deck.${format}`, format, title: "Review", slides });
    expect(res.status).toBe(200);
    expect(res.body.mimeType).toBe(format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(JSON.parse(renderCalls()[0][1].body)).toMatchObject({ format, title: "Review", slides });
    expect(ncMock.ncUploadFile).toHaveBeenCalledWith(expect.any(String), "dev", "/Documents",
      `deck.${format}`, expect.any(Buffer), { ifNoneMatch: true });
  });

  it("refuses malformed slides before rendering", async () => {
    const res = await request(app).post("/api/files/render")
      .send({ path: "/deck.pdf", format: "pdf", slides: "invalid" });
    expect(res.status).toBe(400);
    expect(renderCalls()).toHaveLength(0);
  });

  it("hydrates an authorized image server-side, streams the result, and confirms the atomic saved path", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZL0AAAAASUVORK5CYII=", "base64");
    ncMock.ncGetFileId.mockImplementation(async (_token, _login, source) => source === "/photo.png" ? 123 : null);
    ncMock.ncFetchFileResponse.mockImplementation(async () => new Response(png));
    fetchMock.mockImplementation(async () => new Response(PDF_BYTES));
    const response = await request(app).post("/api/files/render").send({ path: "/deck.pdf", format: "pdf", slides: [{ title: "Picture", image: { path: "/photo.png", caption: "Authorized source", alt: "Picture" } }] });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ path: "/deck.pdf", bytes: PDF_BYTES.length });
    expect(JSON.parse(renderCalls()[0][1].body).slides).toEqual([{ title: "Picture", image: { content_base64: png.toString("base64"), caption: "Authorized source", alt: "Picture" } }]);
    expect(ncMock.ncFetchFileResponse).toHaveBeenCalledWith("dev-mode-token", "dev", "/photo.png", undefined, expect.any(AbortSignal));
    expect(ncMock.ncUploadFile).toHaveBeenCalledWith("dev-mode-token", "dev", "/", "deck.pdf", PDF_BYTES, { ifNoneMatch: true, signal: expect.any(AbortSignal) });
    expect(JSON.stringify(response.body)).not.toMatch(/content_base64|photo.png/);
  });

  it.each([{ content_base64: "iVBORw0KGgo=" }, { url: "https://example.com/image.png" }, { path: "/../photo.png" }, { path: "/photo.png", item_id: "attachment" }])("refuses untrusted image bytes/URLs/descriptors %j before rendering or saving", async (image) => {
    const response = await request(app).post("/api/files/render").send({ path: "/deck.pdf", format: "pdf", slides: [{ title: "Picture", image }] });
    expect(response.status).toBe(400); expect(renderCalls()).toHaveLength(0);
    expect(ncMock.ncFetchFileResponse).not.toHaveBeenCalled(); expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });

  it("does not invent a saved deck when authorized-image rendering or the final write fails", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZL0AAAAASUVORK5CYII=", "base64");
    ncMock.ncGetFileId.mockImplementation(async (_token, _login, source) => source === "/photo.png" ? 123 : null);
    ncMock.ncFetchFileResponse.mockImplementation(async () => new Response(png));
    fetchMock.mockImplementation(async () => new Response(PDF_BYTES));
    ncMock.ncUploadFile.mockRejectedValue(new nc.NcPreconditionFailedError());
    const response = await request(app).post("/api/files/render").send({ path: "/deck.pdf", format: "pdf", slides: [{ title: "Picture", image: { path: "/photo.png" } }] });
    expect(response.status).toBe(409); expect(response.body).toMatchObject({ error: "file already exists", path: "/deck.pdf" });
    expect(response.body.bytes).toBeUndefined(); expect(response.body.mimeType).toBeUndefined();
  });

  it("maps renderer schema rejection to a spec error without uploading", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 422, json: async () => ({ detail: [{ msg: "wrong type" }] }) });
    const res = await request(app).post("/api/files/render")
      .send({ path: "/deck.pptx", format: "pptx", slides: [{}] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid document spec");
    expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
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

describe("image deck write identity remains current", () => {
  const person = { id: "person1", username: "alice", role: "owner", displayName: "Alice", email: null };
  const service = { id: "_service:mcp", username: "mcp", role: "service" };
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZL0AAAAASUVORK5CYII=", "base64");
  const input = { path: "/deck.pdf", format: "pdf", slides: [{ title: "Picture", image: { path: "/photo.png" } }] };
  function imageApp(user: Pick<typeof person, "id" | "username" | "role"> = person) {
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { Object.assign(req, { user }); next(); });
    const prisma = new PrismaClient();
    Object.assign(prisma, { department: { findUnique: vi.fn().mockResolvedValue({ id: "dept1", name: "Private", kind: "DEPARTMENT", state: "active", parentId: null }) } });
    app.use("/api", createFilesRouter(prisma));
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
    return app;
  }
  beforeEach(() => {
    vi.mocked(resolveAssertedUser).mockReset().mockResolvedValue({ ok: true, user: person });
    vi.mocked(resolveAssertedNextcloudLogin).mockReset().mockResolvedValue({ ok: true, login: "nc-alice", userId: person.id });
    vi.mocked(resolveNcToken).mockReset().mockResolvedValue("human-token");
    vi.mocked(getNcToken).mockReset().mockResolvedValue("fresh-mcp-token");
    vi.mocked(requireSpaceAccess).mockImplementation(() => async (req, _res, next) => {
      req.spaceDepartmentId = typeof req.query.space === "string" && req.query.space.startsWith("dept:") ? req.query.space.slice(5) : null;
      next();
    });
    vi.mocked(checkSpaceAccess).mockReset().mockResolvedValue({ allowed: true, departmentId: null });
    vi.mocked(cacheDel).mockReset().mockResolvedValue(undefined);
    vi.mocked(invalidatePrefix).mockReset().mockResolvedValue(0);
    vi.mocked(recordActivity).mockReset().mockResolvedValue(null);
    for (const key of Object.keys(ncMock)) if (typeof ncMock[key]?.mockReset === "function") ncMock[key].mockReset();
    ncMock.ncGetFileId.mockImplementation(async (_token, _login, path) => path === "/photo.png" ? 123 : null);
    ncMock.ncFetchFileResponse.mockImplementation(async () => new Response(png));
    ncMock.ncUploadFile.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(PDF_BYTES)));
    (config as { DOC_RENDER_SERVICE_TOKEN: string }).DOC_RENDER_SERVICE_TOKEN = "render-token";
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("ignores forged human headers and uses a refreshed session token for the atomic save", async () => {
    vi.mocked(resolveNcToken).mockResolvedValueOnce("initial-human-token").mockResolvedValueOnce("fresh-human-token");
    const response = await request(imageApp()).post("/api/files/render").set("x-nextcloud-user", "victim").set("x-nextcloud-token", "stolen").send(input);
    expect(response.status).toBe(200);
    expect(ncMock.ncFetchFileResponse).toHaveBeenCalledWith("initial-human-token", "alice", "/photo.png", undefined, expect.any(AbortSignal));
    expect(ncMock.ncUploadFile).toHaveBeenCalledWith("fresh-human-token", "alice", "/", "deck.pdf", PDF_BYTES, expect.objectContaining({ ifNoneMatch: true }));
    expect(resolveAssertedNextcloudLogin).not.toHaveBeenCalled();
  });
  it("refuses an actor revoked while the image deck was being rendered", async () => {
    vi.mocked(resolveAssertedUser).mockResolvedValueOnce({ ok: true, user: person }).mockResolvedValueOnce({ ok: true, user: person }).mockResolvedValueOnce({ ok: false, reason: "deactivated" });
    const response = await request(imageApp()).post("/api/files/render").send(input);
    expect(response.status).toBe(403); expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });
  it("refuses a session disconnected while the image deck was being rendered", async () => {
    vi.mocked(resolveNcToken).mockResolvedValueOnce("initial-human-token").mockResolvedValueOnce(null);
    const response = await request(imageApp()).post("/api/files/render").send(input);
    expect(response.status).toBe(401); expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });
  it("resolves MCP to the pinned person and refreshes that person's storage token before saving", async () => {
    const response = await request(imageApp(service)).post("/api/files/render").set("x-nextcloud-user", person.id).set("x-nextcloud-token", "initial-mcp-token").send(input);
    expect(response.status).toBe(200);
    expect(ncMock.ncFetchFileResponse).toHaveBeenCalledWith("initial-mcp-token", "nc-alice", "/photo.png", undefined, expect.any(AbortSignal));
    expect(getNcToken).toHaveBeenCalledWith(person.id);
    expect(ncMock.ncUploadFile).toHaveBeenCalledWith("fresh-mcp-token", "nc-alice", "/", "deck.pdf", PDF_BYTES, expect.anything());
  });
  it("refuses an MCP File Store account remapped during rendering", async () => {
    vi.mocked(resolveAssertedNextcloudLogin).mockResolvedValueOnce({ ok: true, login: "nc-alice", userId: person.id }).mockResolvedValueOnce({ ok: true, login: "new-account", userId: person.id });
    const response = await request(imageApp(service)).post("/api/files/render").set("x-nextcloud-user", person.id).set("x-nextcloud-token", "initial-mcp-token").send(input);
    expect(response.status).toBe(403); expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });
  it("uses the fresh role and rejects a destination contributor grant removed while rendering", async () => {
    vi.mocked(resolveAssertedUser).mockResolvedValueOnce({ ok: true, user: { ...person, role: "admin" } }).mockResolvedValueOnce({ ok: true, user: { ...person, role: "admin" } }).mockResolvedValueOnce({ ok: true, user: { ...person, role: "family" } });
    vi.mocked(checkSpaceAccess).mockResolvedValue({ allowed: false, status: 403, error: "Destination membership removed" });
    const response = await request(imageApp({ ...person, role: "admin" })).post("/api/files/render?space=dept:dept1").send(input);
    expect(response.status).toBe(403);
    expect(checkSpaceAccess).toHaveBeenCalledWith(expect.anything(), expect.anything(), { id: person.id, role: "family" }, "dept1", "contributor");
    expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });
  it.each(["destination grant", "target existence"])("bounds a stalled %s preflight before fetching image bytes", async (step) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = vi.fn();
    if (step === "destination grant") vi.mocked(requireSpaceAccess).mockReturnValue(async () => { entered(); await new Promise(() => {}); });
    else ncMock.ncGetFileId.mockImplementation(() => new Promise(() => {}));
    const result = request(imageApp()).post("/api/files/render").send(input).then((value) => value);
    await vi.waitFor(() => expect(step === "destination grant" ? entered : ncMock.ncGetFileId).toHaveBeenCalled());
    // Give the request's I/O callback a chance to enter the timed handler.
    await vi.advanceTimersByTimeAsync(55_100);
    const response = await result;
    expect(response.status).toBe(408); expect(ncMock.ncFetchFileResponse).not.toHaveBeenCalled(); expect(ncMock.ncUploadFile).not.toHaveBeenCalled();
  });
  it.each(["metadata", "cache", "audit"])("returns a confirmed saved deck when post-PUT %s bookkeeping stalls", async (step) => {
    if (step === "metadata") {
      let targetReads = 0;
      ncMock.ncGetFileId.mockImplementation(async (_token, _login, path) => path === "/photo.png" ? 123 : ++targetReads === 1 ? null : new Promise(() => {}));
    } else if (step === "cache") {
      vi.mocked(cacheDel).mockImplementation(() => new Promise(() => {}));
      vi.mocked(invalidatePrefix).mockImplementation(() => new Promise(() => {}));
    } else vi.mocked(recordActivity).mockImplementation(() => new Promise(() => {}));
    const result = request(imageApp()).post("/api/files/render").send(input).then((value) => value);
    const response = await result;
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ path: "/deck.pdf", bytes: PDF_BYTES.length, mimeType: "application/pdf" });
    expect(ncMock.ncUploadFile).toHaveBeenCalledTimes(1);
  });
});
