import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({ config: { AUTH_ENABLED: true } }));
vi.mock("../middleware/rate-limit.js", () => ({ createRateLimit: vi.fn(() => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()) }));
vi.mock("../services/nextcloud.client.js", () => ({ ncUploadFile: vi.fn(), ncGetFileId: vi.fn(), NcPreconditionFailedError: class extends Error {} }));
vi.mock("../services/nextcloud-session.service.js", () => ({ getNcToken: vi.fn(), resolveNcToken: vi.fn() }));
vi.mock("../services/asserted-user.service.js", () => ({ resolveAssertedUser: vi.fn() }));
vi.mock("../services/asserted-nextcloud-login.service.js", () => ({ resolveAssertedNextcloudLogin: vi.fn() }));
vi.mock("../services/file-registry.service.js", () => ({ upsertFileRegistryEntry: vi.fn() }));
vi.mock("../services/activity.singleton.js", () => ({ recordActivity: vi.fn() }));
vi.mock("../services/cache.service.js", () => ({ invalidatePrefix: vi.fn().mockResolvedValue(undefined) }));

import { createAudioRouter } from "../routes/audio-creation.js";
import { TtsUnavailableError } from "../services/tts.client.js";
import { ncUploadFile, ncGetFileId, NcPreconditionFailedError } from "../services/nextcloud.client.js";
import { getNcToken, resolveNcToken } from "../services/nextcloud-session.service.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { resolveAssertedNextcloudLogin } from "../services/asserted-nextcloud-login.service.js";
import { upsertFileRegistryEntry } from "../services/file-registry.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { invalidatePrefix } from "../services/cache.service.js";

const prisma = {} as PrismaClient;
const synthesize = vi.fn();
const INPUT = { path: "/narration.wav", text: "Hello from Droplet", voice: "af_heart" };
const WAV = Buffer.alloc(48);
WAV.write("RIFF"); WAV.writeUInt32LE(40, 4); WAV.write("WAVEfmt ", 8); WAV.writeUInt32LE(16, 16); WAV.writeUInt16LE(1, 20); WAV.writeUInt16LE(1, 22); WAV.writeUInt32LE(24000, 24); WAV.writeUInt32LE(48000, 28); WAV.writeUInt16LE(2, 32); WAV.writeUInt16LE(16, 34); WAV.write("data", 36); WAV.writeUInt32LE(4, 40);
const AUDIO = { wav: WAV, sampleRate: 24000, durationSeconds: 4 / 48000, voice: "af_heart" };
const SERVICE = { id: "_service:mcp", username: "svc", role: "service" };
function app(user: { id: string; username: string; role: string } | null = { id: "person1", username: "alice", role: "owner" }) {
  const result = express(); result.use(express.json());
  result.use((req, _res, next) => { if (user) Object.assign(req, { user }); next(); });
  result.use("/api", createAudioRouter(prisma, "tcp://kokoro-tts:10200", synthesize));
  result.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(500).json({ error: error.message }));
  return result;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(invalidatePrefix).mockResolvedValue(0);
  vi.mocked(upsertFileRegistryEntry).mockResolvedValue(undefined);
  synthesize.mockResolvedValue(AUDIO);
  vi.mocked(resolveNcToken).mockResolvedValue("human-token");
  vi.mocked(getNcToken).mockResolvedValue("bob-token");
  vi.mocked(ncGetFileId).mockResolvedValueOnce(null).mockResolvedValue(123);
  vi.mocked(ncUploadFile).mockResolvedValue("created");
  vi.mocked(resolveAssertedUser).mockImplementation(async (_prisma, asserted) => ({ ok: true, user: asserted === "person1" ? { id: "person1", username: "alice", role: "owner", displayName: "Alice", email: null } : { id: "person2", username: "bob", role: "family", displayName: "Bob", email: null } }));
  vi.mocked(resolveAssertedNextcloudLogin).mockResolvedValue({ ok: true, login: "nc-bob", userId: "person2" });
});

