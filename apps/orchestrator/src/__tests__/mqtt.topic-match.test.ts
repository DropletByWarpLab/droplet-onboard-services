import { describe, it, expect } from "vitest";
import { topicMatches } from "../services/mqtt.service.js";

describe("topicMatches — MQTT wildcard semantics", () => {
  it("exact match", () => {
    expect(topicMatches("droplet/files/alice/uploaded", "droplet/files/alice/uploaded")).toBe(true);
  });

  it("+ matches a single segment", () => {
    expect(topicMatches("droplet/files/+/uploaded", "droplet/files/alice/uploaded")).toBe(true);
    expect(topicMatches("droplet/files/+/uploaded", "droplet/files/bob/uploaded")).toBe(true);
  });

  it("+ does not match across segments", () => {
    expect(topicMatches("droplet/files/+", "droplet/files/alice/uploaded")).toBe(false);
  });

  it("# matches zero or more trailing segments", () => {
    expect(topicMatches("droplet/files/alice/#", "droplet/files/alice/uploaded")).toBe(true);
    expect(topicMatches("droplet/files/alice/#", "droplet/files/alice/a/b/c")).toBe(true);
  });

  it("different users don't collide", () => {
    expect(topicMatches("droplet/files/alice/#", "droplet/files/bob/uploaded")).toBe(false);
  });

  it("length mismatch without wildcard", () => {
    expect(topicMatches("droplet/files/alice", "droplet/files/alice/uploaded")).toBe(false);
    expect(topicMatches("droplet/files/alice/uploaded", "droplet/files/alice")).toBe(false);
  });
});
