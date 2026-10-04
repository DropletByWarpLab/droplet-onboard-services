/**
 * WARP-3569 — every confirming tool tells the approving person what it is
 * about to do, or says on the record why it cannot.
 *
 * The chat approval prompt used to show only each argument's key and size
 * ("to: 1 item"), so a person could not tell who would receive a message or
 * which file would be deleted. `confirmation-summary.ts` now carries a
 * per-tool allowlist of the decisive arguments. This gate keeps it honest
 * from both ends, off the LIVE registry rather than a name list:
 *
 *   - a confirming tool with neither an allowlist entry nor a written
 *     waiver fails, so a new tool cannot ship with a blind prompt;
 *   - an entry for a tool that no longer exists, or for an argument the
 *     tool's schema does not declare, fails (stale after a rename);
 *   - an allowlisted key that is a credential or free-text content fails;
 *   - the audit rows stay argument-free.
 *
 * Mutations this file is written to catch: add a confirming tool without
 * classifying it → red; allowlist `password` or `body` → red; rename an
 * argument in a tool schema → red.
 */

// add-llm-tool:gate — WARP-3569: this asserts on a site an agent edits when
// ADDING a confirming tool (`confirmation-summary.ts`), so the
// `add-llm-tool` skill must name every repo file it reads.

import { describe, it, expect } from "vitest";
import { TOOLS } from "@droplet/tools-core";
import {
  APPROVAL_NO_SAFE_VALUE,
  APPROVAL_SHOWN_ARGUMENTS,
  summarizeToolArguments,
} from "../services/confirmation-summary.js";
import { confirmationActivityParams } from "../services/confirmation-audit.js";

const CONFIRMING = [...TOOLS.values()].filter((t) => t.requiresConfirmation === true);

/** Arguments that are credentials or free-text content: never shown. */
const NEVER_SHOWN = new Set([
  "password",
  "encryptionKey",
  "pairing_code",
  "body",
  "subject",
  "note",
  "description",
  "goal",
  "constraints",
  "summary",
  "patient_id",
  "data",
  "draftId",
]);

function schemaKeys(tool: { inputSchema: object }): string[] {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
  return Object.keys(props ?? {});
}

describe("approval prompt values — every confirming tool is classified", () => {
  it("finds the confirming tools (guards against an empty loop)", () => {
    expect(CONFIRMING.length).toBeGreaterThan(30);
  });

  it.each(CONFIRMING.map((t) => [t.name] as const))(
    "%s has an allowlist entry or a written waiver, not both",
    (name) => {
      const shown = Object.hasOwn(APPROVAL_SHOWN_ARGUMENTS, name);
      const waived = Object.hasOwn(APPROVAL_NO_SAFE_VALUE, name);
      expect(shown || waived, `${name} would show the person only argument sizes`).toBe(true);
      expect(shown && waived, `${name} is both allowlisted and waived`).toBe(false);
    },
  );

  it("every waiver gives a reason", () => {
    for (const [name, reason] of Object.entries(APPROVAL_NO_SAFE_VALUE)) {
      expect(reason.length, name).toBeGreaterThan(10);
    }
  });

  it("names no tool that is not a confirming tool in the registry", () => {
    const confirming = new Set(CONFIRMING.map((t) => t.name));
    const stale = [...Object.keys(APPROVAL_SHOWN_ARGUMENTS), ...Object.keys(APPROVAL_NO_SAFE_VALUE)].filter(
      (n) => !confirming.has(n),
    );
    expect(stale).toEqual([]);
  });

  it("allowlists only arguments the tool's schema declares", () => {
    const bad: string[] = [];
    for (const tool of CONFIRMING) {
      const keys = new Set(schemaKeys(tool));
      for (const key of APPROVAL_SHOWN_ARGUMENTS[tool.name] ?? []) {
        if (!keys.has(key)) bad.push(`${tool.name}.${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("never allowlists a credential or free-text content argument", () => {
    const bad: string[] = [];
    for (const [tool, keys] of Object.entries(APPROVAL_SHOWN_ARGUMENTS)) {
      for (const key of keys) {
        // A sensitive key name makes the summary measure the redaction
        // placeholder instead of the 5-character probe value.
        const redacted = summarizeToolArguments("probe", { [key]: "value" }).fields[0]?.detail !== "5 characters";
        if (NEVER_SHOWN.has(key) || redacted) bad.push(`${tool}.${key}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("a tool that takes a recipient, path or share target is allowlisted, not waived", () => {
    const decisive = /^(recipients?|to|paths?|nc_path|thread_id)$/;
    const waivedButDecisive = CONFIRMING.filter(
      (t) => Object.hasOwn(APPROVAL_NO_SAFE_VALUE, t.name) && schemaKeys(t).some((k) => decisive.test(k)),
    ).map((t) => t.name);
    expect(waivedButDecisive).toEqual([]);
  });
});

describe("approval prompt values — the audit chain stays argument-free", () => {
  it("builds the approve, deny and challenge rows from tool name and outcome only", () => {
    const secretPath = "/Shared/payroll-2026.xlsx";
    // Prove the summary does carry the value, so the assertion below bites.
    expect(JSON.stringify(summarizeToolArguments("delete_file", { path: secretPath }))).toContain(secretPath);
    for (const outcome of ["confirmation_required", "confirmation_rejected", "denied", "confirmed"] as const) {
      const row = confirmationActivityParams({ outcome, tool: "delete_file" }, { userId: "romain" });
      expect(JSON.stringify(row)).not.toContain(secretPath);
    }
  });
});
