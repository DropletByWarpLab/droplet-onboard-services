import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({ config: { AUTH_ENABLED: true } }));
vi.mock("../middleware/rate-limit.js", () => ({ createRateLimit: vi.fn(() => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()) }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), createReadStream: vi.fn() }));
vi.mock("../services/nextcloud.client.js", () => ({ ncFetchFileResponse: vi.fn(), ncUploadFile: vi.fn(), ncGetFileId: vi.fn(), NcPreconditionFailedError: class extends Error {} }));
vi.mock("../services/nextcloud-session.service.js", () => ({ getNcToken: vi.fn(), resolveNcToken: vi.fn() }));
vi.mock("../services/asserted-user.service.js", () => ({ resolveAssertedUser: vi.fn() }));
vi.mock("../services/asserted-nextcloud-login.service.js", () => ({ resolveAssertedNextcloudLogin: vi.fn() }));
vi.mock("../services/file-registry.service.js", () => ({ resolveFileDepartment: vi.fn(), upsertFileRegistryEntry: vi.fn() }));
vi.mock("../middleware/space.js", () => ({ checkSpaceAccess: vi.fn() }));
vi.mock("../services/brain-memory.service.js", () => ({ isPathUnderUser: vi.fn() }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn() }));
vi.mock("../services/cache.service.js", () => ({ invalidatePrefix: vi.fn() }));

import { createOfficeFileRouter } from "../routes/office-file.js";
import { OfficeFileError } from "../services/office-file.client.js";
import { ncFetchFileResponse, ncUploadFile, ncGetFileId, NcPreconditionFailedError } from "../services/nextcloud.client.js";
import { getNcToken, resolveNcToken } from "../services/nextcloud-session.service.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { resolveAssertedNextcloudLogin } from "../services/asserted-nextcloud-login.service.js";
import { resolveFileDepartment, upsertFileRegistryEntry } from "../services/file-registry.service.js";
import { checkSpaceAccess } from "../middleware/space.js";
import { isPathUnderUser } from "../services/brain-memory.service.js";
import { invalidatePrefix } from "../services/cache.service.js";
import { recordActivity } from "../services/activity.singleton.js";

const ZIP = Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(100)]);
const INSPECTION = { format: "docx" as const, paragraphs: [{ id: "word/document.xml:p:0", text: "Original" }], totalItems: 1, returnedItems: 1, truncated: false, warnings: [] };
const INPUT = { action: "revise", source_path: "/original.docx", path: "/revised.docx", changes: { text: [{ id: "word/document.xml:p:0", text: "Revised" }] } };
const SERVICE = { id: "_service:mcp", username: "svc", role: "service" };
const human = { id: "person1", username: "alice", role: "owner" };
const brainMemoryItem = { findUnique: vi.fn() };
const prisma = { brainMemoryItem } as unknown as PrismaClient;
const client = { inspect: vi.fn(), revise: vi.fn() };
function app(user: { id: string; username: string; role: string } | null = human) {
  const result = express(); result.use(express.json());
  result.use((req, _res, next) => { if (user) Object.assign(req, { user }); next(); });
  result.use("/api", createOfficeFileRouter(prisma, client));
  result.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
  return result;
}
beforeEach(() => {
  vi.resetAllMocks();
  client.inspect.mockResolvedValue(INSPECTION); client.revise.mockResolvedValue(ZIP);
  vi.mocked(resolveNcToken).mockResolvedValue("human-token"); vi.mocked(getNcToken).mockResolvedValue("bob-token");
  vi.mocked(ncGetFileId).mockImplementation(async (_token, _login, path) => path === "/original.docx" ? 123 : null);
  vi.mocked(ncFetchFileResponse).mockImplementation(async () => new Response(ZIP));
  vi.mocked(ncUploadFile).mockResolvedValue("created"); vi.mocked(invalidatePrefix).mockResolvedValue(0);
  vi.mocked(resolveFileDepartment).mockResolvedValue(null); vi.mocked(checkSpaceAccess).mockResolvedValue({ allowed: true, departmentId: null });
  vi.mocked(isPathUnderUser).mockReturnValue(true);
  vi.mocked(createReadStream).mockImplementation(() => Readable.from([ZIP]) as ReturnType<typeof createReadStream>);
  brainMemoryItem.findUnique.mockResolvedValue({ userId: "person1", filename: "attached.docx", storagePath: "/brain/person1/attachment", hasOriginalBytes: true, ingestPolicy: "approved" });
  vi.mocked(resolveAssertedUser).mockImplementation(async (_prisma, asserted) => ({ ok: true, user: asserted === "person1" ? { ...human, displayName: "Alice", email: null } : { id: "person2", username: "bob", role: "family", displayName: "Bob", email: null } }));
  vi.mocked(resolveAssertedNextcloudLogin).mockResolvedValue({ ok: true, login: "nc-bob", userId: "person2" });
});

