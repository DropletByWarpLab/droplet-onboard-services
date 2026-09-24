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
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { SANDBOX_URL: "http://sandbox:8030", SANDBOX_SERVICE_TOKEN: "t" },
}));

import { createWorkspaceSandboxClient, WorkspaceSandboxError } from "../services/workspace.service.js";

const HEAD = "0123456789abcdef0123456789abcdef01234567";

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
      () => new Response(new Uint8Array(bytes), { status: 200, headers: { "X-Bundle-Head": HEAD } }),
    );
    const out = await client.bundle("ws-a");
    expect(out.head).toBe(HEAD);
    expect(Buffer.compare(out.body, bytes)).toBe(0);
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

  it("refuses a head that is not a commit id — it becomes a filename in a header", async () => {
    for (const head of [null, "", "abc", `${HEAD}\r\nSet-Cookie: x=1`, "../../etc"]) {
      const { client } = clientWith(
        () => new Response(new Uint8Array([1]), { status: 200, headers: head === null ? {} : { "X-Bundle-Head": head.replace(/[\r\n]/g, "") } }),
      );
      expect(await rejection(client.bundle("ws-a")), String(head)).toMatchObject({ status: 502 });
    }
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
