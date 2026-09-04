/**
 * WARP-555: read-only tool catalog metadata.
 *
 * The dashboard `/tools` surface renders every built-in tool grouped by
 * domain, with `requiresWrite` / `requiresConfirmation` badges. The wire
 * shape it needs (domain + the two safety flags) is not on the JSON-RPC
 * `tools/list` response, so `tools-core` exposes a `TOOL_CATALOG` that
 * layers a `domain` onto each registered tool.
 *
 * The non-negotiable invariant these tests pin: the catalog is derived
 * from the canonical `TOOLS` registry, so it can never silently drift
 * out of sync when a tool is added to `registry.ts`. `name`,
 * `description`, `requiresWrite`, and `requiresConfirmation` are read off
 * the live `Tool` object — only `domain` is new metadata.
 */

// add-llm-tool:gate — WARP-2496 / WARP-2612: this test asserts on a site an
// agent edits when ADDING a tool, so the `add-llm-tool` skill must name every
// repo file it reads. Drop the pragma and it stops being derived from.

import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/registry.js";
import {
  TOOL_CATALOG,
  TOOL_DOMAINS,
  HOME_DESCRIPTION_BY_NAME,
  type ToolCatalogEntry,
} from "../src/catalog.js";

describe("TOOL_CATALOG (WARP-555)", () => {
  it("has exactly one catalog entry per registered tool", () => {
    expect(TOOL_CATALOG.length).toBe(TOOLS.size);
    const catalogNames = new Set(TOOL_CATALOG.map((t) => t.name));
    expect(catalogNames.size).toBe(TOOL_CATALOG.length); // no duplicates
    for (const name of TOOLS.keys()) {
      expect(catalogNames.has(name)).toBe(true);
    }
  });

  it("reads name/description/flags straight off the live Tool (no drift)", () => {
    for (const entry of TOOL_CATALOG) {
      const tool = TOOLS.get(entry.name);
      expect(tool, `catalog tool ${entry.name} must be registered`).toBeDefined();
      expect(entry.description).toBe(tool!.description);
      expect(entry.requiresWrite).toBe(tool!.requiresWrite);
      expect(entry.requiresConfirmation).toBe(tool!.requiresConfirmation);
    }
  });

  it("assigns every tool a non-empty domain drawn from TOOL_DOMAINS", () => {
    const known = new Set(TOOL_DOMAINS);
    for (const entry of TOOL_CATALOG) {
      expect(entry.domain, `${entry.name} needs a domain`).toBeTruthy();
      expect(known.has(entry.domain)).toBe(true);
    }
  });

  it("lists domains in a stable, de-duplicated order", () => {
    expect(new Set(TOOL_DOMAINS).size).toBe(TOOL_DOMAINS.length);
    // network is the first surface in the IA; pin it so the filter order
    // doesn't reshuffle under the user without a test catching it.
    expect(TOOL_DOMAINS[0]).toBe("network");
    // every domain in the list is actually used by at least one tool
    const used = new Set(TOOL_CATALOG.map((t) => t.domain));
    for (const d of TOOL_DOMAINS) {
      expect(used.has(d), `domain ${d} is declared but unused`).toBe(true);
    }
  });

  it("classifies known anchor tools into the expected domain", () => {
    const byName = new Map<string, ToolCatalogEntry>(
      TOOL_CATALOG.map((t) => [t.name, t]),
    );
    expect(byName.get("list_network_devices")?.domain).toBe("network");
    expect(byName.get("list_files")?.domain).toBe("files");
    expect(byName.get("list_cameras")?.domain).toBe("cameras");
    expect(byName.get("run_scene")?.domain).toBe("smart-home");
    expect(byName.get("email_search")?.domain).toBe("email");
    expect(byName.get("memory_recall")?.domain).toBe("memory");
    expect(byName.get("pm_list_projects")?.domain).toBe("pm");
    expect(byName.get("get_system_health")?.domain).toBe("system");
    expect(byName.get("business_profile_get")?.domain).toBe("business");
    // WARP-899/WARP-900 — data-utility tools live in the data domain.
    expect(byName.get("encode_text")?.domain).toBe("data");
    expect(byName.get("decode_text")?.domain).toBe("data");
    expect(byName.get("hash_text")?.domain).toBe("data");
    expect(byName.get("convert_data_format")?.domain).toBe("data");
    expect(byName.get("format_json")?.domain).toBe("data");
    // WARP-901 — misc dev utilities live in the data domain.
    expect(byName.get("timestamp_convert")?.domain).toBe("data");
    expect(byName.get("uuid_generate")?.domain).toBe("data");
    expect(byName.get("regex_test")?.domain).toBe("data");
  });

  it("marks a destructive tool as write + confirm and a read tool as neither", () => {
    const byName = new Map(TOOL_CATALOG.map((t) => [t.name, t]));
    const block = byName.get("block_network_device");
    expect(block?.requiresWrite).toBe(true);
    expect(block?.requiresConfirmation).toBe(true);

    const list = byName.get("list_network_devices");
    expect(list?.requiresWrite).toBe(false);
    expect(list?.requiresConfirmation).toBe(false);
  });

  it("gives every registered tool explicit home-user copy (no silent fallback)", () => {
    // The dashboard renders `homeDescription`, not the agent-facing
    // `description`. A tool with no HOME_DESCRIPTION_BY_NAME entry falls back
    // to a humanized name — harmless at runtime, but it means a new tool
    // shipped without home-user copy. Fail loudly here instead (ADR-002).
    const missing = [...TOOLS.keys()].filter(
      (name) => !(name in HOME_DESCRIPTION_BY_NAME),
    );
    expect(
      missing,
      `tools missing home-user copy in HOME_DESCRIPTION_BY_NAME: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("never renders the agent description as home copy", () => {
    for (const entry of TOOL_CATALOG) {
      expect(entry.homeDescription, `${entry.name} needs home copy`).toBeTruthy();
      expect(entry.homeDescription).not.toBe(entry.description);
    }
  });
});