describe("Office actor, read and new-file write boundary", () => {
  it("ignores forged human headers and inspects with caller ACL", async () => {
    const response = await request(app()).post("/api/files/office").set("x-nextcloud-user", "victim").set("x-nextcloud-token", "stolen").send({ source_path: "/original.docx" });
    expect(response.status).toBe(200); expect(response.body).toMatchObject({ action: "inspect", source: { path: "/original.docx" }, paragraphs: INSPECTION.paragraphs });
    expect(ncFetchFileResponse).toHaveBeenCalledWith("human-token", "alice", "/original.docx", undefined, expect.any(AbortSignal));
    expect(client.inspect).toHaveBeenCalledWith(ZIP, "docx", expect.any(AbortSignal));
    expect(ncUploadFile).not.toHaveBeenCalled(); expect(resolveAssertedUser).not.toHaveBeenCalled();
  });
  it("revises to an atomic personal copy, registers the caller UUID and returns a saved card", async () => {
    vi.mocked(ncGetFileId).mockResolvedValueOnce(123).mockResolvedValueOnce(null).mockResolvedValueOnce(456);
    const response = await request(app()).post("/api/files/office").send(INPUT);
    expect(response.status).toBe(200); expect(response.body.media).toMatchObject({ kind: "file", path: "/revised.docx", size: ZIP.length });
    expect(client.revise).toHaveBeenCalledWith(ZIP, "docx", INPUT.changes, expect.any(AbortSignal));
    expect(resolveAssertedUser).toHaveBeenCalledWith(prisma, "person1");
    expect(ncUploadFile).toHaveBeenCalledWith("human-token", "alice", "/", "revised.docx", ZIP, { ifNoneMatch: true, signal: expect.any(AbortSignal) });
    expect(upsertFileRegistryEntry).toHaveBeenCalledWith(prisma, expect.objectContaining({ ownerUserId: "person1", path: "/revised.docx", departmentId: null, ncFileId: 456 }));
    expect(JSON.stringify(response.body)).not.toContain("contentBase64");
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: "user", id: "person1" } }));
  });
  it("resolves pinned MCP identity to canonical File Store login and owner", async () => {
    const response = await request(app(SERVICE)).post("/api/files/office").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "bob-token").send(INPUT);
    expect(response.status).toBe(200); expect(resolveNcToken).not.toHaveBeenCalled();
    expect(resolveAssertedUser).toHaveBeenCalledWith(prisma, "bob"); expect(resolveAssertedUser).toHaveBeenCalledWith(prisma, "person2");
    expect(getNcToken).toHaveBeenCalledWith("person2");
    expect(ncFetchFileResponse).toHaveBeenCalledWith("bob-token", "nc-bob", "/original.docx", undefined, expect.any(AbortSignal));
    expect(ncUploadFile).toHaveBeenCalledWith("bob-token", "nc-bob", "/", "revised.docx", ZIP, expect.anything());
  });
  it.each([null, { id: "guest", username: "guest", role: "guest" }, { id: "_service:other", username: "other", role: "service" }])("denies unapproved principals %j", async (user) => {
    expect((await request(app(user)).post("/api/files/office").send(INPUT)).status).toBe(403); expect(client.revise).not.toHaveBeenCalled(); expect(ncFetchFileResponse).not.toHaveBeenCalled();
  });
  it.each(["not_found", "ambiguous", "deactivated"] as const)("denies %s asserted people", async (reason) => {
    vi.mocked(resolveAssertedUser).mockResolvedValue({ ok: false, reason });
    expect((await request(app(SERVICE)).post("/api/files/office").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "token").send(INPUT)).status).toBe(403); expect(client.revise).not.toHaveBeenCalled();
  });
  it("denies a mismatched canonical File Store account", async () => {
    vi.mocked(resolveAssertedNextcloudLogin).mockResolvedValue({ ok: true, userId: "victim", login: "victim" });
    expect((await request(app(SERVICE)).post("/api/files/office").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "token").send(INPUT)).status).toBe(403); expect(ncFetchFileResponse).not.toHaveBeenCalled();
  });
  it("checks department reader grants before source bytes are read", async () => {
    vi.mocked(resolveFileDepartment).mockResolvedValue("dept1"); vi.mocked(checkSpaceAccess).mockResolvedValue({ allowed: false, status: 403, error: "Space access denied." });
    expect((await request(app()).post("/api/files/office").send(INPUT)).status).toBe(403);
    expect(checkSpaceAccess).toHaveBeenCalledWith(prisma, expect.anything(), { id: "person1", role: "owner" }, "dept1", "reader");
    expect(ncFetchFileResponse).not.toHaveBeenCalled();
  });
  it("inspects an owned approved attachment without File Store credentials", async () => {
    vi.mocked(resolveNcToken).mockResolvedValue(null);
    const response = await request(app()).post("/api/files/office").send({ item_id: "attachment1" });
    expect(response.status).toBe(200); expect(isPathUnderUser).toHaveBeenCalledWith("person1", "/brain/person1/attachment");
    expect(client.inspect).toHaveBeenCalledWith(ZIP, "docx", expect.any(AbortSignal)); expect(ncFetchFileResponse).not.toHaveBeenCalled();
  });
  it.each(["foreign", "missing-bytes", "unsafe-path", "pending"])("refuses %s attachment before opening it", async (kind) => {
    if (kind === "foreign") brainMemoryItem.findUnique.mockResolvedValue({ userId: "victim", hasOriginalBytes: true });
    if (kind === "missing-bytes") brainMemoryItem.findUnique.mockResolvedValue({ userId: "person1", hasOriginalBytes: false });
    if (kind === "unsafe-path") vi.mocked(isPathUnderUser).mockReturnValue(false);
    if (kind === "pending") brainMemoryItem.findUnique.mockResolvedValue({ userId: "person1", filename: "x.docx", hasOriginalBytes: true, storagePath: "/brain/person1/attachment", ingestPolicy: "await_approval" });
    expect((await request(app()).post("/api/files/office").send({ item_id: "attachment1" })).status).toBe(kind === "pending" ? 409 : 404); expect(createReadStream).not.toHaveBeenCalled(); expect(client.inspect).not.toHaveBeenCalled();
  });
  it.each(["session", "role", "mapping"])("rechecks %s before a revision write", async (kind) => {
    if (kind === "session") vi.mocked(getNcToken).mockResolvedValue(null);
    if (kind === "role") vi.mocked(resolveAssertedUser).mockResolvedValueOnce({ ok: true, user: { id: "person2", username: "bob", role: "family", displayName: "Bob", email: null } }).mockResolvedValueOnce({ ok: false, reason: "deactivated" });
    if (kind === "mapping") vi.mocked(resolveAssertedNextcloudLogin).mockResolvedValueOnce({ ok: true, userId: "person2", login: "nc-bob" }).mockResolvedValueOnce({ ok: true, userId: "person2", login: "changed" });
    const response = await request(app(SERVICE)).post("/api/files/office").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "bob-token").send(INPUT);
    expect(response.status).toBe(kind === "session" ? 401 : 403); expect(client.revise).toHaveBeenCalledTimes(1); expect(ncUploadFile).not.toHaveBeenCalled();
  });
});

