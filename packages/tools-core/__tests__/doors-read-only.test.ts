// add-llm-tool:not-a-gate — reads the registry and catalog to pin ADR-055
// §11.5 (no doors_* tool writes), not to gate adding a tool: nothing an agent
// edits when adding a tool is read here beyond what registry.test.ts and
// catalog.test.ts already gate, and this file's imports are not add-a-tool sites.
/**
 * ADR-055 §11.5 — the assistant is READ-ONLY on doors. A forward guard.
 *
 * "The assistant may never open a door, issue a credential, or change a grant.
 * There is no confirmation-token flow that makes it acceptable."
 *
 * P4a ships NO `doors_*` tool (they arrive in P4b, when the module goes live),
 * so today this passes over an empty set. It is here so the day a `doors_*`
 * tool is registered it cannot be one that writes, asks for a confirmation, or
 * is shaped like an unlock, a grant or a credential: the registry fails the
 * build before a reviewer has to remember §11.5.
 *
 * The rule is a pure function so the test can prove it is not vacuous: it is
 * run over a synthetic writing tool and must reject it. Whatever P4b adds is
 * then held to the same function over the live registry and catalog.
 */
import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/registry.js";
import { TOOL_CATALOG } from "../src/catalog.js";

interface DoorsToolShape {
  name: string;
  requiresWrite?: boolean;
  requiresConfirmation?: boolean;
  confirmationOwner?: unknown;
  inputSchema?: unknown;
}

const FORBIDDEN = /unlock|lock_|_lock|open_door|door_open|grant|credential|enrol|revoke|schedule|pin_|badge/i;

/** Every way a tool in the `doors_` namespace breaks §11.5. Empty is a pass. */
function doorsToolViolations(tools: Iterable<DoorsToolShape>): string[] {
  const out: string[] = [];
  for (const t of tools) {
    if (!t.name.trim().toLowerCase().startsWith("doors_")) continue;
    // Read-only must be affirmative: an undeclared flag is not "false".
    if (t.requiresWrite !== false) out.push(`${t.name}: requiresWrite must be false`);
    if (t.requiresConfirmation !== false) out.push(`${t.name}: requiresConfirmation must be false`);
    if (t.confirmationOwner !== undefined) out.push(`${t.name}: owns a confirmation route`);
    if (FORBIDDEN.test(t.name)) out.push(`${t.name}: named like an unlock, grant or credential`);
    const props = Object.keys((t.inputSchema as { properties?: object } | undefined)?.properties ?? {});
    for (const p of props) if (FORBIDDEN.test(p)) out.push(`${t.name}.${p}: shaped like an unlock, grant or credential`);
  }
  return out;
}

describe("ADR-055 §11.5: any doors_ tool is a read, and never an unlock", () => {
  it("the live registry holds no doors_ tool that writes, confirms or unlocks (none exist in P4a)", () => {
    expect(doorsToolViolations(TOOLS.values())).toEqual([]);
  });

  it("the live catalog agrees: no doors_ entry is a write", () => {
    expect(doorsToolViolations(TOOL_CATALOG)).toEqual([]);
  });

  it("is not vacuous: the rule rejects a writing tool, a confirming one, an undeclared one and an unlock-shaped one", () => {
    const read = { name: "doors_list", requiresWrite: false, requiresConfirmation: false, inputSchema: { properties: { limit: {} } } };
    expect(doorsToolViolations([read])).toEqual([]);
    expect(doorsToolViolations([{ ...read, name: "doors_open", requiresWrite: true }])).not.toEqual([]);
    expect(doorsToolViolations([{ ...read, requiresConfirmation: true }])).not.toEqual([]);
    expect(doorsToolViolations([{ name: "doors_list", requiresConfirmation: false }])).not.toEqual([]);
    expect(doorsToolViolations([{ ...read, name: "doors_unlock" }])).not.toEqual([]);
    expect(doorsToolViolations([{ ...read, inputSchema: { properties: { credential_id: {} } } }])).not.toEqual([]);
    expect(doorsToolViolations([{ ...read, name: " Doors_Grant", requiresWrite: true }])).not.toEqual([]);
  });

  it("does not reach into other namespaces: `doors` in the middle of a name is not reserved", () => {
    expect(doorsToolViolations([{ name: "get_doors_status", requiresWrite: true, requiresConfirmation: true }])).toEqual([]);
  });
});
