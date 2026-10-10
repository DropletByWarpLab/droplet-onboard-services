/**
 * WARP-3961 — `POST /oauth/sites`: which Atlassian sites a fresh sign-in reaches.
 *
 * NOTHING HERE DIALS: the transport is an injected double. The token is an
 * obviously fake string.
 */
import { describe, it, expect, vi } from "vitest";
import { ATLASSIAN_MCP_OAUTH_URL, discoverAtlassianSites } from "../src/atlassian.js";
import { handleOAuthRoute } from "../src/oauth/routes.js";
import type { RemoteMcpConnection, RemoteMcpConnectInput, RemoteToolCallOutcome } from "../src/remote-session.js";

const FAKE_ACCESS = "FAKE-ACCESS-TOKEN-0000";
const SITE = { id: "00000000-0000-4000-8000-000000000000", url: "https://acme.atlassian.net", name: "Acme" };

function double(outcome: RemoteToolCallOutcome | Error, onCall?: (name: string, args: Record<string, unknown>) => void) {
  const inputs: RemoteMcpConnectInput[] = [];
  const close = vi.fn(async () => {});
  const connect = async (input: RemoteMcpConnectInput): Promise<RemoteMcpConnection> => {
    inputs.push(input);
    return {
      listTools: async () => [],
      callTool: async (name, args) => {
        onCall?.(name, args);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
      close,
      onClosed: () => {},
    };
  };
  return { connect, inputs, close };
}

const text = (v: unknown): RemoteToolCallOutcome => ({ content: [{ type: "text", text: JSON.stringify(v) }], isError: false });

describe("discoverAtlassianSites", () => {
  it("parses a text result, sends NO cloudId, dials the OAuth endpoint with the bearer, and closes", async () => {
    let seen: { name: string; args: Record<string, unknown> } | undefined;
    const d = double(text([SITE]), (name, args) => (seen = { name, args }));
    expect(await discoverAtlassianSites(FAKE_ACCESS, { connect: d.connect })).toEqual([SITE]);
    expect(seen).toEqual({ name: "getAccessibleAtlassianResources", args: {} });
    expect(d.inputs[0]!.url).toBe(ATLASSIAN_MCP_OAUTH_URL);
    expect(d.inputs[0]!.headers).toEqual({ Authorization: `Bearer ${FAKE_ACCESS}` });
    expect(d.close).toHaveBeenCalledTimes(1);
  });

  it("prefers structuredContent and accepts a wrapped list", async () => {
    const d = double({ content: [], isError: false, structuredContent: { resources: [SITE] } });
    expect(await discoverAtlassianSites(FAKE_ACCESS, { connect: d.connect })).toEqual([SITE]);
  });

  it("drops malformed entries and keeps an empty list as zero sites", async () => {
    const bad = [{ id: "", url: SITE.url }, { id: "x", url: "http://insecure.example" }, null, "s"];
    const d = double(text(bad));
    expect(await discoverAtlassianSites(FAKE_ACCESS, { connect: d.connect })).toEqual([]);
  });

  it("refuses a non-array answer and closes", async () => {
    const d = double(text({ nope: true }));
    await expect(discoverAtlassianSites(FAKE_ACCESS, { connect: d.connect })).rejects.toMatchObject({ code: "SITES_UNAVAILABLE" });
    expect(d.close).toHaveBeenCalledTimes(1);
  });

  it("closes the session when the tool errors", async () => {
    const d = double(new Error("boom"));
    await expect(discoverAtlassianSites(FAKE_ACCESS, { connect: d.connect })).rejects.toMatchObject({ code: "SITES_UNAVAILABLE" });
    expect(d.close).toHaveBeenCalledTimes(1);
  });

  it("treats an isError result as unavailable", async () => {
    const d = double({ content: [], isError: true });
    await expect(discoverAtlassianSites(FAKE_ACCESS, { connect: d.connect })).rejects.toMatchObject({ code: "SITES_UNAVAILABLE" });
  });

  it("gives up at the deadline and still closes a late connection", async () => {
    const close = vi.fn(async () => {});
    const connect = () =>
      new Promise<RemoteMcpConnection>((resolve) =>
        setTimeout(
          () => resolve({ listTools: async () => [], callTool: async () => text([]), close, onClosed: () => {} }),
          60,
        ),
      );
    await expect(discoverAtlassianSites(FAKE_ACCESS, { connect, timeoutMs: 5 })).rejects.toMatchObject({ code: "SITES_UNAVAILABLE" });
    await new Promise((r) => setTimeout(r, 120));
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("POST /oauth/sites", () => {
  it("answers {sites} and never echoes the token", async () => {
    const d = double(text([SITE]));
    const res = await handleOAuthRoute("sites", "POST", { accessToken: FAKE_ACCESS }, {}, d.connect);
    expect(res).toEqual({ status: 200, body: { sites: [SITE] } });
    expect(JSON.stringify(res)).not.toContain(FAKE_ACCESS);
  });

  it("400s a missing token without dialing", async () => {
    const d = double(text([SITE]));
    const res = await handleOAuthRoute("sites", "POST", {}, {}, d.connect);
    expect(res.status).toBe(400);
    expect(d.inputs).toHaveLength(0);
  });

  it("502 SITES_UNAVAILABLE on a tool error, and only POST is allowed", async () => {
    const d = double(new Error("boom"));
    const res = await handleOAuthRoute("sites", "POST", { accessToken: FAKE_ACCESS }, {}, d.connect);
    expect(res.status).toBe(502);
    expect(JSON.stringify(res)).not.toContain(FAKE_ACCESS);
    expect((await handleOAuthRoute("sites", "GET", undefined, {}, d.connect)).status).toBe(405);
  });
});
