import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ARTIFACT_PREVIEW_CSP, ARTIFACT_PREVIEW_DOCUMENT, createArtifactPreviewRouter } from "../routes/artifact-preview.js";

describe("public artifact preview policy host", () => {
  function app() { const app = express(); app.use("/api", createArtifactPreviewRouter()); return app; }
  it("delivers an enforced deny-all connection policy before any private markup", async () => {
    const result = await request(app()).get("/api/artifact-preview");
    expect(result.status).toBe(200);
    expect(result.headers["connection-allowlist"]).toBe("()");
    expect(result.headers["content-security-policy"]).toBe(ARTIFACT_PREVIEW_CSP);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["referrer-policy"]).toBe("no-referrer");
    expect(result.headers["x-dns-prefetch-control"]).toBe("off");
    expect(result.headers["content-type"]).toContain("text/html; charset=utf-8");
    expect(result.text).toBe(ARTIFACT_PREVIEW_DOCUMENT);
    expect(result.text).toContain('peer.iceConnectionState === "failed"');
    expect(result.text).toContain('mode: "no-cors"');
    expect(result.text).toContain('event.source !== parent');
    expect(result.text).toContain('state !== "ready"');
    expect(result.text).toContain('frame.setAttribute("sandbox", "allow-scripts")');
    expect(result.text).toContain("connect-src 'none'");
    expect(ARTIFACT_PREVIEW_CSP).toContain("frame-src blob:");
    expect(ARTIFACT_PREVIEW_CSP).toContain("sandbox allow-scripts");
  });
  it("does not reflect query strings, credentials, or cookies into the static host", async () => {
    const result = await request(app()).get("/api/artifact-preview?content=PRIVATE_DATA&nonce=EVIL").set("Cookie", "session=PRIVATE_COOKIE");
    expect(result.text).toBe(ARTIFACT_PREVIEW_DOCUMENT);
    expect(result.headers["set-cookie"]).toBeUndefined();
    expect(result.text).not.toContain("PRIVATE_");
  });
  it("offers a secret-free no-store control response without redirect or auth", async () => {
    const result = await request(app()).get("/api/artifact-preview-probe");
    expect(result.status).toBe(204);
    expect(result.text).toBe("");
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["location"]).toBeUndefined();
    expect(result.headers["set-cookie"]).toBeUndefined();
  });
});
