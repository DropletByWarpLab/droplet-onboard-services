import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { MediaGenerationJob, PrismaClient } from "@prisma/client";

vi.mock("../../config.js", () => ({ config: { AUTH_ENABLED: true } }));
vi.mock("../../middleware/rate-limit.js", () => ({ createRateLimit: vi.fn(() => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()) }));
vi.mock("../../middleware/space.js", () => ({ checkSpaceAccess: vi.fn() }));
vi.mock("../../services/nextcloud.client.js", () => ({ ncUploadFile: vi.fn(), ncGetFileId: vi.fn(), ncFetchFileResponse: vi.fn(), NcPreconditionFailedError: class extends Error {} }));
vi.mock("../../services/nextcloud-session.service.js", () => ({ getNcToken: vi.fn(), resolveNcToken: vi.fn() }));
vi.mock("../../services/asserted-user.service.js", () => ({ resolveAssertedUser: vi.fn() }));
vi.mock("../../services/asserted-nextcloud-login.service.js", () => ({ resolveAssertedNextcloudLogin: vi.fn() }));
vi.mock("../../services/file-registry.service.js", () => ({ resolveFileDepartment: vi.fn(), upsertFileRegistryEntry: vi.fn() }));
vi.mock("../../services/activity.singleton.js", () => ({ recordActivity: vi.fn() }));
vi.mock("../../services/cache.service.js", () => ({ invalidatePrefix: vi.fn() }));

import { createMediaGenerationRouter } from "../media-generation.js";
import { MediaGenerationError, type GeneratedMedia } from "../../services/media-generation.client.js";
import { UnsafePathError } from "../../lib/unsafe-path-error.js";
import { checkSpaceAccess } from "../../middleware/space.js";
import { ncUploadFile, ncGetFileId, ncFetchFileResponse, NcPreconditionFailedError } from "../../services/nextcloud.client.js";
import { getNcToken, resolveNcToken } from "../../services/nextcloud-session.service.js";
import { resolveAssertedUser } from "../../services/asserted-user.service.js";
import { resolveAssertedNextcloudLogin } from "../../services/asserted-nextcloud-login.service.js";
import { resolveFileDepartment, upsertFileRegistryEntry } from "../../services/file-registry.service.js";
import { invalidatePrefix } from "../../services/cache.service.js";
import { recordActivity } from "../../services/activity.singleton.js";

