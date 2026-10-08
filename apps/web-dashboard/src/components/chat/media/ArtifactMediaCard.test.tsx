import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { artifactMediaFromPath } from "@droplet/shared-types";
import { ArtifactMediaCard, ARTIFACT_MAX_BYTES } from "./ArtifactMediaCard";

class TestPort {
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer!: TestPort;
  closed = false;
  start = vi.fn();
  close = vi.fn(() => { this.closed = true; });
  postMessage = vi.fn((data: unknown) => {
    if (!this.closed && !this.peer.closed) queueMicrotask(() => {
      if (!this.peer.closed) this.peer.onmessage?.(new MessageEvent("message", { data }));
    });
  });
}
const channels: TestChannel[] = [];
class TestChannel {
  port1 = new TestPort();
  port2 = new TestPort();
  constructor() { this.port1.peer = this.port2; this.port2.peer = this.port1; channels.push(this); }
}
beforeEach(() => { channels.length = 0; vi.stubGlobal("MessageChannel", TestChannel); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function frame() { return screen.getByTitle("Demo.html") as HTMLIFrameElement; }
function nonce() { return frame().getAttribute("src")!.split("#")[1]; }
function windowMessage(data: Record<string, unknown>, overrides: MessageEventInit = {}) {
  window.dispatchEvent(new MessageEvent("message", { source: frame().contentWindow, origin: "null", data: { nonce: nonce(), ...data }, ...overrides }));
}
async function boot() {
  await waitFor(() => expect(channels).toHaveLength(1));
  return channels[0];
}
async function message(data: Record<string, unknown>, selected?: TestChannel) {
  const channel = selected ?? await boot();
  const token = nonce();
  await act(async () => { channel.port2.postMessage({ nonce: token, ...data }); });
}
function open() {
  render(<ArtifactMediaCard media={artifactMediaFromPath("/Demo.html")} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview" }));
  fireEvent.load(frame());
}
function mockFetch(content: Response = new Response("<button onclick='this.textContent=2'>1</button>")) {
  const fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(url === "/api/artifact-preview-probe" ? new Response(null, { status: 204 }) : content));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("interactive artifact preview", () => {
  it("withholds private bytes until the bound trusted HTTP host proves enforcement", async () => {
    const fetch = mockFetch();
    render(<ArtifactMediaCard media={artifactMediaFromPath("/Demo.html")} />);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const host = frame();
    expect(host.getAttribute("src")).toMatch(/^\/api\/artifact-preview#[a-f0-9-]{36}$/);
    expect(host.getAttribute("srcdoc")).toBeNull();
    expect(host.getAttribute("sandbox")).toBe("allow-scripts");
    expect(host.getAttribute("referrerpolicy")).toBe("no-referrer");
    const post = vi.spyOn(host.contentWindow!, "postMessage");
    fireEvent.load(host);
    const channel = await boot();
    expect(post).toHaveBeenCalledExactlyOnceWith({ type: "droplet-artifact-init", nonce: nonce() }, "*", [channel.port2]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/artifact-preview-probe", expect.objectContaining({ credentials: "omit", redirect: "error" }));
    await message({ type: "droplet-artifact-ready", supported: true }, channel);
    await waitFor(() => expect(channel.port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "droplet-artifact-content", content: "<button onclick='this.textContent=2'>1</button>" })));
    expect(post).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/files/download?path=%2FDemo.html", expect.objectContaining({ credentials: "same-origin", signal: expect.any(AbortSignal) }));
    await message({ type: "droplet-artifact-loaded" }, channel);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByTitle("Demo.html")).toBeNull();
    expect(channel.port1.close).toHaveBeenCalled();
  });
  it("fails closed in unsupported browsers without fetching private content", async () => {
    const fetch = mockFetch(); open();
    await message({ type: "droplet-artifact-ready", supported: false });
    expect((await screen.findByRole("alert")).textContent).toContain("cannot isolate interactive previews");
    expect(fetch.mock.calls.every(([url]) => url === "/api/artifact-preview-probe")).toBe(true);
    expect(channels[0].port1.closed).toBe(true);
    expect(screen.queryByTitle("Demo.html")).toBeNull();
  });
  it("ignores all forged window readiness, wrong-port messages and wrong port nonces", async () => {
    const fetch = mockFetch(); open();
    const channel = await boot();
    windowMessage({ type: "droplet-artifact-ready", supported: true });
    windowMessage({ type: "droplet-artifact-ready", supported: true }, { source: window });
    windowMessage({ type: "droplet-artifact-ready", supported: true }, { origin: "https://attacker.example" });
    const unrelated = new TestChannel();
    await message({ type: "droplet-artifact-ready", supported: true }, unrelated);
    await message({ type: "droplet-artifact-ready", supported: true, nonce: "wrong" }, channel);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("requires the public control endpoint reachable before transferring a port", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch); open();
    await screen.findByRole("alert");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(channels).toHaveLength(0);
  });
  it("fails closed without MessageChannel", async () => {
    vi.stubGlobal("MessageChannel", undefined);
    const fetch = mockFetch(); open();
    await screen.findByRole("alert");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([401, 404, 503])("reports unavailable private content (%s)", async (status) => {
    mockFetch(new Response("", { status })); open();
    await message({ type: "droplet-artifact-ready", supported: true });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Preview could not be loaded.");
    expect(screen.queryByTitle("Demo.html")).toBeNull();
  });
  it("refuses oversized streamed content before transferring it", async () => {
    mockFetch(new Response("x".repeat(ARTIFACT_MAX_BYTES + 1))); open();
    const channel = await boot();
    await message({ type: "droplet-artifact-ready", supported: true }, channel);
    await screen.findByRole("alert");
    expect(channel.port1.postMessage).not.toHaveBeenCalled();
  });
  it("closes the bound port and aborts a late private fetch when closed", async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn((url: string, _options?: RequestInit) => url === "/api/artifact-preview-probe" ? Promise.resolve(new Response(null, { status: 204 })) : new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetch); open();
    const channel = await boot();
    const lateReceive = channel.port1.onmessage!;
    const token = nonce();
    await message({ type: "droplet-artifact-ready", supported: true }, channel);
    const signal = fetch.mock.calls[1][1]!.signal!;
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(signal.aborted).toBe(true);
    expect(channel.port1.closed).toBe(true);
    await act(async () => {
      lateReceive(new MessageEvent("message", { data: { type: "droplet-artifact-ready", nonce: token, supported: true } }));
      resolve(new Response("PRIVATE-LATE-CONTENT"));
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(channel.port1.postMessage).not.toHaveBeenCalled();
  });
  it("fails closed on a duplicate frame load after binding the port", async () => {
    const fetch = mockFetch(); open();
    const channel = await boot();
    fireEvent.load(frame());
    await screen.findByRole("alert");
    expect(channel.port1.closed).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(channels).toHaveLength(1);
  });
  it("does not transfer a port if a duplicate load occurs during the public fetch", async () => {
    let resolve!: (value: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((done) => { resolve = done; }));
    vi.stubGlobal("fetch", fetch); open();
    fireEvent.load(frame());
    await screen.findByRole("alert");
    await act(async () => { resolve(new Response(null, { status: 204 })); });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(channels).toHaveLength(0);
  });
  it("fails closed when the host never proves its boundary", async () => {
    vi.useFakeTimers(); mockFetch(); open();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("alert").textContent).toContain("cannot isolate interactive previews");
    expect(screen.queryByTitle("Demo.html")).toBeNull();
    expect(channels[0].port1.closed).toBe(true);
  });
});