describe("Office bounded processing and refusal semantics", () => {
  it.each([{}, { source_path: "/original.docx", item_id: "attachment1" }, { source_path: "/original.docx", path: "/x.docx" }, { ...INPUT, path: "/Dept/revised.docx" }, { ...INPUT, path: "/%2fhidden.docx" }, { ...INPUT, changes: { text: [] } }, { ...INPUT, action: "execute" }])("refuses invalid payload %j", async (payload) => {
    expect((await request(app()).post("/api/files/office").send(payload)).status).toBe(400); expect(client.inspect).not.toHaveBeenCalled(); expect(client.revise).not.toHaveBeenCalled();
  });
  it.each(["/original.docx", "/revised.xlsx"])("refuses same-source or mismatched destination %s", async (path) => {
    expect((await request(app()).post("/api/files/office").send({ ...INPUT, path })).status).toBe(400); expect(ncUploadFile).not.toHaveBeenCalled();
  });
  it("refuses existing destinations early and concurrent writers atomically", async () => {
    vi.mocked(ncGetFileId).mockResolvedValueOnce(123).mockResolvedValueOnce(456);
    expect((await request(app()).post("/api/files/office").send(INPUT)).status).toBe(409); expect(client.revise).not.toHaveBeenCalled();
    vi.mocked(ncUploadFile).mockRejectedValueOnce(new NcPreconditionFailedError());
    expect((await request(app()).post("/api/files/office").send(INPUT)).status).toBe(409); expect(upsertFileRegistryEntry).not.toHaveBeenCalled();
  });
  it.each([["INVALID_FILE", 400], ["TOO_LARGE", 413], ["TIMEOUT", 408], ["UNAVAILABLE", 503]] as const)("preserves %s processing failures", async (code, status) => {
    client.revise.mockRejectedValue(new OfficeFileError(code, "A readable reason."));
    const response = await request(app()).post("/api/files/office").send(INPUT);
    expect(response.status).toBe(status); expect(response.body.error).toBe("A readable reason."); expect(ncUploadFile).not.toHaveBeenCalled();
  });
  it("caps source streams before calling the processor", async () => {
    vi.mocked(ncFetchFileResponse).mockResolvedValue(new Response(new Uint8Array(10 * 1024 * 1024 + 1)));
    expect((await request(app()).post("/api/files/office").send(INPUT)).status).toBe(413); expect(client.revise).not.toHaveBeenCalled();
  });
  it("returns saved metadata when registry bookkeeping fails", async () => {
    vi.mocked(ncGetFileId).mockResolvedValueOnce(123).mockResolvedValueOnce(null).mockResolvedValueOnce(456);
    vi.mocked(upsertFileRegistryEntry).mockRejectedValueOnce(new Error("metadata unavailable"));
    const response = await request(app()).post("/api/files/office").send(INPUT);
    expect(response.status).toBe(200); expect(response.body.warnings).toContain("The file was saved; metadata registration is pending."); expect(response.body.media.path).toBe(INPUT.path);
  });
});
