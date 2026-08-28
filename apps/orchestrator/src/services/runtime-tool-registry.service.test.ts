/**
 * WARP-2443 / WARP-2444 — the dynamic universe, and its domain stamp.
 *
 * The defect being closed is silent: a runtime-registered tool with no domain
 * is never selected, never errors, and looks from the outside exactly like a
 * model that chose not to use it. These tests make that condition
 * reproducible on demand and then prove it is gone.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  RuntimeToolRegistry,
  resolveRuntimeToolDomain,
  DEFAULT_RUNTIME_TOOL_DOMAIN,
  runtimeToolRegistry,
  type RuntimeToolDescriptor,
} from "./runtime-tool-registry.service.js";
import {
  ATLASSIAN_REMOTE_TOOLS,
  SLACK_REMOTE_TOOLS,
} from "./__fixtures__/remote-tool-catalog.js";

const descriptor = (
  over: Partial<RuntimeToolDescriptor> & { name: string },
): RuntimeToolDescriptor => ({
  serverId: "srv",
  domain: "pm",
  domainSource: "server",
  description: "a remote tool",
  inputSchema: { type: "object", properties: {} },
  ...over,
});

describe("resolveRuntimeToolDomain (WARP-2444)", () => {
  it("prefers an operator mapping over the server's own declaration", () => {
    // The operator is the only party who can see how their box is organised,
    // and a server's self-declared domain is a hint from OUTSIDE the trust
    // boundary. MUTATION: flip the precedence and this goes red.
    const r = resolveRuntimeToolDomain({
      toolName: "jira_get_issue",
      serverId: "atlassian",
      operatorDomain: "system",
      serverDomain: "pm",
    });
    expect(r.domain).toBe("system");
    expect(r.source).toBe("operator");
  });

  it("uses the server's declaration when no operator mapping exists", () => {
    const r = resolveRuntimeToolDomain({
      toolName: "slack_send_message",
      serverId: "slack",
      serverDomain: "team_chat",
    });
    expect(r.domain).toBe("team_chat");
    expect(r.source).toBe("server");
  });

  it("falls back to the default domain and RECORDS that it did", () => {
    const r = resolveRuntimeToolDomain({
      toolName: "mystery_tool",
      serverId: "unknown-server",
    });
    // The fallback is a degraded outcome, not a working configuration — but a
    // poor domain is diagnosable where NO domain is silent. The source stamp
    // is what makes it diagnosable.
    expect(r.domain).toBe(DEFAULT_RUNTIME_TOOL_DOMAIN);
    expect(r.source).toBe("default");
  });

  it("never returns an undefined domain — the silent-failure condition is unreachable", () => {
    // This is the invariant the whole subtask exists for. MUTATION: let the
    // resolver return `{ domain: undefined }` for the no-hint case and this
    // goes red, reproducing today's silent unselectability on demand.
    for (const input of [
      { toolName: "a", serverId: "s" },
      { toolName: "b", serverId: "s", serverDomain: "files" as const },
      { toolName: "c", serverId: "s", operatorDomain: "email" as const },
    ]) {
      const r = resolveRuntimeToolDomain(input);
      expect(r.domain).toBeDefined();
      expect(typeof r.domain).toBe("string");
    }
  });
});

describe("RuntimeToolRegistry (WARP-2443)", () => {
  let reg: RuntimeToolRegistry;
  beforeEach(() => {
    reg = new RuntimeToolRegistry();
  });

  it("registers a server's tools and lists them", () => {
    reg.registerServerTools("atlassian", ATLASSIAN_REMOTE_TOOLS);
    expect(reg.list().length).toBe(ATLASSIAN_REMOTE_TOOLS.length);
    expect(reg.list().map((t) => t.name)).toContain("jira_search_issues");
    expect(reg.serverIds()).toEqual(["atlassian"]);
  });

  it("adding or removing a server changes the universe without a restart", () => {
    // WARP-2443 acceptance criterion, asserted directly.
    expect(reg.list()).toHaveLength(0);

    reg.registerServerTools("atlassian", ATLASSIAN_REMOTE_TOOLS);
    expect(reg.list()).toHaveLength(ATLASSIAN_REMOTE_TOOLS.length);

    reg.registerServerTools("slack", SLACK_REMOTE_TOOLS);
    expect(reg.list()).toHaveLength(
      ATLASSIAN_REMOTE_TOOLS.length + SLACK_REMOTE_TOOLS.length,
    );
    expect(reg.serverIds()).toEqual(["atlassian", "slack"]);

    reg.unregisterServer("atlassian");
    expect(reg.list()).toHaveLength(SLACK_REMOTE_TOOLS.length);
    expect(reg.list().every((t) => t.serverId === "slack")).toBe(true);
  });

  it("REPLACES a server's tool set rather than merging it", () => {
    // A server's tools/list response is the whole truth about that server, so
    // a tool that disappeared from it must disappear here. MUTATION: change
    // `set` to a merge and the removed tool stays advertised forever — this
    // goes red.
    reg.registerServerTools("srv", [
      descriptor({ name: "tool_a" }),
      descriptor({ name: "tool_b" }),
    ]);
    expect(reg.list().map((t) => t.name)).toEqual(["tool_a", "tool_b"]);

    reg.registerServerTools("srv", [descriptor({ name: "tool_a" })]);
    expect(reg.list().map((t) => t.name)).toEqual(["tool_a"]);
  });

  it("stamps serverId ownership on every descriptor", () => {
    reg.registerServerTools("owner-server", [
      descriptor({ name: "t1", serverId: "lying-about-it" }),
    ]);
    // The registration key wins over whatever the descriptor claimed, so a
    // server cannot register tools attributed to a different server and
    // survive that server's unregistration.
    expect(reg.list()[0].serverId).toBe("owner-server");
    reg.unregisterServer("owner-server");
    expect(reg.list()).toHaveLength(0);
  });

  it("lists deterministically — same registrations, same order", () => {
    // WARP-2443: "the same input yields the same subset". Selection filters
    // this list, so a non-deterministic list means a non-deterministic turn.
    const a = new RuntimeToolRegistry();
    a.registerServerTools("zeta", [descriptor({ name: "z1" })]);
    a.registerServerTools("alpha", [descriptor({ name: "a1" })]);

    const b = new RuntimeToolRegistry();
    b.registerServerTools("alpha", [descriptor({ name: "a1" })]);
    b.registerServerTools("zeta", [descriptor({ name: "z1" })]);

    // Registration ORDER differs; listing order must not.
    expect(a.list().map((t) => t.name)).toEqual(b.list().map((t) => t.name));
    expect(a.list().map((t) => t.name)).toEqual(["a1", "z1"]);
  });

  it("unregistering an unknown server is a no-op, not an error", () => {
    expect(() => reg.unregisterServer("never-registered")).not.toThrow();
    expect(reg.list()).toHaveLength(0);
  });

  it("the process-wide registry ships EMPTY, so the local-only path is unchanged", () => {
    // Until WARP-2300 wires a transport, production has no runtime tools —
    // which is exactly why selection's local-only behaviour must be
    // byte-identical when the list is empty.
    expect(runtimeToolRegistry.list()).toHaveLength(0);
  });
});
