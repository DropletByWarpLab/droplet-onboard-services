import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { Readable } from "node:stream";

vi.mock("../config.js", () => ({ config: { AUTH_ENABLED: true } }));
vi.mock("../services/nextcloud.client.js", () => ({
  ncFetchFileResponse: vi.fn(), ncUploadFile: vi.fn(), ncCreateDirectory: vi.fn(), ncGetFileId: vi.fn(),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({ getNcToken: vi.fn(), resolveNcToken: vi.fn() }));
vi.mock("../services/asserted-user.service.js", () => ({ resolveAssertedUser: vi.fn() }));
vi.mock("../services/asserted-nextcloud-login.service.js", () => ({ resolveAssertedNextcloudLogin: vi.fn() }));
vi.mock("../services/brain-memory.service.js", () => ({ isPathUnderUser: vi.fn() }));
vi.mock("../services/file-registry.service.js", () => ({ resolveFileDepartment: vi.fn(), upsertFileRegistryEntry: vi.fn() }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn() }));
vi.mock("../services/activity.service.js", () => ({ actorFromRequest: vi.fn(() => ({ type: "user", userId: "user1" })) }));
vi.mock("../services/cache.service.js", () => ({ invalidatePrefix: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../middleware/space.js", () => ({ checkSpaceAccess: vi.fn() }));
vi.mock("node:fs", async () => ({ ...(await vi.importActual<typeof import("node:fs")>("node:fs")), createReadStream: vi.fn(() => Readable.from([Buffer.from("name,amount\nA,10\n")])) }));

import { createDataAnalysisRouter } from "../routes/data-analysis.js";
import * as nc from "../services/nextcloud.client.js";
import { getNcToken, resolveNcToken } from "../services/nextcloud-session.service.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { resolveAssertedNextcloudLogin } from "../services/asserted-nextcloud-login.service.js";
import { resolveFileDepartment, upsertFileRegistryEntry } from "../services/file-registry.service.js";
import { checkSpaceAccess } from "../middleware/space.js";
import { isPathUnderUser } from "../services/brain-memory.service.js";
import { SandboxError } from "../services/sandbox.client.js";

const findItem = vi.fn();
const prisma = { brainMemoryItem: { findUnique: findItem } } as unknown as PrismaClient;
const analyze = vi.fn();
const RESULT = { output: { total: 30 }, stdout: "read 2 rows", stdoutTruncated: false, sources: [], warnings: [], artifacts: [] };
function app(user: { id: string; username: string; role: string } | null = { id: "user1", username: "alice", role: "owner" }) {
  const result = express();
  result.use(express.json());
  result.use((req, _res, next) => { if (user) Object.assign(req, { user }); next(); });
  result.use("/api", createDataAnalysisRouter(prisma, { analyze }));
  result.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
  return result;
}
beforeEach(() => {
  vi.clearAllMocks();
  analyze.mockResolvedValue(RESULT);
  vi.mocked(resolveNcToken).mockResolvedValue("session-token");
  vi.mocked(getNcToken).mockResolvedValue("bob-token");
  vi.mocked(nc.ncGetFileId).mockResolvedValue(123);
  vi.mocked(nc.ncFetchFileResponse).mockImplementation(async () => new Response("name,amount\nA,10\n"));
  vi.mocked(nc.ncUploadFile).mockResolvedValue("created");
  vi.mocked(nc.ncCreateDirectory).mockResolvedValue();
  vi.mocked(resolveFileDepartment).mockResolvedValue(null);
  vi.mocked(isPathUnderUser).mockReturnValue(true);
  vi.mocked(resolveAssertedUser).mockImplementation(async (_prisma, asserted) => ({ ok: true, user: asserted === "user1" ? { id: "user1", username: "alice", role: "owner", displayName: "Alice", email: null } : { id: "person2", username: "bob", role: "family", displayName: "Bob", email: null } }));
  vi.mocked(resolveAssertedNextcloudLogin).mockResolvedValue({ ok: true, login: "nc-bob", userId: "person2" });
});

describe("data analysis actor and source boundary", () => {
  it("runs pure computation without file credentials and refuses guest/anonymous", async () => {
    vi.mocked(resolveNcToken).mockResolvedValue(null);
    expect((await request(app()).post("/api/files/analyze").send({ code: "output=42", inputs: { n: 42 } })).body.output).toEqual({ total: 30 });
    expect((await request(app({ id: "g", username: "g", role: "guest" })).post("/api/files/analyze").send({ code: "output=1" })).status).toBe(403);
    expect((await request(app(null)).post("/api/files/analyze").send({ code: "output=1" })).status).toBe(403);
  });
  it("fetches CSV server-side as the human and ignores forged account headers", async () => {
    const response = await request(app()).post("/api/files/analyze").set("x-nextcloud-token", "stolen").set("x-nextcloud-user", "someone-else").send({ code: "output=1", sources: [{ path: "/sales.csv" }] });
    expect(response.status).toBe(200);
    expect(nc.ncFetchFileResponse).toHaveBeenCalledWith("session-token", "alice", "/sales.csv", undefined, expect.any(AbortSignal));
    expect(analyze).toHaveBeenCalledWith("output=1", {}, [{ name: "sales.csv", format: "csv", contentBase64: Buffer.from("name,amount\nA,10\n").toString("base64") }], expect.any(AbortSignal));
    expect(JSON.stringify(analyze.mock.calls)).not.toContain("session-token");
  });
  it("gates department data before retrieving bytes", async () => {
    vi.mocked(resolveFileDepartment).mockResolvedValue("department1");
    vi.mocked(checkSpaceAccess).mockResolvedValue({ allowed: false, status: 403, error: "No reader grant" });
    const response = await request(app()).post("/api/files/analyze").send({ code: "output=1", sources: [{ path: "/Dept/sales.xlsx" }] });
    expect(response.status).toBe(403);
    expect(nc.ncFetchFileResponse).not.toHaveBeenCalled();
    expect(analyze).not.toHaveBeenCalled();
  });
  it("accepts an owned CSV attachment, conceals other people's attachments and honors approval holds", async () => {
    findItem.mockResolvedValue({ userId: "user1", filename: "upload.csv", storagePath: "/brain/user1/file", hasOriginalBytes: true, ingestPolicy: "auto_embed" });
    expect((await request(app()).post("/api/files/analyze").send({ code: "output=1", sources: [{ item_id: "item1" }] })).status).toBe(200);
    expect(analyze.mock.calls[0][2][0].name).toBe("upload.csv");
    findItem.mockResolvedValue({ userId: "other", filename: "upload.csv" });
    expect((await request(app()).post("/api/files/analyze").send({ code: "output=1", sources: [{ item_id: "item1" }] })).status).toBe(404);
    findItem.mockResolvedValue({ userId: "user1", filename: "upload.csv", storagePath: "/brain/user1/file", hasOriginalBytes: true, ingestPolicy: "await_approval" });
    expect((await request(app()).post("/api/files/analyze").send({ code: "output=1", sources: [{ item_id: "item1" }] })).status).toBe(409);
  });
  it("fails malformed source references and source byte excess before Python runs", async () => {
    expect((await request(app()).post("/api/files/analyze").send({ code: "output=1", sources: [{ path: "/a.csv", item_id: "item1" }] })).status).toBe(400);
    vi.mocked(nc.ncFetchFileResponse).mockResolvedValue(new Response(new Uint8Array(3 * 1024 * 1024 + 1)));
    const response = await request(app()).post("/api/files/analyze").send({ code: "output=1", sources: [{ path: "/a.csv" }] });
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("exceeds");
    expect(analyze).not.toHaveBeenCalled();
  });
  it("re-resolves pinned MCP actors and refuses inactive/low-privilege assertions", async () => {
    const service = app({ id: "_service:mcp", username: "svc", role: "service" });
    vi.mocked(resolveAssertedUser).mockResolvedValueOnce({ ok: false, reason: "deactivated" });
    expect((await request(service).post("/api/files/analyze").set("x-nextcloud-user", "bob").send({ code: "output=1" })).status).toBe(403);
    vi.mocked(resolveAssertedUser).mockResolvedValueOnce({ ok: true, user: { id: "person2", username: "bob", role: "guest", displayName: "Bob", email: null } });
    expect((await request(service).post("/api/files/analyze").set("x-nextcloud-user", "bob").send({ code: "output=1" })).status).toBe(403);
    expect(analyze).not.toHaveBeenCalled();
  });
});

describe("data analysis artifact handoff", () => {
  const csv = { name: "summary.csv", mimeType: "text/csv", contentBase64: Buffer.from("metric,value\ntotal,30\n").toString("base64") };
  it("atomically saves into fresh private paths as the resolved actor and returns cards without byte payloads", async () => {
    analyze.mockResolvedValue({ ...RESULT, artifacts: [csv] });
    const response = await request(app({ id: "_service:mcp", username: "svc", role: "service" })).post("/api/files/analyze").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "bob-token").send({ code: "output=1" });
    expect(response.status).toBe(200);
    const path = response.body.artifacts[0].path;
    expect(path).toMatch(/^\/Analysis-[a-f0-9-]+\/summary.csv$/);
    expect(nc.ncUploadFile).toHaveBeenCalledWith("bob-token", "nc-bob", expect.stringMatching(/^\/Analysis-/), "summary.csv", expect.any(Buffer), { ifNoneMatch: true, signal: expect.any(AbortSignal) });
    expect(upsertFileRegistryEntry).toHaveBeenCalledWith(prisma, expect.objectContaining({ ownerUserId: "person2", departmentId: null, path }));
    expect(response.body.media[0]).toMatchObject({ kind: "file", path, mimeType: "text/csv" });
    expect(response.body.artifacts[0]).not.toHaveProperty("contentBase64");
  });
  it("validates every artifact before writing, so invalid active content cannot partially save", async () => {
    analyze.mockResolvedValue({ ...RESULT, artifacts: [csv, { ...csv, name: "evil.html" }] });
    expect((await request(app()).post("/api/files/analyze").send({ code: "output=1" })).status).toBe(502);
    expect(nc.ncCreateDirectory).not.toHaveBeenCalled();
    expect(nc.ncUploadFile).not.toHaveBeenCalled();
  });
  it("refuses artifact writes if the actor is revoked while Python runs", async () => {
    analyze.mockImplementationOnce(async () => {
      vi.mocked(resolveAssertedUser).mockResolvedValue({ ok: false, reason: "deactivated" });
      return { ...RESULT, artifacts: [csv] };
    });
    const response = await request(app()).post("/api/files/analyze").send({ code: "output=1" });
    expect(response.status).toBe(403);
    expect(nc.ncCreateDirectory).not.toHaveBeenCalled();
    expect(nc.ncUploadFile).not.toHaveBeenCalled();
  });
  it("refuses artifact writes if the caller's file session is revoked", async () => {
    analyze.mockResolvedValue({ ...RESULT, artifacts: [csv] });
    vi.mocked(getNcToken).mockResolvedValue(null);
    const response = await request(app({ id: "_service:mcp", username: "svc", role: "service" })).post("/api/files/analyze").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "stale-token").send({ code: "output=1" });
    expect(response.status).toBe(401);
    expect(nc.ncCreateDirectory).not.toHaveBeenCalled();
    expect(nc.ncUploadFile).not.toHaveBeenCalled();
  });
  it("reports partial save failures without claiming a nonexistent artifact", async () => {
    analyze.mockResolvedValue({ ...RESULT, artifacts: [csv] });
    vi.mocked(nc.ncUploadFile).mockRejectedValueOnce(new Error("disk full"));
    const response = await request(app()).post("/api/files/analyze").send({ code: "output=1" });
    expect(response.status).toBe(200);
    expect(response.body.artifacts).toEqual([]);
    expect(response.body.media).toEqual([]);
    expect(response.body.artifactErrors).toEqual([{ name: "summary.csv", error: expect.stringContaining("storage did not confirm") }]);
  });
  it("preserves acknowledged artifacts and completes remaining saves when metadata stalls", async () => {
    analyze.mockResolvedValue({ ...RESULT, artifacts: [csv, { ...csv, name: "second.csv" }] });
    vi.mocked(nc.ncGetFileId).mockImplementation(() => new Promise(() => {}));
    const response = await request(app()).post("/api/files/analyze").send({ code: "output=1" });
    expect(response.status).toBe(200);
    expect(nc.ncUploadFile).toHaveBeenCalledTimes(2);
    expect(response.body.artifacts.map((a: { name: string }) => a.name)).toEqual(["summary.csv", "second.csv"]);
    expect(response.body.media).toHaveLength(2);
    expect(response.body.warnings).toHaveLength(2);
  }, 10_000);
  it("preserves timeout and missing deployment configuration errors", async () => {
    analyze.mockRejectedValueOnce(new SandboxError("sandbox not configured", "NOT_CONFIGURED"));
    expect((await request(app()).post("/api/files/analyze").send({ code: "output=1" })).status).toBe(503);
    analyze.mockRejectedValueOnce(new SandboxError("timeout", "TIMEOUT"));
    expect((await request(app()).post("/api/files/analyze").send({ code: "output=1" })).status).toBe(408);
  });
});
