/**
 * WARP-2899 — the sandbox client's two export-side calls.
 *
 *   - `bundle(id)` fetches `GET <sandbox>/workspaces/<id>/bundle` with the
 *     bearer and returns the bytes and the `work` head — the ONLY dial an
 *     export makes (the sandbox builds the bundle from its local bare repo);
 *   - `connectorDraft(id, ref)` fetches `…/connector-draft?ref=<ref>` and
 *     narrows the answer;
 *   - a sandbox 4xx is relayed with its status, a 5xx or an unreachable
 *     sandbox is a 502, and a head that is not a commit id is refused rather
 *     than placed in a response header.
 */
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReadStream } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "t" },
}));

import {
  BUNDLE_STALL_TIMEOUT_MS,
  createWorkspaceSandboxClient,
  WorkspaceSandboxError,
} from "../services/workspace.service.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

async function drain(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

function clientWith(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => respond(url, init));
  const client = createWorkspaceSandboxClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
  return { client, fetchImpl };
}

async function rejection(p: Promise<unknown>): Promise<WorkspaceSandboxError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof WorkspaceSandboxError) return err;
    throw err;
  }
  throw new Error("expected a WorkspaceSandboxError");
}

describe("bundle()", () => {
  it("dials only the sandbox's bundle route, with the bearer, and returns bytes and head", async () => {
    const bytes = Buffer.from("# v2 git bundle\nPACK");
    const { client, fetchImpl } = clientWith(
      () =>
        new Response(new Uint8Array(bytes), {
          status: 200,
          headers: { "X-Bundle-Head": HEAD, "X-Bundle-Sha256": sha(bytes), "Content-Length": String(bytes.length) },
        }),
    );
    const out = await client.bundle("ws-a");
    expect(out.head).toBe(HEAD);
    expect(out.size).toBe(bytes.length);
    expect(out.sha256).toBe(sha(bytes));
    expect(Buffer.compare(await drain(out.stream), bytes)).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://sandbox:8030/workspaces/ws-a/bundle");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("relays a 404 and a 413, maps a 5xx and an unreachable sandbox to 502", async () => {
    const notFound = clientWith(() => Response.json({ detail: "no workspace ws-a" }, { status: 404 }));
    expect(await rejection(notFound.client.bundle("ws-a"))).toMatchObject({ status: 404, code: "SANDBOX_ERROR" });
    const tooBig = clientWith(() => Response.json({ detail: "the workspace exceeds the 64 MB export ceiling" }, { status: 413 }));
    expect(await rejection(tooBig.client.bundle("ws-a"))).toMatchObject({ status: 413 });
    const broken = clientWith(() => new Response("boom", { status: 500 }));
    expect(await rejection(broken.client.bundle("ws-a"))).toMatchObject({ status: 502, code: "SANDBOX_ERROR" });
    const down = clientWith(() => {
      throw new TypeError("fetch failed");
    });
    expect(await rejection(down.client.bundle("ws-a"))).toMatchObject({ status: 502, code: "UNREACHABLE" });
  });

  it("refuses an export that states no length or a malformed sha256 — it cannot be verified", async () => {
    const bytes = Buffer.from("PACK");
    for (const headers of <Record<string, string>[]>[
      { "X-Bundle-Head": HEAD },
      { "X-Bundle-Head": HEAD, "X-Bundle-Sha256": "abc", "Content-Length": "4" },
      { "X-Bundle-Head": HEAD, "X-Bundle-Sha256": sha(bytes).toUpperCase(), "Content-Length": "4" },
    ]) {
      const { client } = clientWith(() => new Response(new Uint8Array(bytes), { status: 200, headers }));
      expect(await rejection(client.bundle("ws-a")), JSON.stringify(headers)).toMatchObject({ status: 502 });
    }
  });

  it("refuses a head that is not a commit id — it becomes a filename in a header", async () => {
    for (const head of [null, "", "abc", `${HEAD}\r\nSet-Cookie: x=1`, "../../etc"]) {
      const { client } = clientWith(
        () => new Response(new Uint8Array([1]), { status: 200, headers: head === null ? {} : { "X-Bundle-Head": head.replace(/[\r\n]/g, "") } }),
      );
      expect(await rejection(client.bundle("ws-a")), String(head)).toMatchObject({ status: 502 });
    }
  });
});