describe("speech actor and storage boundary", () => {
  it("ignores forged human assertion headers, saves as the caller and returns only saved metadata", async () => {
    const response = await request(app()).post("/api/files/audio").set("x-nextcloud-user", "victim").set("x-nextcloud-token", "stolen").send(INPUT);
    expect(response.status).toBe(200);
    expect(resolveAssertedUser).toHaveBeenCalledExactlyOnceWith(prisma, "person1");
    expect(synthesize).toHaveBeenCalledWith({ url: "tcp://kokoro-tts:10200", text: INPUT.text, voice: "af_heart", signal: expect.any(AbortSignal) });
    expect(ncUploadFile).toHaveBeenCalledWith("human-token", "alice", "/", "narration.wav", WAV, { ifNoneMatch: true, signal: expect.any(AbortSignal) });
    expect(upsertFileRegistryEntry).toHaveBeenCalledWith(prisma, { ncFileId: 123, ownerUserId: "person1", path: INPUT.path, departmentId: null, sizeBytes: 48, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(invalidatePrefix).toHaveBeenCalledWith("files:list:alice:");
    expect(response.body.media).toMatchObject({ kind: "file", path: INPUT.path, mimeType: "audio/wav", size: 48 });
    expect(response.body).not.toHaveProperty("wav"); expect(response.body).not.toHaveProperty("contentBase64");
    expect(JSON.stringify(response.body)).not.toContain(INPUT.text);
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: "user", id: "person1" } }));
  });
  it("resolves pinned MCP actors to their own login and UUID", async () => {
    const response = await request(app(SERVICE)).post("/api/files/audio").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "bob-token").send(INPUT);
    expect(response.status).toBe(200);
    expect(resolveAssertedUser).toHaveBeenCalledWith(prisma, "bob"); expect(resolveNcToken).not.toHaveBeenCalled();
    expect(resolveAssertedUser).toHaveBeenCalledWith(prisma, "person2");
    expect(getNcToken).toHaveBeenCalledWith("person2");
    expect(ncUploadFile).toHaveBeenCalledWith("bob-token", "nc-bob", "/", "narration.wav", WAV, expect.anything());
    expect(upsertFileRegistryEntry).toHaveBeenCalledWith(prisma, expect.objectContaining({ ownerUserId: "person2" }));
    expect(recordActivity).toHaveBeenCalledWith(expect.objectContaining({ actor: { type: "ai", id: "person2" } }));
  });
  it.each([null, { id: "guest", username: "guest", role: "guest" }, { id: "_service:other", username: "other", role: "service" }, { id: "_service:mcp", username: "svc", role: "guest" }])("denies unapproved principal %j before synthesis", async (user) => {
    expect((await request(app(user)).post("/api/files/audio").send(INPUT)).status).toBe(403);
    expect(synthesize).not.toHaveBeenCalled(); expect(ncUploadFile).not.toHaveBeenCalled();
  });
  it.each(["not_found", "ambiguous", "deactivated"] as const)("denies %s acting assertions", async (reason) => {
    vi.mocked(resolveAssertedUser).mockResolvedValue({ ok: false, reason });
    expect((await request(app(SERVICE)).post("/api/files/audio").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "bob-token").send(INPUT)).status).toBe(403);
    expect(synthesize).not.toHaveBeenCalled();
  });
  it("denies guest assertions and mismatched canonical account resolutions", async () => {
    vi.mocked(resolveAssertedUser).mockResolvedValueOnce({ ok: true, user: { id: "person2", username: "bob", role: "guest", displayName: "Bob", email: null } });
    expect((await request(app(SERVICE)).post("/api/files/audio").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "token").send(INPUT)).status).toBe(403);
    vi.mocked(resolveAssertedNextcloudLogin).mockResolvedValueOnce({ ok: true, login: "other", userId: "other-id" });
    expect((await request(app(SERVICE)).post("/api/files/audio").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "token").send(INPUT)).status).toBe(403);
    expect(synthesize).not.toHaveBeenCalled();
  });
  it("refuses missing file sessions before spending CPU time", async () => {
    vi.mocked(resolveNcToken).mockResolvedValue(null);
    expect((await request(app()).post("/api/files/audio").send(INPUT)).status).toBe(401);
    expect((await request(app(SERVICE)).post("/api/files/audio").set("x-nextcloud-user", "bob").send(INPUT)).status).toBe(401);
    expect(synthesize).not.toHaveBeenCalled();
  });
  it.each([false, true])("rechecks live credentials after synthesis (MCP=%s)", async (service) => {
    if (service) vi.mocked(getNcToken).mockResolvedValue(null);
    else vi.mocked(resolveNcToken).mockResolvedValueOnce("human-token").mockResolvedValueOnce(null);
    const response = await request(app(service ? SERVICE : undefined)).post("/api/files/audio").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "bob-token").send(INPUT);
    expect(response.status).toBe(401); expect(synthesize).toHaveBeenCalledTimes(1); expect(ncUploadFile).not.toHaveBeenCalled();
  });
  it.each(["deactivated", "downgraded", "deleted"])("refuses a person %s during synthesis", async (reason) => {
    synthesize.mockImplementationOnce(async () => {
      vi.mocked(resolveAssertedUser).mockResolvedValueOnce(reason === "downgraded" ? { ok: true, user: { id: "person1", username: "alice", role: "guest", displayName: "Alice", email: null } } : { ok: false, reason: reason === "deactivated" ? "deactivated" : "not_found" });
      return AUDIO;
    });
    const response = await request(app()).post("/api/files/audio").send(INPUT);
    expect(response.status).toBe(403); expect(ncUploadFile).not.toHaveBeenCalled();
  });
  it("refuses an MCP account mapping changed during synthesis", async () => {
    vi.mocked(resolveAssertedNextcloudLogin).mockResolvedValueOnce({ ok: true, login: "nc-bob", userId: "person2" }).mockResolvedValueOnce({ ok: true, login: "other-login", userId: "person2" });
    const response = await request(app(SERVICE)).post("/api/files/audio").set("x-nextcloud-user", "bob").set("x-nextcloud-token", "bob-token").send(INPUT);
    expect(response.status).toBe(403); expect(ncUploadFile).not.toHaveBeenCalled();
  });
});

