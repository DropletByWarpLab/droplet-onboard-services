import { beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { createReadStream } from "node:fs";
import type { Request } from "express";
import type { PrismaClient } from "@prisma/client";

vi.mock("../config.js", () => ({ config: { AUTH_ENABLED: true } }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), createReadStream: vi.fn() }));
vi.mock("./nextcloud.client.js", () => ({ ncFetchFileResponse: vi.fn(), ncGetFileId: vi.fn() }));
vi.mock("./asserted-user.service.js", () => ({ resolveAssertedUser: vi.fn() }));
vi.mock("./file-registry.service.js", () => ({ resolveFileDepartment: vi.fn() }));
vi.mock("../middleware/space.js", () => ({ checkSpaceAccess: vi.fn() }));
vi.mock("./brain-memory.service.js", () => ({ isPathUnderUser: vi.fn() }));

import { hydrateSlideImages, validateSlideRaster, withSlideDeadline, SLIDE_IMAGE_BYTES, SLIDE_IMAGES_BYTES } from "./slide-assets.service.js";
import { ncFetchFileResponse, ncGetFileId } from "./nextcloud.client.js";
import { resolveAssertedUser } from "./asserted-user.service.js";
import { resolveFileDepartment } from "./file-registry.service.js";
import { checkSpaceAccess } from "../middleware/space.js";
import { isPathUnderUser } from "./brain-memory.service.js";

// Real 1x1 PNG; dimensions are screened here, full raster decode is tested
// independently at the writer boundary.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZL0AAAAASUVORK5CYII=", "base64");
const brainMemoryItem = { findUnique: vi.fn() };
const prisma = { brainMemoryItem } as unknown as PrismaClient;
const actor = { id: "person1", role: "owner" };
const req = {} as Request;
const context = () => ({ prisma, req, actor, token: "caller-token", login: "alice", signal: new AbortController().signal });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(resolveAssertedUser).mockResolvedValue({ ok: true, user: { ...actor, username: "alice", displayName: "Alice", email: null } });
  vi.mocked(ncGetFileId).mockResolvedValue(123);
  vi.mocked(ncFetchFileResponse).mockImplementation(async () => new Response(PNG));
  vi.mocked(resolveFileDepartment).mockResolvedValue(null);
  vi.mocked(checkSpaceAccess).mockResolvedValue({ allowed: true, departmentId: null });
  vi.mocked(isPathUnderUser).mockReturnValue(true);
  vi.mocked(createReadStream).mockImplementation(() => Readable.from([PNG]) as ReturnType<typeof createReadStream>);
  brainMemoryItem.findUnique.mockResolvedValue({ userId: actor.id, filename: "image.png", storagePath: "/brain/person1/original", hasOriginalBytes: true, ingestPolicy: "approved" });
});

