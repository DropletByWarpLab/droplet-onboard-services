/**
 * WARP-2627 — ADR-043 §5 as an assertion, plus the drift gate on the wire
 * contract that assertion forces us to duplicate.
 *
 * ## The §5 tripwire
 *
 * ADR-043 §5 names it verbatim: *"a reviewer who sees
 * `StreamableHTTPClientTransport` or `SSEClientTransport` land in orchestrator
 * product code should treat it as a breach of this ADR."* Before WARP-2627 that
 * was a review instruction. Now the bridge exists, so it can be a test.
 *
 * SCOPE, stated precisely, because two nearby things are NOT breaches:
 *
 *   - `StdioClientTransport` (`mcp-client.service.ts`) is the LOCAL child
 *     process — in-process trusted, and §5's rule is about a session to a
 *     server we do not own.
 *   - `services/mcp-server/__tests__/http-roundtrip.test.ts` dials the box's
 *     OWN inbound MCP server over Streamable HTTP. It is a test, and its
 *     counterparty is us.
 *
 * So the gate is: a REMOTE client transport (`client/streamableHttp`,
 * `client/sse`) in PRODUCT code, anywhere but `services/mcp-bridge`.
 *
 * ## The wire-contract drift gate
 *
 * `mcp-bridge.client.ts` re-declares the bridge's session states and error
 * codes, and `remote-mcp-servers.ts` re-declares its server id, because
 * importing `@droplet/mcp-bridge` would drag exactly the transport above into
 * this workspace's module graph. That duplication is deliberate; leaving it
 * UNCHECKED would not be. These tests read the bridge's own source as text —
 * no import, so the tripwire above stays a grep — and fail when either side
 * moves.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { providerDescriptor } from "@droplet/shared-types";
import { REMOTE_MCP_SESSION_STATES, BRIDGE_ERROR_CODES } from "./mcp-bridge.client.js";
import { ATLASSIAN_REMOTE_SERVER_ID } from "./remote-mcp-servers.js";
import { ATLASSIAN_SERVER_ID } from "./atlassian-tool-policy.js";

/** Walk up from the CWD to the repo root. `process.cwd()` rather than
 *  `import.meta.url`: this workspace compiles to CommonJS and `import.meta`
 *  is a TS1470 there (the trap `add-llm-tool-skill.test.ts` already hit). */
function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    try {
      statSync(join(dir, "docker", "docker-compose.yml"));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error("could not locate the repo root from " + process.cwd());
}

const ROOT = repoRoot();
const BRIDGE_SRC = join(ROOT, "services", "mcp-bridge", "src");

function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8");
}

/** Every product `.ts`/`.tsx` under a workspace's source root. Tests and
 *  `dist` are excluded — the rule is about product code. */