const OWNER = { id: "person1", username: "alice", role: "owner" };
const SERVICE = { id: "_service:mcp", username: "svc", role: "service" };
const ID = "f85e7f97-a1f6-4a14-ae6c-45d5112145ef";
const INPUT = { path: "/picture.png", kind: "image", prompt: "A private illustration", options: { seed: 123 } };
const OUTPUT: GeneratedMedia = { bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mimeType: "image/png", seed: 123, engine: "sdxl" };
type Person = typeof OWNER & { directoryStatus: string; nextcloudUsername: string | null };
type Where = { id?: string; ownerUserId?: string; status?: string | { in: string[] }; deadlineAt?: { lte?: Date; gt?: Date } };
const people = new Map<string, Person>();
const jobs = new Map<string, MediaGenerationJob>();
function matches(job: MediaGenerationJob, where: Where) {
  return (!where.id || job.id === where.id) && (!where.ownerUserId || job.ownerUserId === where.ownerUserId) && (!where.status || (typeof where.status === "string" ? job.status === where.status : where.status.in.includes(job.status))) && (!where.deadlineAt?.lte || job.deadlineAt <= where.deadlineAt.lte) && (!where.deadlineAt?.gt || job.deadlineAt > where.deadlineAt.gt);
}
const db = {
  user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => { const person = people.get(where.id); return person ? { ...person } : null; }) },
  mediaGenerationJob: {
    create: vi.fn(async ({ data }: { data: Pick<MediaGenerationJob, "ownerUserId" | "kind" | "path" | "deadlineAt"> }) => { const job: MediaGenerationJob = { ...data, id: ID, status: "running", result: null, error: null, createdAt: new Date(), updatedAt: new Date() }; jobs.set(job.id, job); return { ...job }; }),
    updateMany: vi.fn(async ({ where, data }: { where: Where; data: Partial<MediaGenerationJob> }) => { let count = 0; for (const job of jobs.values()) if (matches(job, where)) { Object.assign(job, data); count++; } return { count }; }),
    count: vi.fn(async ({ where }: { where: Where }) => [...jobs.values()].filter((job) => matches(job, where)).length),
    findFirst: vi.fn(async ({ where }: { where: Where }) => { const job = [...jobs.values()].find((row) => matches(row, where)); return job ? { ...job } : null; }),
    findMany: vi.fn(async ({ where, take }: { where: Where; take: number }) => [...jobs.values()].filter((job) => matches(job, where)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, take).map((job) => ({ ...job }))),
  },
};
const prisma = db as unknown as PrismaClient;
const capabilities = vi.fn();
const render = vi.fn();
function app(user: typeof OWNER | null = OWNER) {
  const server = express(); server.use(express.json({ limit: "1mb" }));
  server.use((req, _res, next) => { if (user) Object.assign(req, { user }); next(); });
  server.use("/api", createMediaGenerationRouter(prisma, { capabilities, render }));
  server.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
  return server;
}
function seeded(extra: Partial<MediaGenerationJob> = {}): MediaGenerationJob {
  const job: MediaGenerationJob = { id: ID, ownerUserId: OWNER.id, kind: "image", path: INPUT.path, status: "running", result: null, error: null, deadlineAt: new Date(Date.now() + 180_000), createdAt: new Date(), updatedAt: new Date(), ...extra }; jobs.set(job.id, job); return job;
}
async function terminal(status: string = "succeeded") { await vi.waitFor(() => expect(jobs.get(ID)?.status).toBe(status)); }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
beforeEach(() => {
  vi.clearAllMocks(); jobs.clear(); people.clear();
  people.set(OWNER.id, { ...OWNER, directoryStatus: "LOCAL", nextcloudUsername: "alice" });
  people.set("person2", { id: "person2", username: "bob", role: "family", directoryStatus: "LOCAL", nextcloudUsername: "nc-bob" });
  db.user.findUnique.mockReset().mockImplementation(async ({ where }) => { const person = people.get(where.id); return person ? { ...person } : null; });
  db.mediaGenerationJob.create.mockReset().mockImplementation(async ({ data }) => { const job: MediaGenerationJob = { ...data, id: ID, status: "running", result: null, error: null, createdAt: new Date(), updatedAt: new Date() }; jobs.set(ID, job); return { ...job }; });
  db.mediaGenerationJob.updateMany.mockReset().mockImplementation(async ({ where, data }) => { let count = 0; for (const job of jobs.values()) if (matches(job, where)) { Object.assign(job, data); count++; } return { count }; });
  capabilities.mockReset().mockResolvedValue({ image: true, video: true }); render.mockReset().mockResolvedValue(OUTPUT);
  vi.mocked(resolveNcToken).mockReset().mockResolvedValue("submit-token"); vi.mocked(getNcToken).mockReset().mockResolvedValue("fresh-token");
  vi.mocked(ncGetFileId).mockReset().mockImplementation(async (_token, _login, path) => path === INPUT.path && vi.mocked(ncUploadFile).mock.calls.length === 0 ? null : 123);
  vi.mocked(ncUploadFile).mockReset().mockResolvedValue("created");
  vi.mocked(ncFetchFileResponse).mockReset().mockImplementation(async () => new Response(new Uint8Array(OUTPUT.bytes)) as Awaited<ReturnType<typeof ncFetchFileResponse>>);
  vi.mocked(resolveFileDepartment).mockReset().mockResolvedValue(null); vi.mocked(checkSpaceAccess).mockReset().mockResolvedValue({ allowed: true, departmentId: "dept" });
  vi.mocked(upsertFileRegistryEntry).mockReset().mockResolvedValue(undefined); vi.mocked(invalidatePrefix).mockReset().mockResolvedValue(0);
  vi.mocked(resolveAssertedUser).mockReset().mockResolvedValue({ ok: true, user: { id: "person2", username: "bob", role: "family", displayName: "Bob", email: null } });
  vi.mocked(resolveAssertedNextcloudLogin).mockReset().mockResolvedValue({ ok: true, userId: "person2", login: "nc-bob" });
});
afterEach(() => vi.restoreAllMocks());