describe("Slide image source boundary", () => {
  it("hydrates a File Store source using the caller token, keeps text, and sends no path or credentials to the writer", async () => {
    const result = await hydrateSlideImages([{ title: "T", image: { path: "/Photos/device.png", caption: "Prototype", alt: "Teal case" } }], context());
    expect(ncGetFileId).toHaveBeenCalledWith("caller-token", "alice", "/Photos/device.png", expect.any(AbortSignal));
    expect(ncFetchFileResponse).toHaveBeenCalledWith("caller-token", "alice", "/Photos/device.png", undefined, expect.any(AbortSignal));
    expect(result).toEqual([{ title: "T", image: { content_base64: PNG.toString("base64"), caption: "Prototype", alt: "Teal case" } }]);
    expect(JSON.stringify(result)).not.toMatch(/caller-token|Photos\/device|alice/);
  });
  it("requires the registered department reader grant before downloading", async () => {
    vi.mocked(resolveFileDepartment).mockResolvedValue("dept1");
    vi.mocked(checkSpaceAccess).mockResolvedValue({ allowed: false, status: 403, error: "Department denied" });
    await expect(hydrateSlideImages([{ image: { path: "/Private/image.png" } }], context())).rejects.toMatchObject({ status: 403 });
    expect(checkSpaceAccess).toHaveBeenCalledWith(prisma, req, actor, "dept1", "reader");
    expect(ncFetchFileResponse).not.toHaveBeenCalled();
  });
  it("uses the freshly resolved role for each sequential source instead of retaining an old admin bypass", async () => {
    vi.mocked(resolveAssertedUser).mockResolvedValueOnce({ ok: true, user: { ...actor, role: "admin", username: "alice", displayName: "Alice", email: null } })
      .mockResolvedValueOnce({ ok: true, user: { ...actor, role: "admin", username: "alice", displayName: "Alice", email: null } })
      .mockResolvedValueOnce({ ok: true, user: { ...actor, role: "family", username: "alice", displayName: "Alice", email: null } });
    vi.mocked(resolveAssertedUser).mockResolvedValue({ ok: true, user: { ...actor, role: "family", username: "alice", displayName: "Alice", email: null } });
    vi.mocked(resolveFileDepartment).mockResolvedValue("dept1");
    vi.mocked(checkSpaceAccess).mockResolvedValueOnce({ allowed: true, departmentId: "dept1" }).mockResolvedValueOnce({ allowed: false, status: 403, error: "Membership removed" });
    await expect(hydrateSlideImages([{ image: { path: "/one.png" } }, { image: { path: "/two.png" } }], context())).rejects.toMatchObject({ status: 403 });
    expect(checkSpaceAccess).toHaveBeenNthCalledWith(1, prisma, req, { id: actor.id, role: "admin" }, "dept1", "reader");
    expect(checkSpaceAccess).toHaveBeenNthCalledWith(2, prisma, req, { id: actor.id, role: "family" }, "dept1", "reader");
    expect(ncFetchFileResponse).toHaveBeenCalledTimes(1);
  });
  it("hydrates an owned approved attachment without using Nextcloud or exposing storage identity", async () => {
    const result = await hydrateSlideImages([{ title: "T", image: { item_id: "attachment1" } }], context());
    expect(result).toEqual([{ title: "T", image: { content_base64: PNG.toString("base64") } }]);
    expect(ncGetFileId).not.toHaveBeenCalled();
    expect(createReadStream).toHaveBeenCalledWith("/brain/person1/original");
  });
  it.each([{ userId: "victim", hasOriginalBytes: true }, { userId: actor.id, hasOriginalBytes: false }])("denies attachment ownership or missing original bytes %j", async (partial) => {
    brainMemoryItem.findUnique.mockResolvedValue({ ...partial, storagePath: "/brain/person1/original", filename: "p.png", ingestPolicy: "approved" });
    await expect(hydrateSlideImages([{ image: { item_id: "attachment1" } }], context())).rejects.toMatchObject({ status: 404 });
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it("refuses a storage path outside the actor's private brain folder", async () => {
    vi.mocked(isPathUnderUser).mockReturnValue(false);
    await expect(hydrateSlideImages([{ image: { item_id: "attachment1" } }], context())).rejects.toMatchObject({ status: 404 });
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it("refuses an attachment awaiting approval", async () => {
    brainMemoryItem.findUnique.mockResolvedValue({ userId: actor.id, hasOriginalBytes: true, storagePath: "/brain/person1/original", filename: "p.png", ingestPolicy: "await_approval" });
    await expect(hydrateSlideImages([{ image: { item_id: "attachment1" } }], context())).rejects.toMatchObject({ status: 409 });
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it.each([{ content_base64: PNG.toString("base64") }, { url: "https://example.com/p.png" }, { path: "/p.png", item_id: "a" }, {}, { path: "/p.svg" }, { path: "https://example.com/p.png" }, { path: "/../p.png" }, { path: "/%2e%2e/p.png" }, { path: "//network/p.png" }, { path: "/p\\x.png" }, { path: "/p.png", alt: "bad\x00" }])("rejects public source injection %j before fetching", async (image) => {
    await expect(hydrateSlideImages([{ image }], context())).rejects.toMatchObject({ status: 400 });
    expect(ncGetFileId).not.toHaveBeenCalled(); expect(createReadStream).not.toHaveBeenCalled();
  });
  it("validates the entire descriptor list before any read", async () => {
    await expect(hydrateSlideImages([{ image: { path: "/valid.png" } }, { image: { content_base64: PNG.toString("base64") } }], context())).rejects.toMatchObject({ status: 400 });
    expect(ncGetFileId).not.toHaveBeenCalled();
  });
  it("refuses a revoked acting person before fetching sources", async () => {
    vi.mocked(resolveAssertedUser).mockResolvedValue({ ok: false, reason: "deactivated" });
    await expect(hydrateSlideImages([{ image: { path: "/p.png" } }], context())).rejects.toMatchObject({ status: 403 });
    expect(ncGetFileId).not.toHaveBeenCalled();
  });
  it("refuses missing File Store sources", async () => {
    vi.mocked(ncGetFileId).mockResolvedValue(null);
    await expect(hydrateSlideImages([{ image: { path: "/missing.png" } }], context())).rejects.toMatchObject({ status: 404 });
    expect(ncFetchFileResponse).not.toHaveBeenCalled();
  });
  it("enforces source counts before reads", async () => {
    await expect(hydrateSlideImages(Array.from({ length: 13 }, () => ({ image: { path: "/p.png" } })), context())).rejects.toMatchObject({ status: 413 });
    expect(ncGetFileId).not.toHaveBeenCalled();
  });
  it("enforces source and aggregate byte caps independently of Content-Length", async () => {
    vi.mocked(ncFetchFileResponse).mockImplementation(async () => new Response(Buffer.alloc(SLIDE_IMAGE_BYTES + 1), { headers: { "content-length": "1" } }));
    await expect(hydrateSlideImages([{ image: { path: "/p.png" } }], context())).rejects.toMatchObject({ status: 413 });
    const padded = Buffer.concat([PNG, Buffer.alloc(SLIDE_IMAGE_BYTES - PNG.length)]);
    vi.mocked(ncFetchFileResponse).mockImplementation(async () => new Response(padded));
    await expect(hydrateSlideImages(Array.from({ length: 5 }, () => ({ image: { path: "/p.png" } })), context())).rejects.toMatchObject({ status: 413 });
    expect(SLIDE_IMAGES_BYTES).toBe(SLIDE_IMAGE_BYTES * 4);
  });
  it("bounds stalled source metadata and streams on cancellation", async () => {
    const controller = new AbortController();
    vi.mocked(ncGetFileId).mockImplementation(() => new Promise(() => {}));
    const result = hydrateSlideImages([{ image: { path: "/p.png" } }], { ...context(), signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({ status: 408 });
    await expect(withSlideDeadline(new Promise(() => {}), controller.signal)).rejects.toMatchObject({ status: 408 });
  });
  it("screens actual raster signatures and pixel dimensions", () => {
    expect(() => validateSlideRaster(PNG)).not.toThrow();
    expect(() => validateSlideRaster(Buffer.from("<svg/>"))).toThrow("PNG or JPEG");
    const wide = Buffer.from(PNG); wide.writeUInt32BE(8193, 16);
    expect(() => validateSlideRaster(wide)).toThrow("pixel limit");
    const large = Buffer.from(PNG); large.writeUInt32BE(5000, 16); large.writeUInt32BE(4000, 20);
    expect(() => validateSlideRaster(large)).toThrow("pixel limit");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 8, 8, 0, 2, 0, 4, 0, 0xff, 0xd9]);
    expect(() => validateSlideRaster(jpeg)).not.toThrow();
    expect(() => validateSlideRaster(jpeg.subarray(0, 8))).toThrow("PNG or JPEG");
  });
  it("enforces the deck's aggregate pixel limit before forwarding hydrated content", async () => {
    const large = Buffer.from(PNG); large.writeUInt32BE(5000, 16); large.writeUInt32BE(2000, 20);
    vi.mocked(ncFetchFileResponse).mockImplementation(async () => new Response(large));
    await expect(hydrateSlideImages([{ image: { path: "/one.png" } }, { image: { path: "/two.png" } }], context())).rejects.toMatchObject({ status: 413 });
  });
});
