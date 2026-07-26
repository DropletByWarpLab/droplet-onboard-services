/**
 * WARP-1529 (RBAC v2 T5) — enforcement point 1: the CATALOG build.
 *
 * `narrowAllowedToolsForRole` is what decides which tools the model is even
 * told about. With a resolved {@link ToolAccessScope} it now also applies the
 * §3 tool-domain axis on top of the shipped ADR-004 write filter. Without one
 * (owner, service principals, and everybody with no AccessRole) it behaves
 * exactly as it did before this ticket — the bit-for-bit floor is pinned by
 * the last describe block and by the untouched voice-tool-rbac suite.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TOOL_CATALOG } from "@droplet/tools-core";
import type { ToolAccessScope } from "../services/tool-access.service.js";

const listTools = vi.hoisted(() => vi.fn());
vi.mock("../services/mcp-client.singleton.js", () => ({
  mcpClient: { listTools, callTool: vi.fn() },
  ensureMcpStarted: vi.fn(),
}));

import { narrowAllowedToolsForRole } from "../routes/llm.js";

const nameOf = (domain: string, write: boolean): string => {
  const entry = TOOL_CATALOG.find(
    (t) => t.domain === domain && t.requiresWrite === write,
  );
  if (!entry) throw new Error(`no ${write ? "write" : "read"} tool in ${domain}`);
  return entry.name;
};

const FILES_READ = nameOf("files", false);
const FILES_WRITE = nameOf("files", true);
const CAMERAS_READ = nameOf("cameras", false);

const scope = (
  domains: string[],
  writeDomains: string[] = [],
  locks = false,
): ToolAccessScope => ({
  domains: new Set(domains),
  writeDomains: new Set(writeDomains),
  locks,
});

const REQUESTED = [FILES_READ, FILES_WRITE, CAMERAS_READ];

describe("narrowAllowedToolsForRole — §3 tool-domain axis", () => {
  beforeEach(() => {
    listTools.mockReset();
    listTools.mockResolvedValue(
      REQUESTED.map((name) => ({ name, description: "d", inputSchema: {} })),
    );
  });

  it("a `view` grant keeps the domain's read tools and drops its write tools", async () => {
    const out = await narrowAllowedToolsForRole(
      "admin",
      REQUESTED,
      false,
      scope(["files"]),
    );
    expect(out).toEqual([FILES_READ]);
  });

  it("a `use` grant keeps the domain's write tools too", async () => {
    const out = await narrowAllowedToolsForRole(
      "admin",
      REQUESTED,
      false,
      scope(["files"], ["files"]),
    );
    expect(out).toEqual([FILES_READ, FILES_WRITE]);
  });

  it("drops a domain absent from the role's grants entirely", async () => {
    const out = await narrowAllowedToolsForRole(
      "admin",
      REQUESTED,
      false,
      scope(["files"], ["files"]),
    );
    expect(out).not.toContain(CAMERAS_READ);
  });

  it("drops a module-off domain even when the role granted it (empty §3 set)", async () => {
    // The module axis is resolved upstream; an off module leaves the domain
    // out of `scope.domains`, so a `use` grant on it is inert here.
    const out = await narrowAllowedToolsForRole(
      "admin",
      REQUESTED,
      false,
      scope([], ["files", "cameras"]),
    );
    expect(out).toEqual([]);
  });

  it("narrows the DEFAULT (no allowed_tools) list for a non-privileged role holder", async () => {
    const out = await narrowAllowedToolsForRole(
      "family",
      undefined,
      false,
      scope(["files", "cameras"]),
    );
    expect(out).toEqual([FILES_READ, CAMERAS_READ]); // write already gone by tier
  });

  it("keeps the tier write filter under a `use` grant for family/guest", async () => {
    // A `use` grant can never widen a family tier past the ADR-004 floor; the
    // resolver strips writeDomains for non-privileged tiers, and the shipped
    // write filter is still applied here regardless.
    const out = await narrowAllowedToolsForRole(
      "family",
      REQUESTED,
      false,
      scope(["files"], ["files"]),
    );
    expect(out).not.toContain(FILES_WRITE);
  });
});

describe("narrowAllowedToolsForRole — no scope = pre-T5 behavior, bit-for-bit", () => {
  beforeEach(() => {
    listTools.mockReset();
    listTools.mockResolvedValue(
      REQUESTED.map((name) => ({ name, description: "d", inputSchema: {} })),
    );
  });

  it("owner/admin keep the requested list verbatim", async () => {
    expect(await narrowAllowedToolsForRole("owner", REQUESTED)).toEqual(REQUESTED);
    expect(await narrowAllowedToolsForRole("admin", REQUESTED, false, null)).toEqual(
      REQUESTED,
    );
  });

  it("owner/admin with no allowed_tools still resolve to `undefined` (chat scope owns it)", async () => {
    expect(await narrowAllowedToolsForRole("owner", undefined)).toBeUndefined();
    expect(
      await narrowAllowedToolsForRole("admin", undefined, false, null),
    ).toBeUndefined();
    expect(listTools).not.toHaveBeenCalled();
  });

  it("family/guest lose write tools and keep every domain", async () => {
    expect(await narrowAllowedToolsForRole("family", REQUESTED, false, null)).toEqual([
      FILES_READ,
      CAMERAS_READ,
    ]);
  });

  it("an explicit empty allowed_tools stays empty (not the full registry)", async () => {
    expect(await narrowAllowedToolsForRole("family", [], false, scope(["files"]))).toEqual(
      [],
    );
  });
});