describe("media jobs: actor and saved-file boundary", () => {
  it("ignores forged browser assertions, returns a pending job, then saves with fresh credentials", async () => {
    const generated = deferred<GeneratedMedia>(); render.mockReturnValue(generated.promise);
    const server = app(); const submit = await request(server).post("/api/files/media").set("x-nextcloud-user", "victim").set("x-nextcloud-token", "stolen").send(INPUT);
    expect(submit.status).toBe(202); expect(submit.body).toMatchObject({ id: ID, path: INPUT.path, status: "running", media: { kind: "media_job", jobId: ID, statusUrl: `/api/files/media/${ID}` } });
    expect(submit.body).not.toHaveProperty("bytes"); expect(ncUploadFile).not.toHaveBeenCalled(); expect(resolveAssertedUser).not.toHaveBeenCalled();
    expect(db.mediaGenerationJob.create).toHaveBeenCalledWith({ data: { ownerUserId: OWNER.id, kind: "image", path: INPUT.path, deadlineAt: expect.any(Date) } });
    expect(JSON.stringify(db.mediaGenerationJob.create.mock.calls)).not.toContain(INPUT.prompt);
    generated.resolve(OUTPUT); await terminal();
    expect(ncUploadFile).toHaveBeenCalledWith("fresh-token", "alice", "/", "picture.png", OUTPUT.bytes, { ifNoneMatch: true, signal: expect.any(AbortSignal) });
    expect(upsertFileRegistryEntry).toHaveBeenCalledWith(prisma, { ncFileId: 123, ownerUserId: OWNER.id, path: INPUT.path, departmentId: null, sizeBytes: 8, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(getNcToken).toHaveBeenCalledTimes(2); expect(getNcToken).toHaveBeenCalledWith(OWNER.id);
    const status = await request(server).get(`/api/files/media/${ID}`);
    expect(status.body).toMatchObject({ status: "succeeded", bytes: 8, mimeType: "image/png", seed: 123, engine: "sdxl", media: { kind: "file", path: INPUT.path, size: 8 } });
    expect(status.body).not.toHaveProperty("prompt"); expect(status.body).not.toHaveProperty("ownerUserId");
    expect(JSON.stringify(status.body)).not.toContain("token");
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: "user", id: OWNER.id }, refs: { path: INPUT.path, bytes: 8 } }));
  });
  it("resolves the pinned MCP actor to its canonical File Store login and local UUID", async () => {
    const response = await request(app(SERVICE)).post("/api/files/media").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "mcp-token").send(INPUT);
    expect(response.status).toBe(202); await terminal();
    expect(resolveNcToken).not.toHaveBeenCalled(); expect(resolveAssertedUser).toHaveBeenCalledWith(prisma, "bob"); expect(resolveAssertedNextcloudLogin).toHaveBeenCalledWith(prisma, "bob");
    expect(ncGetFileId).toHaveBeenCalledWith("mcp-token", "nc-bob", INPUT.path, expect.any(AbortSignal));
    expect(ncUploadFile).toHaveBeenCalledWith("fresh-token", "nc-bob", "/", "picture.png", OUTPUT.bytes, expect.anything());
    expect(jobs.get(ID)?.ownerUserId).toBe("person2"); expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: "ai", id: "person2" } }));
  });
  it.each([null, { id: "guest", username: "guest", role: "guest" }, { id: "_service:other", username: "svc", role: "service" }, { id: "_service:mcp", username: "svc", role: "guest" }])("refuses unapproved principal %j", async (person) => {
    expect((await request(app(person)).post("/api/files/media").send(INPUT)).status).toBe(403); expect(render).not.toHaveBeenCalled(); expect(db.mediaGenerationJob.create).not.toHaveBeenCalled();
  });
  it.each(["not_found", "ambiguous", "deactivated"] as const)("refuses %s MCP assertions", async (reason) => {
    vi.mocked(resolveAssertedUser).mockResolvedValue({ ok: false, reason });
    expect((await request(app(SERVICE)).post("/api/files/media").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "token").send(INPUT)).status).toBe(403); expect(capabilities).not.toHaveBeenCalled();
  });
  it("rejects absent/mismatched MCP storage accounts", async () => {
    vi.mocked(resolveAssertedNextcloudLogin).mockResolvedValueOnce({ ok: false, reason: "no_nextcloud_account" }).mockResolvedValueOnce({ ok: true, userId: "other-person", login: "other" });
    const server = app(SERVICE);
    for (let n = 0; n < 2; n++) expect((await request(server).post("/api/files/media").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "token").send(INPUT)).status).toBe(403);
    expect(render).not.toHaveBeenCalled();
  });
  it("requires a live background file session before creating a job", async () => {
    vi.mocked(getNcToken).mockResolvedValue(null);
    expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(401); expect(capabilities).not.toHaveBeenCalled();
    vi.mocked(getNcToken).mockResolvedValue("live"); vi.mocked(resolveNcToken).mockResolvedValue(null);
    expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(401);
    expect((await request(app(SERVICE)).post("/api/files/media").set("x-nextcloud-user", "bob").send(INPUT)).status).toBe(401); expect(render).not.toHaveBeenCalled();
  });
  it.each(["deactivated", "downgraded", "deleted", "logged-out", "login-changed"])("rechecks %s after inference before writing", async (reason) => {
    const generated = deferred<GeneratedMedia>(); render.mockReturnValue(generated.promise);
    expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(202);
    if (reason === "deleted") people.delete(OWNER.id);
    else if (reason === "logged-out") vi.mocked(getNcToken).mockResolvedValue(null);
    else Object.assign(people.get(OWNER.id)!, reason === "deactivated" ? { directoryStatus: "DEACTIVATED" } : reason === "downgraded" ? { role: "guest" } : { username: "other" });
    generated.resolve(OUTPUT); await terminal("failed"); expect(ncUploadFile).not.toHaveBeenCalled(); expect(jobs.get(ID)?.error).toMatch(/expired|disabled|changed/);
  });
  it("never falls back to username when an MCP account mapping is removed", async () => {
    const generated = deferred<GeneratedMedia>(); render.mockReturnValue(generated.promise);
    vi.mocked(resolveAssertedNextcloudLogin).mockResolvedValue({ ok: true, userId: "person2", login: "bob" }); people.get("person2")!.nextcloudUsername = "bob";
    expect((await request(app(SERVICE)).post("/api/files/media").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "token").send(INPUT)).status).toBe(202);
    people.get("person2")!.nextcloudUsername = null; generated.resolve(OUTPUT); await terminal("failed"); expect(ncUploadFile).not.toHaveBeenCalled();
  });
});

