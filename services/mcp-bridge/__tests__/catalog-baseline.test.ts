/**
 * WARP-2651 — the fourth failure state survives a restart of THIS container.
 *
 * `catalog_changed` is detected by comparing one `listTools()` against the
 * previous one, and both live in this process's memory. That is correct while
 * the process lives and useless the moment it does not: after a restart the
 * orchestrator re-opens, the first listing has nothing to compare against, and a
 * surface that moved while we were down is absorbed as if it had always looked
 * that way. ADR-043 §1's rule — *"a tool that vanished between two
 * `listTools()` calls must not surface as 'there is nothing to do'"* — would be
 * defeated by a `docker restart` rather than by a bug.
 *
 * So the baseline is an INPUT (`knownToolNames` / the wire's `knownTools`), and
 * these tests are what stop it being quietly dropped on any of the three hops
 * between the orchestrator and the session.
 */
import { describe, it, expect } from "vitest";
import { RemoteMcpSession, type RemoteMcpConnection } from "../src/remote-session.js";
import { handleBridgeRequest, BridgeSessionStore } from "../src/http-api.js";
import type { OpenSessionInput, SessionFactory } from "../src/session-profiles.js";

const TOKEN = "bridge-token-FAKE-0000000000000000";
const AUTH = `Bearer ${TOKEN}`;

function connectionServing(names: string[]): RemoteMcpConnection {
  return {
    listTools: async () =>
      names.map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
    callTool: async () => ({ content: [], isError: false }),
    close: async () => undefined,
    onClosed: () => undefined,
  };
}

function session(names: string[], knownToolNames?: readonly string[]): RemoteMcpSession {
  return new RemoteMcpSession({
    serverId: "atlassian",
    url: "https://mcp.atlassian.com/v1/sse",
    connect: async () => connectionServing(names),
    ...(knownToolNames !== undefined ? { knownToolNames } : {}),
  });
}

describe("a seeded baseline makes the FIRST listing able to detect drift", () => {
  it("flips to catalog_changed when the re-opened surface differs", async () => {
    const s = session(["getJiraIssue", "deleteJiraIssue"], [
      "getJiraIssue",
      "getConfluencePage",
    ]);
    await s.connect();
    expect(s.state).toBe("ready");

    const tools = await s.listTools();

    expect(s.state).toBe("catalog_changed");
    expect(s.catalogDrift()).toEqual({
      removed: ["getConfluencePage"],
      added: ["deleteJiraIssue"],
    });
    // The tools are STILL returned. "There is nothing to do" is the rendering
    // the ADR forbids; the refusal is a state, not an empty list.
    expect(tools.map((t) => t.name)).toEqual(["getJiraIssue", "deleteJiraIssue"]);
  });

  it("stays ready when the re-opened surface is identical", async () => {
    const s = session(["a", "b"], ["a", "b"]);
    await s.connect();
    await s.listTools();
    expect(s.state).toBe("ready");
    expect(s.catalogDrift()).toBeNull();
  });

  it("blocks dispatch until acknowledgeCatalog, exactly as an in-process drift does", async () => {
    const s = session(["a"], ["a", "b"]);
    await s.connect();
    await s.listTools();
    await expect(s.callTool("a", {})).rejects.toMatchObject({
      code: "REMOTE_MCP_SESSION_NOT_READY",
    });

    expect(s.acknowledgeCatalog().state).toBe("ready");
    await expect(s.callTool("a", {})).resolves.toMatchObject({ isError: false });
  });

  it("WITHOUT a baseline the first listing sets one and never flags drift", async () => {
    // The boot case, and the reason the option is optional rather than `[]`: an
    // empty baseline would make every tool on a brand-new box read as `added`.
    const s = session(["a", "b"]);
    await s.connect();
    await s.listTools();
    expect(s.state).toBe("ready");
  });

  it("does not claim a tool count for a listing that has not happened", async () => {
    const s = session(["a", "b"], ["a", "b"]);
    await s.connect();
    // Seeding the drift baseline must not seed the SERVED catalog: `toolCount`
    // is what this session actually returned, not what we expect it to.
    expect(s.health().toolCount).toBe(0);
    await s.listTools();
    expect(s.health().toolCount).toBe(2);
  });
});

describe("the wire carries the baseline to the session", () => {
  function storeServing(names: string[]) {
    const seen: (readonly string[] | undefined)[] = [];
    const factory: SessionFactory = (input: OpenSessionInput) => {
      seen.push(input.knownTools);
      return session(names, input.knownTools);
    };
    return { seen, store: new BridgeSessionStore({ atlassian: factory }) };
  }

  const openBody = (extra: Record<string, unknown> = {}) => ({
    email: "ops@vendor.example",
    apiToken: "ATATT-FAKE-000000000000",
    cloudId: "00000000-0000-4000-8000-000000000000",
    ...extra,
  });

  it("passes knownTools through open and drift is reported on the first listing", async () => {
    const { seen, store } = storeServing(["getJiraIssue", "deleteJiraIssue"]);
    const opts = { serviceToken: TOKEN, store };

    const opened = await handleBridgeRequest(
      {
        method: "POST",
        path: "/sessions/atlassian/open",
        authorization: AUTH,
        body: openBody({ knownTools: ["getJiraIssue", "getConfluencePage"] }),
      },
      opts,
    );
    expect(opened.status).toBe(200);
    expect(seen).toEqual([["getJiraIssue", "getConfluencePage"]]);

    const listed = await handleBridgeRequest(
      { method: "GET", path: "/sessions/atlassian/tools", authorization: AUTH },
      opts,
    );
    expect(listed.status).toBe(200);
    expect((listed.body as { state: { state: string } }).state.state).toBe("catalog_changed");
  });

  it("an absent knownTools stays ABSENT rather than becoming an empty baseline", async () => {
    const { seen, store } = storeServing(["a"]);
    await handleBridgeRequest(
      {
        method: "POST",
        path: "/sessions/atlassian/open",
        authorization: AUTH,
        body: openBody(),
      },
      { serviceToken: TOKEN, store },
    );
    expect(seen).toEqual([undefined]);
  });

  it("refuses a malformed knownTools instead of silently dropping it", async () => {
    // Dropping it would disable drift detection for that session — the exact
    // failure this field exists to prevent, arriving as a typo.
    const { store } = storeServing(["a"]);
    const res = await handleBridgeRequest(
      {
        method: "POST",
        path: "/sessions/atlassian/open",
        authorization: AUTH,
        body: openBody({ knownTools: "getJiraIssue" }),
      },
      { serviceToken: TOKEN, store },
    );
    expect(res.status).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");
  });

  it("refuses an array with a non-string entry", async () => {
    const { store } = storeServing(["a"]);
    const res = await handleBridgeRequest(
      {
        method: "POST",
        path: "/sessions/atlassian/open",
        authorization: AUTH,
        body: openBody({ knownTools: ["a", 7] }),
      },
      { serviceToken: TOKEN, store },
    );
    expect(res.status).toBe(400);
  });

  it("never echoes the credential back, baseline or not (rule 19)", async () => {
    const { store } = storeServing(["a"]);
    const res = await handleBridgeRequest(
      {
        method: "POST",
        path: "/sessions/atlassian/open",
        authorization: AUTH,
        body: openBody({ knownTools: ["a"] }),
      },
      { serviceToken: TOKEN, store },
    );
    expect(JSON.stringify(res.body)).not.toContain("ATATT-FAKE-000000000000");
  });
});
