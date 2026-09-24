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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TOOL_CATALOG, type ToolDomain } from "@droplet/tools-core";
import type { ToolAccessScope } from "../services/tool-access.service.js";
import { runtimeToolRegistry } from "../services/runtime-tool-registry.service.js";
import { remoteToolClassificationCache } from "../services/remote-tool-classification.service.js";

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

// ── WARP-2897 — runtime tools reach the chat catalog build ────────────
//
// effective-access reports a runtime tool's domain as reachable once a role
// grants it, and the agent loop admits the tool. But every chat turn for a
// family/guest person — and for an admin sending `allowed_tools` — first
// materialises `allowed_tools` HERE, and the loop only ever intersects with
// it. So this function must resolve runtime tools through the same
// process-wide lookup, or the grant reaches nothing in chat. These specs use
// the REAL registry and classification cache (no lookup injected), so they
// also pin that the default argument reads the live state.
describe("narrowAllowedToolsForRole — runtime tools under a scope (WARP-2897)", () => {
  const LIST = "bookings__list_slots";
  const BOOK = "bookings__book_slot";
  const at = new Date("2026-09-22T00:00:00Z");
  const row = (toolName: string, requiresWrite: boolean) => ({
    serverId: "bookings",
    toolName,
    requiresWrite,
    requiresConfirmation: requiresWrite,
    denied: false,
    reviewedBy: "owner",
    reviewedAt: at,
    wireDescription: null,
    firstSeenAt: at,
    lastSeenAt: at,
  });
  const descriptor = (
    wireName: string,
    // Only an operator-mapped domain can admit a runtime tool to a role
    // (PR #2314 review item 1), so the reachable fixtures are operator-sourced.
    domainSource: "operator" | "server" | "default" = "operator",
  ) => ({
    name: `bookings__${wireName}`,
    serverId: "bookings",
    // The extension-domain vocabulary is slice H's decision; the layer model
    // reads strings, so a fixture outside the closed union is cast.
    domain: "ext-bookings" as ToolDomain,
    domainSource,
    description: "fixture",
    inputSchema: {},
  });

  beforeEach(() => {
    listTools.mockReset();
    listTools.mockResolvedValue(
      [FILES_READ, LIST, BOOK].map((name) => ({ name, description: "d", inputSchema: {} })),
    );
    runtimeToolRegistry.registerServerTools("bookings", [
      descriptor("list_slots"),
      descriptor("book_slot"),
    ]);
    remoteToolClassificationCache.seed([row("list_slots", false), row("book_slot", true)]);
  });

  afterEach(() => {
    runtimeToolRegistry.clear();
    remoteToolClassificationCache.seed([]);
  });

  /** MUTATION: stop passing the runtime lookup to `narrowToolNamesForPrincipal`
   *  in `narrowAllowedToolsForRole` — on the default-list branch the first
   *  case goes red, on the explicit-list branch the second. */
  it("a scoped family person's default list carries a READ runtime tool in a granted domain", async () => {
    const out = await narrowAllowedToolsForRole(
      "family",
      undefined,
      false,
      scope(["files", "ext-bookings"]),
    );
    expect(out).toEqual([FILES_READ, LIST]); // the write-classified one is not in reach
  });

  it("a scoped admin's explicit allowed_tools keeps runtime tools the grant admits", async () => {
    expect(
      await narrowAllowedToolsForRole("admin", [FILES_READ, LIST, BOOK], false, scope(["ext-bookings"])),
    ).toEqual([LIST]);
    expect(
      await narrowAllowedToolsForRole(
        "admin",
        [FILES_READ, LIST, BOOK],
        false,
        scope(["ext-bookings"], ["ext-bookings"]),
      ),
    ).toEqual([LIST, BOOK]);
  });

  it("a runtime tool whose domain the role does not grant stays out", async () => {
    expect(
      await narrowAllowedToolsForRole("family", undefined, false, scope(["files"])),
    ).toEqual([FILES_READ]);
  });

  it("an unregistered runtime name stays out (fail-closed with nothing registered)", async () => {
    runtimeToolRegistry.clear();
    expect(
      await narrowAllowedToolsForRole("family", undefined, false, scope(["files", "ext-bookings"])),
    ).toEqual([FILES_READ]);
  });

  it("a runtime tool whose domain the SERVER declared stays out, even with that domain granted", async () => {
    // PR #2314 review item 1: a vendor must not choose which grants admit it.
    runtimeToolRegistry.registerServerTools("bookings", [
      descriptor("list_slots", "server"),
      descriptor("book_slot", "default"),
    ]);
    expect(
      await narrowAllowedToolsForRole(
        "admin",
        [FILES_READ, LIST, BOOK],
        false,
        scope(["files", "ext-bookings"], ["ext-bookings"]),
      ),
    ).toEqual([FILES_READ]);
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