describe("media job input and output constraints", () => {
  it.each(["picture.png", "/nested/picture.png", "/../picture.png", "/%2e%2e.png", "/picture\\name.png", "/picture\0.png", "/picture.png/", "/.png", "/picture.mp4"])("refuses invalid image destinations %s", async (path) => {
    expect((await request(app()).post("/api/files/media").send({ ...INPUT, path })).status).toBe(400); expect(render).not.toHaveBeenCalled();
  });
  it.each([{ prompt: "" }, { prompt: "  " }, { prompt: "x".repeat(4001) }, { kind: "audio" }, { source_path: "/../source.png" }, { source_path: "/source%2fsecret.png" }, { source_path: "https://evil/image.png" }, { source_path: "/two//source.png" }, { mask_path: "/mask.png" }, { options: { width: 640, height: 600 } }, { options: { width: 256 } }, { options: { seed: -1 } }, { options: { frames: 17 } }, { url: "https://evil" }])("refuses invalid local-only arguments %j", async (change) => {
    expect((await request(app()).post("/api/files/media").send({ ...INPUT, ...change })).status).toBe(400); expect(db.mediaGenerationJob.create).not.toHaveBeenCalled();
  });
  it("passes video defaults and explicit options to the local engine", async () => {
    render.mockResolvedValue({ ...OUTPUT, mimeType: "video/mp4", engine: "wan" });
    vi.mocked(ncGetFileId).mockResolvedValue(null);
    expect((await request(app()).post("/api/files/media").send({ path: "/clip.mp4", kind: "video", prompt: "Ocean waves", options: { seed: 123 } })).status).toBe(202); await terminal();
    expect(render).toHaveBeenCalledWith({ kind: "video", prompt: "Ocean waves", width: 512, height: 512, steps: 20, seed: 123, frames: 17, fps: 16 }, expect.any(AbortSignal));
    expect(jobs.get(ID)!.deadlineAt.getTime() - jobs.get(ID)!.createdAt.getTime()).toBeGreaterThan(350_000);
  });
  it("checks each source's department reader access before fetching bytes", async () => {
    vi.mocked(resolveFileDepartment).mockResolvedValue("dept");
    const response = await request(app(SERVICE)).post("/api/files/media").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "source-token").send({ ...INPUT, source_path: "/Team/source.png", mask_path: "/mask.webp" });
    expect(response.status).toBe(202); await terminal();
    expect(checkSpaceAccess).toHaveBeenCalledTimes(2); expect(checkSpaceAccess).toHaveBeenCalledWith(prisma, expect.anything(), expect.objectContaining({ id: "person2", role: "family" }), "dept", "reader");
    expect(ncFetchFileResponse).toHaveBeenCalledWith("source-token", "nc-bob", "/Team/source.png", undefined, expect.any(AbortSignal));
    expect(render).toHaveBeenCalledWith(expect.objectContaining({ source_base64: OUTPUT.bytes.toString("base64"), mask_base64: OUTPUT.bytes.toString("base64") }), expect.any(AbortSignal));
    expect(JSON.stringify(render.mock.calls)).not.toContain("source-token");
  });
  it("refuses inaccessible and oversized sources before creating the job", async () => {
    vi.mocked(resolveFileDepartment).mockResolvedValue("dept"); vi.mocked(checkSpaceAccess).mockResolvedValue({ allowed: false, status: 403, error: "Access revoked" });
    expect((await request(app()).post("/api/files/media").send({ ...INPUT, source_path: "/Team/source.png" })).status).toBe(403); expect(ncFetchFileResponse).not.toHaveBeenCalled();
    vi.mocked(resolveFileDepartment).mockResolvedValue(null); vi.mocked(ncFetchFileResponse).mockResolvedValue(new Response(new Uint8Array(4 * 1024 * 1024 + 1)) as Awaited<ReturnType<typeof ncFetchFileResponse>>);
    expect((await request(app()).post("/api/files/media").send({ ...INPUT, source_path: "/source.png" })).status).toBe(413); expect(db.mediaGenerationJob.create).not.toHaveBeenCalled();
  });
  it("returns missing/unsupported/unsafe source errors without writing", async () => {
    const server = app();
    expect((await request(server).post("/api/files/media").send({ ...INPUT, source_path: "/source.gif" })).status).toBe(400);
    vi.mocked(ncGetFileId).mockResolvedValue(null);
    expect((await request(server).post("/api/files/media").send({ ...INPUT, source_path: "/source.png" })).status).toBe(404);
    vi.mocked(ncGetFileId).mockRejectedValue(new UnsafePathError());
    expect((await request(server).post("/api/files/media").send({ ...INPUT, source_path: "/source.png" })).status).toBe(400); expect(db.mediaGenerationJob.create).not.toHaveBeenCalled();
  });
  it("checks existence early and refuses a racing writer atomically", async () => {
    vi.mocked(ncGetFileId).mockResolvedValue(456);
    expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(409); expect(render).not.toHaveBeenCalled();
    vi.mocked(ncGetFileId).mockResolvedValue(null); vi.mocked(ncUploadFile).mockRejectedValue(new NcPreconditionFailedError());
    expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(202); await terminal("failed"); expect(jobs.get(ID)?.error).toMatch(/already exists/); expect(upsertFileRegistryEntry).not.toHaveBeenCalled();
  });
  it("fails missing models before saving any durable job", async () => {
    capabilities.mockResolvedValue({ image: false, video: false });
    expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(503); expect(db.mediaGenerationJob.create).not.toHaveBeenCalled();
  });
  it("preserves safe engine failures and conceals arbitrary diagnostics", async () => {
    render.mockRejectedValueOnce(new MediaGenerationError(503, "NOT_CONFIGURED", "Install the local model first."));
    expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(202); await terminal("failed"); expect(jobs.get(ID)?.error).toBe("Install the local model first.");
    jobs.clear(); render.mockRejectedValueOnce(new Error("secret prompt library traceback"));
    expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(202); await terminal("failed"); expect(jobs.get(ID)?.error).not.toContain("secret"); expect(ncUploadFile).not.toHaveBeenCalled();
  });
  it.each(["metadata", "registry", "cache"])("keeps acknowledged saved-file metadata during a %s outage", async (failed) => {
    vi.mocked(ncGetFileId).mockResolvedValueOnce(null).mockResolvedValue(123);
    if (failed === "registry") vi.mocked(upsertFileRegistryEntry).mockRejectedValue(new Error("Registry down"));
    if (failed === "cache") vi.mocked(invalidatePrefix).mockRejectedValue(new Error("Cache down"));
    if (failed === "metadata") vi.mocked(ncGetFileId).mockReset().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("PROPFIND down"));
    expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(202); await terminal();
    const result = jobs.get(ID)!.result as Record<string, unknown>;
    expect(result.media).toMatchObject({ kind: "file", path: INPUT.path }); expect(ncUploadFile).toHaveBeenCalledTimes(1);
    if (failed !== "cache") expect(result.warnings).toEqual([expect.stringContaining("registration is pending")]);
  });
});