describe("speech output and refusal semantics", () => {
  it.each(["../speech.wav", "/x/../speech.wav", "/Dept/speech.wav", "/%2e%2e.wav", "/speech.mp3", "/.wav", "/speech.wav/", "/speech\\name.wav", "/speech\0.wav"])("refuses invalid/nonpersonal destinations %s", async (path) => {
    const response = await request(app()).post("/api/files/audio").send({ ...INPUT, path });
    expect(response.status).toBe(400); expect(synthesize).not.toHaveBeenCalled();
  });
  it.each([{ text: "" }, { text: "x".repeat(2001) }, { text: "x\0" }, { voice: "../../model" }, { url: "tcp://external:10200" }])("validates compact local-only args %j", async (bad) => {
    expect((await request(app()).post("/api/files/audio").send({ ...INPUT, ...bad })).status).toBe(400); expect(synthesize).not.toHaveBeenCalled();
  });
  it("leaves voice omitted so the server default applies", async () => {
    const response = await request(app()).post("/api/files/audio").send({ path: INPUT.path, text: INPUT.text });
    expect(response.status).toBe(200); expect(synthesize.mock.calls[0][0]).not.toHaveProperty("voice");
  });
  it("checks existence early and uses the atomic WebDAV guard for racing writers", async () => {
    vi.mocked(ncGetFileId).mockReset().mockResolvedValue(123);
    expect((await request(app()).post("/api/files/audio").send(INPUT)).status).toBe(409); expect(synthesize).not.toHaveBeenCalled();
    vi.mocked(ncGetFileId).mockResolvedValueOnce(null);
    vi.mocked(ncUploadFile).mockRejectedValueOnce(new NcPreconditionFailedError());
    expect((await request(app()).post("/api/files/audio").send(INPUT)).status).toBe(409); expect(upsertFileRegistryEntry).not.toHaveBeenCalled();
  });
  it.each([["NOT_CONFIGURED", 503], ["UNREACHABLE", 503], ["PROTOCOL_ERROR", 503], ["TIMEOUT", 408], ["BUSY", 429], ["INVALID_VOICE", 400], ["TOO_LARGE", 413]] as const)("preserves named %s failure", async (code, status) => {
    synthesize.mockRejectedValue(new TtsUnavailableError(code, "A readable local error."));
    const response = await request(app()).post("/api/files/audio").send(INPUT);
    expect(response.status).toBe(status); expect(response.body.error).toBe("A readable local error."); expect(ncUploadFile).not.toHaveBeenCalled();
  });
  it("refuses malformed audio and reports saved files during metadata outages", async () => {
    synthesize.mockResolvedValueOnce({ ...AUDIO, wav: Buffer.from("not audio") });
    expect((await request(app()).post("/api/files/audio").send(INPUT)).status).toBe(503); expect(ncUploadFile).not.toHaveBeenCalled();
    vi.mocked(ncGetFileId).mockReset().mockResolvedValue(null);
    const response = await request(app()).post("/api/files/audio").send(INPUT);
    expect(response.status).toBe(200); expect(response.body.warnings).toEqual([expect.stringContaining("registration is pending")]);
    expect(response.body.media.path).toBe(INPUT.path);
  });
  it.each(["file-id", "registry"])("returns the acknowledged saved file when %s bookkeeping fails", async (failure) => {
    if (failure === "file-id") vi.mocked(ncGetFileId).mockReset().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("metadata down"));
    else vi.mocked(upsertFileRegistryEntry).mockRejectedValueOnce(new Error("registry down"));
    const response = await request(app()).post("/api/files/audio").send(INPUT);
    expect(response.status).toBe(200);
    expect(ncUploadFile).toHaveBeenCalledTimes(1);
    expect(response.body.media.path).toBe(INPUT.path);
    expect(response.body.warnings).toEqual([expect.stringContaining("registration is pending")]);
  });
  it("bounds in-flight requests and frees the slot after successful completion", async () => {
    vi.mocked(ncGetFileId).mockReset().mockResolvedValue(null);
    const releases: (() => void)[] = [];
    synthesize.mockImplementation(() => new Promise((resolve) => releases.push(() => resolve(AUDIO))));
    const server = app();
    const first = request(server).post("/api/files/audio").send(INPUT).then((r) => r);
    const second = request(server).post("/api/files/audio").send({ ...INPUT, path: "/second.wav" }).then((r) => r);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect((await request(server).post("/api/files/audio").send({ ...INPUT, path: "/third.wav" })).status).toBe(429);
    releases.forEach((release) => release()); expect((await first).status).toBe(200); expect((await second).status).toBe(200);
    synthesize.mockResolvedValue(AUDIO);
    expect((await request(server).post("/api/files/audio").send({ ...INPUT, path: "/fourth.wav" })).status).toBe(200);
  });
});
