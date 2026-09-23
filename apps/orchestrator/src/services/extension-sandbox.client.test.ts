/**
 * WARP-2900 (ADR-056 slice H2) — the sandbox's extension routes, from the
 * orchestrator's side.
 *
 *   - no SANDBOX_SERVICE_TOKEN → NOT_CONFIGURED, and nothing is dialled;
 *   - every call carries the bearer and goes to SANDBOX_URL;
 *   - the sandbox gate's bare 404 ("Not found") is SUPERVISION_OFF, never
 *     confused with "this extension is not installed" (a 404 with its own
 *     detail, which `status` reports as null);
 *   - the proposal manifest comes back as the exact committed bytes;
 *   - a hung sandbox is a caller-side TIMEOUT.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({ config: { SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "" } }));

import { createExtensionSandboxClient, ExtensionSandboxError } from "./extension-sandbox.client.js";

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (url: string, init: RequestInit) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = respond(String(url), init ?? {});
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const client = (f: ReturnType<typeof fakeFetch>) =>
  createExtensionSandboxClient({ serviceToken: "sb-token", fetchImpl: f.impl });

describe("extension-sandbox.client", () => {
  it("refuses without a bearer and dials nothing", async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const c = createExtensionSandboxClient({ fetchImpl: f.impl });
    await expect(c.budget()).rejects.toMatchObject({ code: "NOT_CONFIGURED", status: 503 });
    expect(f.calls).toEqual([]);
  });

  it("sends the bearer to SANDBOX_URL and decodes the committed manifest bytes", async () => {
    const bytes = Buffer.from('{"id":"wc"}\n');
    const f = fakeFetch(() => ({
      status: 200,
      body: { workspaceId: "wc", tag: "proposal/0.1.0", commit: "c".repeat(40), tree: "t".repeat(40), manifest: bytes.toString("base64") },
    }));
    const got = await client(f).proposalManifest("wc", "0.1.0");
    expect(f.calls[0].url).toBe("http://sandbox:8030/workspaces/wc/proposals/0.1.0/manifest");
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer sb-token");
    expect(got.manifest?.equals(bytes)).toBe(true);
  });

  it("a proposal with no manifest decodes to null", async () => {
    const f = fakeFetch(() => ({ status: 200, body: { workspaceId: "wc", tag: "proposal/0.1.0", commit: "c", tree: "t", manifest: null } }));
    expect((await client(f).proposalManifest("wc", "0.1.0")).manifest).toBeNull();
  });

  it("tells the gate's 404 apart from a missing extension", async () => {
    // MUTATION: treat every 404 from status() as null and a box with
    // supervision off looks like one whose extensions all died.
    const gate = fakeFetch(() => ({ status: 404, body: { detail: "Not found" } }));
    await expect(client(gate).status("wc")).rejects.toMatchObject({ code: "SUPERVISION_OFF", status: 503 });
    await expect(client(gate).budget()).rejects.toMatchObject({ code: "SUPERVISION_OFF" });
    await expect(client(gate).stop("wc")).rejects.toMatchObject({ code: "SUPERVISION_OFF" });

    const missing = fakeFetch(() => ({ status: 404, body: { detail: "extension wc is not installed in this sandbox" } }));
    expect(await client(missing).status("wc")).toBeNull();
    await expect(client(missing).stop("wc")).resolves.toBeUndefined();
  });

  it("a status body that is not about the extension asked for is an error, never 'not running'", async () => {
    // MUTATION: trust any 200 body in status() and the budget JSON (what
    // GET /extensions/budget answers) reads as a stopped extension, which
    // the reconciler reinstalls every tick.
    const budgetBody = { ceilingMb: 512, source: "env", transformHeadroomMb: 256, installedMb: 0, availableMb: 256 };
    const f = fakeFetch(() => ({ status: 200, body: budgetBody }));
    await expect(client(f).status("budget")).rejects.toMatchObject({ code: "SANDBOX_ERROR", status: 502 });
    const ok = fakeFetch(() => ({ status: 200, body: { slug: "wc", running: true, process: null } }));
    expect(await client(ok).status("wc")).toMatchObject({ slug: "wc", running: true });
  });

  it("relays a 4xx detail and turns a 5xx into a 502", async () => {
    const conflict = fakeFetch(() => ({ status: 409, body: { detail: "memoryMb 300 does not fit" } }));
    const err = await client(conflict)
      .install("wc", {
        workspaceId: "wc", version: "0.1.0", commit: "c", tree: "t", runtime: "python312",
        entrypoint: "tool.py", memoryMb: 300, token: "dxt_x",
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionSandboxError);
    expect(err).toMatchObject({ status: 409, code: "SANDBOX_ERROR", message: "memoryMb 300 does not fit" });
    expect(JSON.parse(String(conflict.calls[0].init.body))).toMatchObject({ token: "dxt_x", memoryMb: 300 });

    const broken = fakeFetch(() => ({ status: 500, body: { detail: "boom" } }));
    await expect(client(broken).uninstall("wc")).rejects.toMatchObject({ status: 502 });
  });

  it("sends nothing — no bearer, no extension token — to a SANDBOX_URL that is not the compose-internal sandbox", async () => {
    // Review finding (PR #2325): only the attach refused a foreign host, so
    // the install had already POSTed the fresh dxt_ bearer and the sandbox
    // token there. MUTATION: drop the host check in settings() → the
    // install is dialled → red.
    const lan = ["192", "168", "1", "50"].join(".");
    for (const baseUrl of ["http://evil:8030", `http://${lan}:8030`, "http://sandbox.example:8030", "ftp://sandbox:8030", "not a url"]) {
      const f = fakeFetch(() => ({ status: 200, body: {} }));
      const c = createExtensionSandboxClient({ baseUrl, serviceToken: "sb-token", fetchImpl: f.impl });
      await expect(
        c.install("wc", {
          workspaceId: "wc", version: "0.1.0", commit: "c", tree: "t", runtime: "python312",
          entrypoint: "tool.py", memoryMb: 64, token: "dxt_x",
        }),
      ).rejects.toMatchObject({ code: "HOST_REFUSED", status: 503 });
      await expect(c.rpc("wc", { jsonrpc: "2.0", id: 1, method: "tools/list" })).rejects.toMatchObject({ code: "HOST_REFUSED" });
      await expect(c.budget()).rejects.toMatchObject({ code: "HOST_REFUSED" });
      expect(f.calls).toEqual([]);
    }
    // The compose name itself, with or without a trailing slash, is dialled.
    const ok = fakeFetch(() => ({ status: 200, body: { availableMb: 1 } }));
    await createExtensionSandboxClient({ baseUrl: "https://sandbox:8030/", serviceToken: "sb-token", fetchImpl: ok.impl }).budget().catch(() => undefined);
    expect(ok.calls[0].url).toMatch(/^https:\/\/sandbox:8030\//);
  });

  it("a hung sandbox is a caller-side TIMEOUT", async () => {
    vi.useFakeTimers();
    try {
      const impl = vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      );
      const c = createExtensionSandboxClient({ serviceToken: "sb", fetchImpl: impl as unknown as typeof fetch });
      const p = c.rpc("wc", { jsonrpc: "2.0", id: 1, method: "ping" }, 1000).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toMatchObject({ code: "TIMEOUT", status: 504 });
    } finally {
      vi.useRealTimers();
    }
  });
});