describe("media jobs: ownership, cancellation and deadlines", () => {
  it("hides foreign jobs equally for status/cancel and scopes listing to the caller", async () => {
    seeded({ ownerUserId: "person2" }); const server = app();
    expect((await request(server).get(`/api/files/media/${ID}`)).status).toBe(404);
    expect((await request(server).post(`/api/files/media/${ID}/cancel`)).status).toBe(404);
    expect((await request(server).get("/api/files/media/not-a-uuid")).status).toBe(404);
    expect((await request(server).get("/api/files/media")).body).toEqual({ jobs: [] });
    expect(db.mediaGenerationJob.findMany).toHaveBeenCalledWith({ where: { ownerUserId: OWNER.id }, orderBy: { createdAt: "desc" }, take: 20 }); expect(jobs.get(ID)?.status).toBe("running");
  });
  it("rechecks live actor state even on polling and cancellation", async () => {
    seeded(); people.get(OWNER.id)!.directoryStatus = "DEACTIVATED"; const server = app();
    expect((await request(server).get(`/api/files/media/${ID}`)).status).toBe(403); expect((await request(server).get("/api/files/media")).status).toBe(403); expect((await request(server).post(`/api/files/media/${ID}/cancel`)).status).toBe(403);
    expect(db.mediaGenerationJob.findFirst).not.toHaveBeenCalled(); expect(db.mediaGenerationJob.findMany).not.toHaveBeenCalled();
  });
  it("aborts a pending render, never uploads it, and releases the inference slot", async () => {
    const generated = deferred<GeneratedMedia>(); render.mockReturnValueOnce(generated.promise); const server = app();
    expect((await request(server).post("/api/files/media").send(INPUT)).status).toBe(202);
    expect((await request(server).post("/api/files/media").send(INPUT)).status).toBe(429);
    const result = await request(server).post(`/api/files/media/${ID}/cancel`);
    expect(result.status).toBe(200); expect(result.body.status).toBe("cancelled"); expect(result.body).not.toHaveProperty("media");
    expect((render.mock.calls[0][1] as AbortSignal).aborted).toBe(true); generated.resolve(OUTPUT); await new Promise((resolve) => setImmediate(resolve)); expect(ncUploadFile).not.toHaveBeenCalled();
    expect((await request(server).post("/api/files/media").send(INPUT)).status).toBe(202); await terminal();
  });
  it("closes cancellation before the atomic save begins", async () => {
    const uploaded = deferred<Awaited<ReturnType<typeof ncUploadFile>>>(); vi.mocked(ncUploadFile).mockReturnValue(uploaded.promise); const server = app();
    expect((await request(server).post("/api/files/media").send(INPUT)).status).toBe(202); await terminal("saving");
    expect((await request(server).post(`/api/files/media/${ID}/cancel`)).status).toBe(409); expect(jobs.get(ID)?.status).toBe("saving");
    uploaded.resolve("created"); await terminal();
  });
  it("refuses cancellation if a competing save claimed the state first", async () => {
    seeded(); const update = db.mediaGenerationJob.updateMany.getMockImplementation()!;
    db.mediaGenerationJob.updateMany.mockImplementation(async (args) => { if (args.data.status === "cancelled") jobs.get(ID)!.status = "saving"; return update(args); });
    expect((await request(app()).post(`/api/files/media/${ID}/cancel`)).status).toBe(409); expect(jobs.get(ID)?.status).toBe("saving");
  });
  it("expires abandoned jobs without replaying prompts or inference", async () => {
    seeded({ deadlineAt: new Date(Date.now() - 1) }); const result = await request(app()).get(`/api/files/media/${ID}`);
    expect(result.body.status).toBe("failed"); expect(result.body.error).toMatch(/restarted/); expect(result.body).not.toHaveProperty("media"); expect(render).not.toHaveBeenCalled();
  });
  it("refuses durable active slots and the database uniqueness race", async () => {
    seeded(); expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(429); expect(render).not.toHaveBeenCalled();
    jobs.clear(); db.mediaGenerationJob.create.mockRejectedValueOnce(Object.assign(new Error("active slot"), { code: "P2002" }));
    expect((await request(app()).post("/api/files/media").send(INPUT)).status).toBe(429); expect(render).not.toHaveBeenCalled();
  });
  it("bounds polling even when the database never resolves", async () => {
    const controller = new AbortController(); const original = AbortSignal.timeout;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => ms === 10_000 ? controller.signal : original(ms));
    db.user.findUnique.mockReturnValueOnce(new Promise(() => {}));
    const pending = request(app()).get("/api/files/media").then((r) => r); await vi.waitFor(() => expect(db.user.findUnique).toHaveBeenCalled()); controller.abort();
    expect((await pending).status).toBe(408); expect(db.mediaGenerationJob.findMany).not.toHaveBeenCalled();
  });
  it("bounds submit and frees its slot when an actor lookup hangs", async () => {
    const controller = new AbortController(); const original = AbortSignal.timeout;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => ms === 20_000 ? controller.signal : original(ms));
    db.user.findUnique.mockReturnValueOnce(new Promise(() => {})); const server = app();
    const pending = request(server).post("/api/files/media").send(INPUT).then((r) => r); await vi.waitFor(() => expect(db.user.findUnique).toHaveBeenCalled()); controller.abort(); expect((await pending).status).toBe(408);
    vi.mocked(AbortSignal.timeout).mockRestore(); expect((await request(server).post("/api/files/media").send(INPUT)).status).toBe(202); await terminal();
  });
  it("bounds stalled post-save bookkeeping and reconciles deadline expiry using the storage acknowledgement", async () => {
    const controller = new AbortController(); const original = AbortSignal.timeout;
    let bookkeeping = true;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => { if (ms === 3000 && bookkeeping) { bookkeeping = false; return controller.signal; } return original(ms); });
    vi.mocked(ncGetFileId).mockResolvedValueOnce(null).mockReturnValueOnce(new Promise(() => {})); const server = app();
    expect((await request(server).post("/api/files/media").send(INPUT)).status).toBe(202); await vi.waitFor(() => expect(ncGetFileId).toHaveBeenCalledTimes(2));
    jobs.get(ID)!.deadlineAt = new Date(Date.now() - 1);
    expect((await request(server).get(`/api/files/media/${ID}`)).body.status).toBe("failed");
    controller.abort(); await terminal(); const result = jobs.get(ID)!.result as Record<string, unknown>;
    expect(result.warnings).toEqual([expect.stringContaining("registration is pending")]); expect(result.media).toMatchObject({ kind: "file", path: INPUT.path }); expect(ncUploadFile).toHaveBeenCalledTimes(1);
  });
  it("releases the local slot even when failure bookkeeping never resolves", async () => {
    const cleanup = new AbortController(); const original = AbortSignal.timeout;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => ms === 3000 ? cleanup.signal : original(ms));
    const update = db.mediaGenerationJob.updateMany.getMockImplementation()!;
    db.mediaGenerationJob.updateMany.mockImplementation((args) => args.data.status === "failed" && args.where.id === ID ? new Promise(() => {}) : update(args));
    render.mockRejectedValueOnce(new Error("failure")); const server = app();
    expect((await request(server).post("/api/files/media").send(INPUT)).status).toBe(202); await vi.waitFor(() => expect(db.mediaGenerationJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "failed" }) })));
    cleanup.abort(); await new Promise((resolve) => setImmediate(resolve)); jobs.clear(); vi.mocked(AbortSignal.timeout).mockRestore(); db.mediaGenerationJob.updateMany.mockImplementation(update);
    expect((await request(server).post("/api/files/media").send(INPUT)).status).toBe(202); await terminal();
  });
  it("aborts inference at its durable deadline without saving or retaining the local slot", async () => {
    db.mediaGenerationJob.create.mockImplementationOnce(async ({ data }) => { const job = seeded({ ...data, deadlineAt: new Date(Date.now() + 100) }); return { ...job }; });
    render.mockReturnValueOnce(new Promise(() => {})); const server = app();
    expect((await request(server).post("/api/files/media").send(INPUT)).status).toBe(202); await terminal("failed");
    expect((render.mock.calls[0][1] as AbortSignal).aborted).toBe(true); expect(ncUploadFile).not.toHaveBeenCalled(); expect(jobs.get(ID)?.error).toMatch(/deadline/);
    jobs.clear(); expect((await request(server).post("/api/files/media").send(INPUT)).status).toBe(202); await terminal();
  });
});
