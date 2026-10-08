import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { artifactMediaFromPath } from "@droplet/shared-types";
import { ArtifactMediaCard, ARTIFACT_MAX_BYTES } from "./ArtifactMediaCard";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function frame() { return screen.getByTitle("Demo.html") as HTMLIFrameElement; }
function message(data: Record<string, unknown>, overrides: MessageEventInit = {}) {
  const host = frame();
  const nonce = host.getAttribute("src")!.split("#")[1];
  window.dispatchEvent(new MessageEvent("message", { source: host.contentWindow, origin: "null", data: { nonce, ...data }, ...overrides }));
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
  it("withholds private bytes until the trusted opaque HTTP host proves enforcement", async () => {
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
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "droplet-artifact-init" }), "*"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("/api/artifact-preview-probe", expect.objectContaining({ credentials: "omit", redirect: "error" }));
    message({ type: "droplet-artifact-ready", supported: true });
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: "droplet-artifact-content", content: "<button onclick='this.textContent=2'>1</button>" }), "*"));
    expect(fetch).toHaveBeenCalledWith("/api/files/download?path=%2FDemo.html", expect.objectContaining({ credentials: "same-origin", signal: expect.any(AbortSignal) }));
    message({ type: "droplet-artifact-loaded" });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    expect(screen.queryByTitle("Demo.html")).toBeNull();
  });
  it("fails closed in unsupported browsers without fetching private content", async () => {
    const fetch = mockFetch(); open();
    message({ type: "droplet-artifact-ready", supported: false });
    expect((await screen.findByRole("alert")).textContent).toContain("cannot isolate interactive previews");
    expect(fetch.mock.calls.every(([url]) => url === "/api/artifact-preview-probe")).toBe(true);
    expect(screen.queryByTitle("Demo.html")).toBeNull();
  });
  it("ignores forged readiness from descendants, other origins, or stale previews", async () => {
    const fetch = mockFetch(); open();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    message({ type: "droplet-artifact-ready", supported: true }, { source: window });
    message({ type: "droplet-artifact-ready", supported: true }, { origin: "https://attacker.example" });
    message({ type: "droplet-artifact-ready", supported: true, nonce: "wrong" });
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("requires the public control endpoint reachable before starting the probe", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetch); open();
    await screen.findByRole("alert");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe("/api/artifact-preview-probe");
  });
  it.each([401, 404, 503])("reports unavailable private content (%s)", async (status) => {
    mockFetch(new Response("", { status })); open();
    message({ type: "droplet-artifact-ready", supported: true });
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Preview could not be loaded.");
    expect(screen.queryByTitle("Demo.html")).toBeNull();
  });
  it("refuses oversized streamed content before transferring it", async () => {
    mockFetch(new Response("x".repeat(ARTIFACT_MAX_BYTES + 1))); open();
    const post = vi.spyOn(frame().contentWindow!, "postMessage");
    message({ type: "droplet-artifact-ready", supported: true });
    await screen.findByRole("alert");
    expect(post.mock.calls.some(([data]) => data.type === "droplet-artifact-content")).toBe(false);
  });
  it("fails closed when the host never proves its boundary", async () => {
    vi.useFakeTimers(); mockFetch(); open();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("alert").textContent).toContain("cannot isolate interactive previews");
    expect(screen.queryByTitle("Demo.html")).toBeNull();
  });
});