function productSources(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      productSources(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.(test|spec)\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

const REMOTE_TRANSPORT = /@modelcontextprotocol\/sdk\/client\/(streamableHttp|sse)/;

describe("ADR-043 §5 — the orchestrator holds no outbound MCP socket", () => {
  it("no product file outside services/mcp-bridge imports a REMOTE client transport", () => {
    const roots = [
      join(ROOT, "apps", "orchestrator", "src"),
      join(ROOT, "apps", "web-dashboard"),
      join(ROOT, "packages", "tools-core", "src"),
      join(ROOT, "packages", "shared-types", "src"),
      join(ROOT, "services", "mcp-server", "src"),
      join(ROOT, "services", "erp-connector", "src"),
      join(ROOT, "services", "matter-controller", "src"),
    ];
    const offenders = roots
      .flatMap((r) => productSources(r))
      .filter((f) => REMOTE_TRANSPORT.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(offenders).toEqual([]);
  });

  it("the ONE permitted importer is the bridge's single transport module", () => {
    const importers = productSources(BRIDGE_SRC)
      .filter((f) => REMOTE_TRANSPORT.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    // Exactly one, so "keep the SDK import to one file" stays a fact rather
    // than an intention. A second one here is a real finding, not noise.
    expect(importers).toEqual(["services/mcp-bridge/src/streamable-http.ts"]);
  });

  it("the orchestrator does not depend on @droplet/mcp-bridge", () => {
    const pkg = JSON.parse(read(ROOT, "apps", "orchestrator", "package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain("@droplet/mcp-bridge");
    expect(Object.keys(pkg.devDependencies ?? {})).not.toContain("@droplet/mcp-bridge");
  });
});

/** Pull the quoted string literals out of one declaration block. */
function literalsIn(source: string, startMarker: string, endMarker: string): string[] {
  const from = source.indexOf(startMarker);
  expect(from, `"${startMarker}" not found in the bridge's source`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(endMarker, from);
  expect(to, `"${endMarker}" not found after "${startMarker}"`).toBeGreaterThan(from);
  const block = source.slice(from, to);
  return [...block.matchAll(/"([a-z_][a-z0-9_]*)"/gi)].map((m) => m[1]!);
}

describe("wire-contract drift gate (the duplication §5 forces)", () => {
  it("the session-state vocabulary matches the bridge's", () => {
    const bridge = literalsIn(
      read(BRIDGE_SRC, "session-state.ts"),
      "export const REMOTE_MCP_SESSION_STATES",
      "] as const;",
    );
    expect([...REMOTE_MCP_SESSION_STATES]).toEqual(bridge);
  });

  it("the error-code vocabulary matches the bridge's", () => {
    const bridge = literalsIn(
      read(BRIDGE_SRC, "http-api.ts"),
      "export type BridgeErrorCode =",
      ";\n",
    );
    expect([...BRIDGE_ERROR_CODES]).toEqual(bridge);
  });

  it("the Atlassian server id agrees across all FOUR declarations", () => {
    // `services/mcp-bridge/src/atlassian.ts` (the wire path segment),
    // `remote-mcp-servers.ts` (what this process attaches),
    // `atlassian-tool-policy.ts` (the classification table's scope) and — since
    // WARP-2650 — the provider descriptor's `mcpServerId`, which is what the
    // connect flow's row will be keyed on. Four copies exist because the bridge
    // may not be imported by the orchestrator (ADR-043 §5) NOR by
    // `@droplet/shared-types`, which is bundled into the Next.js dashboard; the
    // policy table is orchestrator-owned by ADR-043 §2. This is what stops them
    // drifting silently into an empty tool list.
    //
    // The descriptor's copy is the one that matters most for a fresh box: a
    // divergence there means the operator connects an account under one id and
    // the gate looks for a row under another, which reads as "no account
    // connected" with a perfectly good credential sitting in the database.
    const bridgeSource = read(BRIDGE_SRC, "atlassian.ts");
    const match = /export const ATLASSIAN_SERVER_ID = "([a-z0-9-]+)";/.exec(bridgeSource);
    expect(match, "ATLASSIAN_SERVER_ID literal not found in the bridge").not.toBeNull();
    expect(ATLASSIAN_REMOTE_SERVER_ID).toBe(match![1]);
    expect(ATLASSIAN_SERVER_ID).toBe(match![1]);

    const descriptor = providerDescriptor(match![1]);
    expect(descriptor, `no provider descriptor for "${match![1]}"`).toBeDefined();
    expect(descriptor?.track).toBe("mcp");
    // Narrowed rather than cast: only the `mcp` arm carries `mcpServerId`, so
    // this assertion cannot survive the track being changed out from under it.
    expect(descriptor?.track === "mcp" && descriptor.mcpServerId).toBe(match![1]);
    // And the id the gate reads is the PROVIDER key on the row, which the
    // credential route writes from `descriptor.id`. Asserting both is not
    // ceremony: `mcpServerId` and `id` are free to differ in the type, and a
    // vendor whose bridge id differs from its provider key is exactly how a
    // future track would break this.
    expect(descriptor?.id).toBe(match![1]);
  });

  it("every path this client calls is a route the bridge serves", () => {
    const api = read(BRIDGE_SRC, "http-api.ts");
    const client = read(ROOT, "apps", "orchestrator", "src", "services", "mcp-bridge.client.ts");
    // The actions the client builds into `/sessions/${serverId}/<action>`.
    const actions = [...client.matchAll(/\/sessions\/\$\{this\.serverId\}\/([a-z-]+)/g)].map(
      (m) => m[1]!,
    );
    expect(actions.sort()).toEqual(["acknowledge-catalog", "call", "open", "state", "tools"]);
    for (const action of actions) {
      expect(api, `bridge has no "${action}" route`).toContain(`case "${action}":`);
    }
  });
});
