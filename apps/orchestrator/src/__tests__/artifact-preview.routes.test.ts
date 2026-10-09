import express from "express";
import request from "supertest";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
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
    expect(result.text).toContain('event.origin !== new URL(location.href).origin');
    expect(result.text).toContain('event.ports.length !== 1');
    expect(result.text).toContain('port.onmessage = receiveContent');
    expect(result.text).toContain('port?.postMessage');
    expect(result.text).not.toContain('parent.postMessage');
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
  function wrapper(supported = true) {
    const nonce = "a68f8de2-7f89-4c80-8e73-dd46e87c8238";
    const parent = { postMessage: vi.fn() };
    type WrapperEvent = { source: unknown; origin: string; data: Record<string, unknown>; ports: unknown[] };
    let receive!: (event: WrapperEvent) => Promise<void>;
    let pagehide!: () => void;
    const child = { title: "", referrerPolicy: "", srcdoc: "", setAttribute: vi.fn() };
    const document = { createElement: vi.fn(() => child), body: { append: vi.fn() } };
    class Peer {
      iceConnectionState = "new";
      localDescription: unknown;
      oniceconnectionstatechange?: () => void;
      createDataChannel() {}
      async createOffer() { return {}; }
      async createAnswer() { return {}; }
      async setLocalDescription(description: unknown) { this.localDescription = description; }
      async setRemoteDescription() { this.iceConnectionState = "failed"; this.oniceconnectionstatechange?.(); }
      close() {}
    }
    runInNewContext(ARTIFACT_PREVIEW_DOCUMENT.match(/<script>([\s\S]*?)<\/script>/)![1], {
      location: { hash: `#${nonce}`, href: "https://droplet.local/api/artifact-preview" }, parent, window: {}, document,
      RTCPeerConnection: supported ? Peer : undefined,
      fetch: vi.fn().mockRejectedValue(new TypeError("Connection policy blocked")),
      addEventListener: (type: string, listener: typeof receive | typeof pagehide) => {
        if (type === "message") receive = listener as typeof receive;
        else if (type === "pagehide") pagehide = listener as typeof pagehide;
      },
      URL, TypeError, AbortController, TextEncoder, setTimeout, clearTimeout,
    });
    const port = { onmessage: null as null | ((event: { data: Record<string, unknown> }) => void), start: vi.fn(), close: vi.fn(), postMessage: vi.fn() };
    const init = (source = parent, value = nonce, ports: unknown[] = [port], origin = "https://droplet.local") => receive({ source, origin, data: { type: "droplet-artifact-init", nonce: value }, ports });
    return { nonce, parent, receive, document, child, port, init, pagehide };
  }
  it("accepts private markup only on the parent-transferred port after policy readiness", async () => {
    const host = wrapper();
    await host.init({ postMessage: vi.fn() });
    await host.init(host.parent, "wrong");
    await host.init(host.parent, host.nonce, []);
    await host.init(host.parent, host.nonce, [host.port, host.port]);
    await host.init(host.parent, host.nonce, [host.port], "https://attacker.example");
    expect(host.port.start).not.toHaveBeenCalled();
    const initializing = host.init();
    const content = { type: "droplet-artifact-content", nonce: host.nonce, content: "PRIVATE_MARKUP" };
    host.port.onmessage!({ data: content });
    expect(host.document.body.append).not.toHaveBeenCalled();
    await initializing;
    expect(host.port.postMessage).toHaveBeenCalledWith({ type: "droplet-artifact-ready", nonce: host.nonce, supported: true });
    await host.receive({ source: host.parent, origin: "https://droplet.local", data: content, ports: [] });
    expect(host.document.body.append).not.toHaveBeenCalled();
    host.port.onmessage!({ data: { ...content, nonce: "wrong" } });
    expect(host.document.body.append).not.toHaveBeenCalled();
    host.port.onmessage!({ data: content });
    expect(host.document.body.append).toHaveBeenCalledTimes(1);
    expect(host.child.setAttribute).toHaveBeenCalledWith("sandbox", "allow-scripts");
    expect(host.child.srcdoc).toContain("PRIVATE_MARKUP");
    expect(host.port.postMessage).toHaveBeenCalledWith({ type: "droplet-artifact-loaded", nonce: host.nonce });
    expect(host.port.postMessage.mock.calls.every(([data]) => !JSON.stringify(data).includes("PRIVATE_MARKUP"))).toBe(true);
    expect(host.parent.postMessage).not.toHaveBeenCalled();
    host.pagehide();
    expect(host.port.close).toHaveBeenCalled();
  });
  it("withholds private content when enforcement is unsupported and closes on pagehide", async () => {
    const host = wrapper(false);
    await host.init();
    expect(host.port.postMessage).toHaveBeenCalledWith({ type: "droplet-artifact-ready", nonce: host.nonce, supported: false });
    host.port.onmessage!({ data: { type: "droplet-artifact-content", nonce: host.nonce, content: "PRIVATE_MARKUP" } });
    expect(host.document.body.append).not.toHaveBeenCalled();
    host.pagehide();
    expect(host.port.close).toHaveBeenCalled();
  });
});
