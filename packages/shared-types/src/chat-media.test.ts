import { describe, expect, it } from "vitest";
import {
  eventMedia,
  eventsMedia,
  fileMediaFromPath,
  isSafeMediaUrl,
  mimeTypeForName,
  parseChatMedia,
  cameraSnapshotMedia,
  cameraLiveMedia,
} from "./chat-media";

describe("isSafeMediaUrl", () => {
  it.each([
    "/api/cameras/front/snapshot",
    "/api/files/download?path=%2Fa%2Fb.png&disposition=inline",
    "/api/files/download?path=..%2Fx", // `..` inside a query value is data, not a path segment
  ])("accepts %s", (u) => expect(isSafeMediaUrl(u)).toBe(true));

  it.each([
    "https://evil.example/api/x",
    "//evil.example/api/x",
    "/\\evil.example",
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "/cameras/front",
    "api/cameras/x",
    "/api/../etc/passwd",
    "/api/%2e%2e/etc/passwd",
    "/api/a\nb",
    "/api/a\\b",
    "",
    null,
    undefined,
    42,
    "/api/" + "a".repeat(2100),
  ])("rejects %j", (u) => expect(isSafeMediaUrl(u as unknown)).toBe(false));
});

describe("builders", () => {
  it("validates camera names", () => {
    expect(cameraSnapshotMedia("bad name!")).toBeNull();
    expect(cameraLiveMedia("../x")).toBeNull();
    expect(cameraSnapshotMedia("front_door")?.snapshotUrl).toBe("/api/cameras/front_door/snapshot");
  });

  it("eventMedia handles camelCase and snake_case, clip beats still", () => {
    expect(eventMedia({ id: "e1", camera: "c", has_clip: true, start_time: 1 })).toMatchObject({
      kind: "camera_clip",
      clipUrl: "/api/cameras/clips/event/e1",
      startTime: 1,
    });
    expect(eventMedia({ id: "e1", camera: "c", hasClip: false, hasSnapshot: true })).toMatchObject({
      kind: "camera_snapshot",
      snapshotUrl: "/api/cameras/events/e1/snapshot",
    });
    expect(eventMedia({ id: "e1", camera: "c" })).toBeNull();
    expect(eventMedia({ id: "a/b", has_clip: true })).toBeNull();
    expect(eventMedia(null)).toBeNull();
  });

  it("eventsMedia caps the count", () => {
    const evs = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, hasClip: true }));
    expect(eventsMedia(evs)).toHaveLength(6);
    expect(eventsMedia("nope")).toEqual([]);
  });

  it("fileMediaFromPath encodes the path and only thumbnails images", () => {
    const m = fileMediaFromPath("/My Docs/a&b.png");
    expect(m.previewUrl).toBe("/api/files/download?path=%2FMy%20Docs%2Fa%26b.png&disposition=inline");
    expect(m.thumbnailUrl).toContain("/api/files/thumbnail?path=");
    expect(fileMediaFromPath("/x.pdf").thumbnailUrl).toBeUndefined();
    expect(mimeTypeForName("weird.zzz")).toBe("application/octet-stream");
  });
});

describe("parseChatMedia", () => {
  const snap = {
    kind: "camera_snapshot",
    camera: "front",
    snapshotUrl: "/api/cameras/front/snapshot",
    liveUrl: "/api/cameras/front/live",
  };

  it("accepts a single descriptor, a list, and the MCP-wrapped shape", () => {
    expect(parseChatMedia({ media: snap })).toHaveLength(1);
    expect(parseChatMedia({ media: [snap, snap] })).toHaveLength(2);
    expect(parseChatMedia({ data: { media: snap } })).toHaveLength(1);
  });

  it("returns [] for anything else", () => {
    for (const d of [null, undefined, "x", 3, {}, { media: null }, { media: "x" }, { media: [] }]) {
      expect(parseChatMedia(d)).toEqual([]);
    }
  });

  it("drops entries with an unsafe URL or invalid identifiers, keeps the good ones", () => {
    const out = parseChatMedia({
      media: [
        { ...snap, snapshotUrl: "https://evil.example/x.png" },
        { ...snap, camera: "bad name" },
        { ...snap, liveUrl: "//evil/x" }, // bad optional URL is dropped, card survives
        { kind: "nope" },
        { kind: "camera_clip" }, // no url
        { kind: "file", name: "a.png", previewUrl: "/api/files/download?path=%2Fa.png", downloadUrl: "javascript:1" },
      ],
    });
    expect(out).toEqual([{ kind: "camera_snapshot", camera: "front", snapshotUrl: "/api/cameras/front/snapshot" }]);
  });

  it("caps cards per call", () => {
    expect(parseChatMedia({ media: Array.from({ length: 50 }, () => snap) })).toHaveLength(12);
  });

  it("round-trips a file descriptor and fills a missing mimeType", () => {
    const [m] = parseChatMedia({
      media: { kind: "file", name: "a.png", previewUrl: "/api/files/download?path=%2Fa.png", downloadUrl: "/api/files/download?path=%2Fa.png" },
    });
    expect(m).toMatchObject({ kind: "file", mimeType: "image/png" });
  });
});
