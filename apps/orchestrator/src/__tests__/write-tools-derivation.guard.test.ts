/**
 * WARP-2345 — `WRITE_TOOLS` must stay DERIVED from `requiresWrite`.
 *
 * WARP-2305 adds a second dispatch-time classification (the confirmation
 * interceptor and the runtime deny tier), and that is exactly the moment
 * someone reaches for "just a small list of the tools this applies to". A
 * parallel list is the drift this repo gates against everywhere else
 * (`check-schema-drift.sh`, `check-agent-api-sync.mjs`, `build.mjs
 * --check`), so it is pinned here and fails CI rather than review.
 *
 * Mutations these are written to catch:
 *   - replace the derivation at tool-access.service.ts:244-249 with a
 *     literal array of names → the membership-follows-the-flag test reds
 *   - add a hardcoded WRITE_TOOLS-shaped array anywhere else → the grep
 *     guard reds
 *   - give the interceptor or the deny tier a tool list of its own → the
 *     "reads its inputs from flags" test reds
 */
// add-llm-tool:gate — WARP-2496 / WARP-2612: this test asserts on a site an
// agent edits when ADDING a tool, so the `add-llm-tool` skill must name every
// repo file it reads. Drop the pragma and it stops being derived from.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { TOOLS } from "@droplet/tools-core";
import { defaultToolCallInterceptor } from "@droplet/tools-core";
import { WRITE_TOOLS } from "../services/tool-access.service.js";

// `__dirname`, not `import.meta.url`: this package builds to CommonJS,
// where `import.meta` is a TS1470 error. `vitest` does not typecheck
// (esbuild strips types), so only `tsc --noEmit` catches it — same note
// as `confirm-dispatcher-coverage.guard.test.ts`.
const ORCH_SRC = path.resolve(__dirname, "..");
const THIS_FILE = path.join(__dirname, "write-tools-derivation.guard.test.ts");

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@droplet/tools-core");
});

describe("WRITE_TOOLS is derived from requiresWrite (WARP-2345)", () => {
  it("matches the registry's requiresWrite flag exactly, today", () => {
    const derived = [...TOOLS.values()].filter((t) => t.requiresWrite).map((t) => t.name);
    expect([...WRITE_TOOLS].sort()).toEqual(derived.sort());
    expect(derived.length).toBeGreaterThan(0);
  });

  it("MEMBERSHIP FOLLOWS THE FLAG — flipping requiresWrite on a fixture tool moves it", async () => {
    // Proves derivation rather than a coincidental match with a literal
    // array that happens to be correct today. A hardcoded list would
    // ignore both fixtures below and fail.
    const fixture = (requiresWrite: boolean) =>
      new Map([
        [
          "fixture_tool",
          {
            name: "fixture_tool",
            description: "d",
            inputSchema: { type: "object", properties: {} },
            requiresWrite,
            requiresConfirmation: false,
            handler: async () => ({ ok: true as const, data: {} }),
          },
        ],
      ]);

    vi.resetModules();
    vi.doMock("@droplet/tools-core", async () => ({
      ...(await vi.importActual<Record<string, unknown>>("@droplet/tools-core")),
      TOOLS: fixture(true),
    }));
    const asWrite = await import("../services/tool-access.service.js");
    expect(asWrite.WRITE_TOOLS.has("fixture_tool")).toBe(true);

    vi.resetModules();
    vi.doMock("@droplet/tools-core", async () => ({
      ...(await vi.importActual<Record<string, unknown>>("@droplet/tools-core")),
      TOOLS: fixture(false),
    }));
    const asRead = await import("../services/tool-access.service.js");
    expect(asRead.WRITE_TOOLS.has("fixture_tool")).toBe(false);
  });

  it("has no parallel hardcoded WRITE_TOOLS array anywhere in the orchestrator", () => {
    // The ticket's own grep, executed rather than described:
    //   grep -nE 'WRITE_TOOLS\s*[:=]\s*\['
    const pattern = /WRITE_TOOLS\s*[:=]\s*\[/;
    const offenders: string[] = [];

    for (const file of walk(ORCH_SRC)) {
      if (!file.endsWith(".ts")) continue;
      // This guard names the pattern it forbids, so it must exempt itself.
      if (file === THIS_FILE) continue;
      const source = readFileSync(file, "utf8");
      if (pattern.test(source)) offenders.push(path.relative(ORCH_SRC, file));
    }

    expect(offenders, `hardcoded WRITE_TOOLS arrays: ${offenders.join(", ")}`).toEqual([]);
  });

  it("the derivation site itself is a filter over the flag, not a literal", () => {
    const source = readFileSync(
      path.join(ORCH_SRC, "services", "tool-access.service.ts"),
      "utf8",
    );
    expect(source).toContain("filter((t) => t.requiresWrite)");
  });
});

describe("the interceptor and deny tier read flags, not lists of their own (WARP-2345)", () => {
  it("the runtime deny tier ships empty — no built-in roster", () => {
    expect(defaultToolCallInterceptor.denyTier.ids()).toEqual([]);
  });

  it("the interceptor source contains no registry tool names", () => {
    // If enforcement ever grows "the tools this applies to", it becomes a
    // second source of truth that drifts from `requiresConfirmation`.
    const source = readFileSync(
      path.resolve(ORCH_SRC, "../../../packages/tools-core/src/interceptor.ts"),
      "utf8",
    );
    const named = [...TOOLS.keys()].filter((name) => source.includes(`"${name}"`));
    expect(named, `interceptor.ts names registry tools: ${named.join(", ")}`).toEqual([]);
  });

  it("the interceptor decides from the requiresConfirmation flag alone", async () => {
    const { createToolCallInterceptor } = await import("@droplet/tools-core");
    const interceptor = createToolCallInterceptor();

    // Same name, opposite flag — only the flag changes the decision.
    const confirming = interceptor.intercept(
      { name: "same_name", requiresConfirmation: true },
      {},
    );
    const reading = interceptor.intercept(
      { name: "same_name", requiresConfirmation: false },
      {},
    );

    expect(confirming.kind).toBe("confirmation_required");
    expect(reading.kind).toBe("proceed");
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}