describe("importArchive()", () => {
  it("streams source bytes with encoded attribution and always closes its file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archive-client-"));
    const file = join(dir, "source.zip");
    await writeFile(file, "source bytes");
    let source: ReadStream | undefined;
    try {
      const { client, fetchImpl } = clientWith(async (url, init) => {
        expect(url).toBe("http://sandbox:8030/workspaces/ws-a/import?format=tar.gz");
        expect(init.headers).toMatchObject({ Authorization: "Bearer t", "Content-Length": "12",
          "X-Droplet-Author-Name": "%C3%86sa", "X-Droplet-Author-Email": "asa%40example.test" });
        source = init.body as unknown as ReadStream;
        expect((await drain(source)).toString()).toBe("source bytes");
        return Response.json({ id: "ws-a", branch: "work", head: HEAD, dirty: false, tags: [] });
      });
      expect(await client.importArchive!("ws-a", "tar.gz", { name: "Æsa", email: "asa@example.test" }, file, 12)).toMatchObject({ head: HEAD });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(source?.destroyed).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("relays hostile-archive errors and closes a rejected upload stream", async () => {
    const dir = await mkdtemp(join(tmpdir(), "archive-client-"));
    const file = join(dir, "source.zip");
    await writeFile(file, "bad");
    let source: ReadStream | undefined;
    try {
      const { client } = clientWith((_url, init) => {
        source = init.body as unknown as ReadStream;
        return Response.json({ detail: "unsafe path" }, { status: 400 });
      });
      expect(await rejection(client.importArchive!("ws-a", "zip", { name: "A", email: "a@b.test" }, file, 3))).toMatchObject({ status: 400 });
      expect(source?.destroyed).toBe(true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

/**
 * The export's body is piped to the OWNER with backpressure, so the time it
 * takes is set by their connection (a remote-access tunnel can be slow), not by
 * the sandbox. The timeouts pin that: the whole-transfer timer covers only the
 * wait for headers; the body is bounded by a stall timer that every chunk
 * re-arms.
 */
describe("bundle() timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A sandbox whose body the test feeds by hand; the fetch signal aborts it as a real fetch would. */
  function feedableSandbox(total: Buffer) {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    let signal!: AbortSignal;
    const { client } = clientWith((_url, init) => {
      signal = init.signal as AbortSignal;
      const res = new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            body = c;
            signal.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")), { once: true });
          },
        }),
        { status: 200, headers: { "X-Bundle-Head": HEAD, "X-Bundle-Sha256": sha(total), "Content-Length": String(total.length) } },
      );
      return res;
    });
    return { client, feed: (part: Buffer) => body.enqueue(new Uint8Array(part)), end: () => body.close(), signal: () => signal };
  }

  it("a download slower than the whole-transfer budget is not aborted while bytes keep moving", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const parts = [Buffer.from("aaaa"), Buffer.from("bbbb"), Buffer.from("cccc"), Buffer.from("dddd")];
    const total = Buffer.concat(parts);
    const sandbox = feedableSandbox(total);
    const out = await sandbox.client.bundle("ws-a");
    const drained = drain(out.stream);
    // Four chunks a stall-window apart is far past the 125 s whole-transfer
    // budget, yet no gap is a stall.
    for (const part of parts) {
      sandbox.feed(part);
      await vi.advanceTimersByTimeAsync(BUNDLE_STALL_TIMEOUT_MS - 1_000);
    }
    expect(sandbox.signal().aborted).toBe(false);
    sandbox.end();
    expect(Buffer.compare(await drained, total)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a body that goes quiet for the stall window is aborted, and the stream errors as a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sandbox = feedableSandbox(Buffer.from("aaaabbbb"));
    const out = await sandbox.client.bundle("ws-a");
    const settled = drain(out.stream).then(
      () => null,
      (err: unknown) => err,
    );
    sandbox.feed(Buffer.from("aaaa"));
    await vi.advanceTimersByTimeAsync(BUNDLE_STALL_TIMEOUT_MS - 1_000);
    expect(sandbox.signal().aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sandbox.signal().aborted).toBe(true);
    expect(await settled).toMatchObject({ status: 504, code: "TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a sandbox that never sends headers is still bounded by the whole-transfer timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { client } = clientWith(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        }),
    );
    const settled = rejection(client.bundle("ws-a"));
    await vi.advanceTimersByTimeAsync(125_000);
    expect(await settled).toMatchObject({ status: 504, code: "TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closing the stream early leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sandbox = feedableSandbox(Buffer.from("aaaa"));
    const out = await sandbox.client.bundle("ws-a");
    out.stream.on("error", () => undefined);
    out.stream.destroy();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("connectorDraft()", () => {
  it("asks at the ref it is given and narrows the facts", async () => {
    const { client, fetchImpl } = clientWith(() =>
      Response.json({
        draft: { provider: "acme", displayName: "Acme", host: { kind: "static", hosts: ["api.acme.example"] }, files: {}, problems: [] },
      }),
    );
    const facts = await client.connectorDraft("ws-a", "proposal/0.1.0");
    expect(facts).toMatchObject({ provider: "acme", host: { kind: "static", hosts: ["api.acme.example"] } });
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://sandbox:8030/workspaces/ws-a/connector-draft?ref=proposal%2F0.1.0");
  });

  it("no draft is null; a sandbox 404 is relayed", async () => {
    const none = clientWith(() => Response.json({ draft: null }));
    expect(await none.client.connectorDraft("ws-a", "work")).toBeNull();
    const missing = clientWith(() => Response.json({ detail: "no workspace ws-a" }, { status: 404 }));
    expect(await rejection(missing.client.connectorDraft("ws-a", "work"))).toMatchObject({ status: 404 });
  });
});
