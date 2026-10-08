import { describe, expect, it } from "vitest";
import { artifactMediaFromPath, parseOneChatMedia } from "./chat-media";
describe("artifact descriptors", () => {
  it("round trips a producer descriptor", () => {
    const media = artifactMediaFromPath("/Documents/Demo.html", 1024);
    expect(parseOneChatMedia(media)).toEqual(media);
  });
  it.each(["https://evil.example/x", "/api/auth", "/api/files/download?path=%2Fanother.html"])("refuses mismatched preview URL %s", (downloadUrl) => {
    expect(parseOneChatMedia({ ...artifactMediaFromPath("/Demo.html"), downloadUrl })).toBeNull();
  });
  it.each(["/../Demo.html", "/Demo.pdf", "relative.html", "/D\\emo.html", "/bad\u0000.html"])("refuses invalid path %s", (path) => {
    expect(parseOneChatMedia(artifactMediaFromPath(path))).toBeNull();
  });
  it("refuses an over-limit size and remains distinct from ordinary HTML files", () => {
    expect(parseOneChatMedia(artifactMediaFromPath("/Demo.html", 192 * 1024 + 1))).toBeNull();
    expect(parseOneChatMedia({ kind: "file", name: "demo.html", mimeType: "text/html", previewUrl: "/api/files/download?path=%2Fdemo.html", downloadUrl: "/api/files/download?path=%2Fdemo.html" })?.kind).toBe("file");
  });
});
