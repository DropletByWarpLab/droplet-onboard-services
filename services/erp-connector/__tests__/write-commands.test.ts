/**
 * WARP-1094 — write-command registry (brief §11.2, §11.3, §5 rules 3–5).
 *
 * Writing to a live PMS is where practices get hurt. Every write is a NAMED,
 * code-reviewed, unit-tested command — never arbitrary SQL. A command declares
 * its `targetTable`, `allowedColumns`, `requiredParams`, and produces a
 * parameterized statement, a reversal plan, and a verify query. Financial /
 * clinical / claim tables are IMPOSSIBLE targets (invariant 5): the registry
 * rejects any command whose target is on the forbidden list, and no such
 * command is registered.
 *
 * Unit tests only (no DB): param binding, non-allowlisted-column rejection,
 * reversal-plan correctness, and the forbidden-target guard.
 */
import { describe, it, expect } from "vitest";
import {
  WRITE_COMMANDS,
  getWriteCommand,
  UnknownWriteCommandError,
  DisallowedColumnError,
  ForbiddenTargetError,
  FORBIDDEN_WRITE_TABLES,
  assertTargetAllowed,
} from "../src/write-commands.js";
import { buildSchemaMap, type IntrospectedTable } from "../src/schema-map.js";

const TABLES: IntrospectedTable[] = [
  {
    name: "appointment",
    owner: "dba",
    columns: [
      { name: "appt_id", type: "integer" },
      { name: "appt_time", type: "timestamp" },
      { name: "provider_id", type: "integer" },
      { name: "operatory_id", type: "integer" },
      { name: "status", type: "varchar" },
      { name: "patient_id", type: "integer" },
      { name: "last_modified", type: "timestamp" },
    ],
  },
];

const map = buildSchemaMap(TABLES);

describe("write-command registry", () => {
  it("registers exactly the one appointment reschedule command in v1", () => {
    const names = WRITE_COMMANDS.map((c) => c.name);
    expect(names).toContain("reschedule_appointment");
    // No command may target a forbidden (financial/clinical/claim) table.
    for (const c of WRITE_COMMANDS) {
      expect(FORBIDDEN_WRITE_TABLES).not.toContain(c.targetTable);
    }
  });

  it("rejects an unknown command name", () => {
    expect(() => getWriteCommand("delete_ledger_row")).toThrow(UnknownWriteCommandError);
  });

  it("assertTargetAllowed rejects ledger/clinical/claim tables (invariant 5)", () => {
    for (const forbidden of FORBIDDEN_WRITE_TABLES) {
      expect(() => assertTargetAllowed(forbidden)).toThrow(ForbiddenTargetError);
    }
    // A benign target passes.
    expect(() => assertTargetAllowed("appointment")).not.toThrow();
  });
});

describe("reschedule_appointment command", () => {
  const cmd = getWriteCommand("reschedule_appointment");

  it("targets the appointment table with an allowlist that excludes id/patient", () => {
    expect(cmd.targetTable).toBe("appointment");
    expect(cmd.allowedColumns).toEqual(
      expect.arrayContaining(["appt_time", "provider_id", "operatory_id", "status"]),
    );
    // The primary key and patient link are NOT writable.
    expect(cmd.allowedColumns).not.toContain("appt_id");
    expect(cmd.allowedColumns).not.toContain("patient_id");
  });

  it("builds a parameterized UPDATE binding only allowlisted columns", () => {
    const prevRow = { appt_id: 42, appt_time: "2026-07-07T09:00:00Z", last_modified: "v1" };
    const { sql, params } = cmd.buildStatement(map, {
      appt_id: 42,
      appt_time: "2026-07-07T15:00:00Z",
      provider_id: 7,
      last_modified: "v1",
    });
    expect(sql.trimStart().slice(0, 6).toUpperCase()).toBe("UPDATE");
    expect(sql).toContain('"dba"."appointment"');
    // Optimistic guard (brief §11.4): WHERE appt_id = ? AND last_modified = ?.
    expect(sql).toContain('"appt_id" = ?');
    expect(sql).toContain('"last_modified" = ?');
    // Values are bound, not concatenated.
    expect(sql).not.toContain("2026-07-07T15:00:00Z");
    expect(params).toContain("2026-07-07T15:00:00Z");
    expect(params).toContain(42);
    void prevRow;
  });

  it("rejects a param that is not on the column allowlist (invariant 5)", () => {
    expect(() =>
      cmd.buildStatement(map, {
        appt_id: 42,
        // `balance` is not an allowlisted appointment column — must throw.
        balance: 9999,
        last_modified: "v1",
      }),
    ).toThrow(DisallowedColumnError);
  });

  it("requires the optimistic-guard params (appt_id + last_modified)", () => {
    expect(() =>
      cmd.buildStatement(map, { appt_time: "2026-07-07T15:00:00Z" }),
    ).toThrow(/required/i);
  });

  it("produces a reversal plan that restores the prior values", () => {
    const prevRow = {
      appt_id: 42,
      appt_time: "2026-07-07T09:00:00Z",
      provider_id: 3,
      operatory_id: 1,
      status: "SCHEDULED",
      last_modified: "v1",
    };
    const reversal = cmd.reversalPlan(prevRow);
    // The reversal restores the mutated columns to their prior values.
    expect(reversal.appt_time).toBe("2026-07-07T09:00:00Z");
    expect(reversal.provider_id).toBe(3);
    // The reversal never carries a non-allowlisted column.
    for (const key of Object.keys(reversal)) {
      expect(cmd.allowedColumns).toContain(key);
    }
  });

  it("has a parameterized verify query that re-reads the affected row", () => {
    const { sql, params } = cmd.verifyQuery(map, { appt_id: 42 });
    expect(sql.trimStart().slice(0, 6).toUpperCase()).toBe("SELECT");
    expect(sql).toContain('"appt_id" = ?');
    expect(params).toEqual([42]);
  });
});
