/**
 * WARP-3703 (ADR-043 TC-1.3) — the compiled classification table, per server.
 *
 * `atlassian-tool-policy.test.ts` proves the Atlassian table and the policy it
 * drives, and is the regression net for "Atlassian is unchanged" — it is not
 * edited. This file proves the GENERIC half a second vendor will sit on: the
 * row shape, the policy built from rows, the invariants a vendor's data PR must
 * keep (and that each one is enforced, by feeding the validator a table that
 * breaks it), and the registry that says which table speaks for which server.
 *
 * Nothing dials, and no vendor is registered. The vendor below is a TEST-ONLY
 * fixture table, built in this file and passed in by hand; the production
 * registry of vendor tables is asserted to be exactly what ships (none today).
 */
import { describe, it, expect, vi } from "vitest";
import { providerDescriptor } from "@droplet/shared-types";

import {
  ATLASSIAN_DENY_CODES,
  ATLASSIAN_SERVER_ID,
  ATLASSIAN_TOOL_CLASSIFICATIONS,
  createAtlassianRemoteCallPolicy,
} from "./atlassian-tool-policy.js";
import {
  DENY_ALL_REMOTE_TOOLS,
  namespacedToolName,
  type RemoteCallPolicy,
} from "./mcp-multiplexer.service.js";
import { RECORD_DENY_CODES } from "./remote-tool-classification.service.js";
import { remoteServerDomain } from "./remote-mcp-servers.js";
import {
  MAX_NAMESPACED_TOOL_NAME_LENGTH,
  REMOTE_TABLE_DENY_CODES,
  REMOTE_TOOL_TABLES,
  REMOTE_TOOL_TABLE_DEFS,
  buildRemoteToolTables,
  classifyTableRow,
  createTablePolicy,
  remoteReadToolsOf,
  remoteToolTablePolicy,
  remoteToolTableSetViolations,
  remoteToolTableViolations,
  type RemoteToolRow,
  type RemoteToolTableDef,
} from "./remote-tool-tables.js";

const FIXTURE_ID = "fixture-bearer";

/** A TEST-ONLY vendor table: every disposition, and one row of each grade. */
const FIXTURE_ROWS: readonly RemoteToolRow[] = [
  { name: "get_thing", grade: "read", v1: "allowed" },
  { name: "list_things", grade: "read", v1: "allowed" },
  {
    name: "peek_secret_thing",
    grade: "read",
    v1: "excluded",
    note: "A read, held back for the context budget — promotable one row at a time.",
  },
  { name: "save_thing", grade: "write", v1: "blocked-write", note: "ADR-043 §3." },
  { name: "wipe_things", grade: "destructive", v1: "blocked-write", note: "ADR-043 §3." },
];

const FIXTURE_DEF: RemoteToolTableDef = {
  serverId: FIXTURE_ID,
  rows: FIXTURE_ROWS,
  provenance: "Names taken from a fixture, NOT a live tools/list; Warp Lab holds no credential.",
};

function decide(policy: RemoteCallPolicy, wireName: string, serverId = FIXTURE_ID) {
  return policy({
    serverId,
    wireName,
    namespacedName: namespacedToolName(serverId, wireName),
    args: {},
  });
}

describe("a well-formed table breaks no invariant (TC-1.3)", () => {
  it("is clean", () => {
    expect(remoteToolTableViolations(FIXTURE_DEF)).toEqual([]);
  });
});

describe("every invariant is enforced, by a table that breaks it (TC-1.3)", () => {
  const row = (over: Partial<RemoteToolRow> & Pick<RemoteToolRow, "name">): RemoteToolRow => ({
    grade: "read",
    v1: "allowed",
    ...over,
  });
  const def = (rows: RemoteToolRow[], over: Partial<RemoteToolTableDef> = {}): RemoteToolTableDef => ({
    ...FIXTURE_DEF,
    rows,
    ...over,
  });

  const cases: [string, RemoteToolTableDef, RegExp][] = [
    ["a server id the multiplexer cannot namespace (upper case)", def(FIXTURE_ROWS.slice(), { serverId: "Fixture" }), /serverId/],
    ["a server id with an underscore", def(FIXTURE_ROWS.slice(), { serverId: "fixture_bearer" }), /serverId/],
    ["an empty provenance", def(FIXTURE_ROWS.slice(), { provenance: "   " }), /provenance/],
    ["names out of order", def([row({ name: "list_things" }), row({ name: "get_thing" })]), /sorted/],
    ["a duplicate name", def([row({ name: "get_thing" }), row({ name: "get_thing" })]), /get_thing.*(duplicate|sorted)/],
    [
      "a non-allowed row with no note",
      def([row({ name: "save_thing", grade: "write", v1: "blocked-write" })]),
      /save_thing.*note/,
    ],
    [
      "a non-allowed row whose note is blank",
      def([row({ name: "save_thing", grade: "write", v1: "blocked-write", note: "  " })]),
      /save_thing.*note/,
    ],
    [
      "an `allowed` row that is not a read",
      def([row({ name: "save_thing", grade: "write", v1: "allowed" })]),
      /save_thing.*allowed/,
    ],
    ["a wire name the multiplexer would refuse", def([row({ name: "bad name" })]), /bad name.*wire/],
    ["a wire name with the namespace separator", def([row({ name: "a__b" })]), /a__b/],
    ["a wire name starting with punctuation", def([row({ name: "_hidden" })]), /_hidden/],
    ["an empty wire name", def([row({ name: "" })]), /wire/],
    [
      "a wire name over 64 characters",
      def([row({ name: `t${"x".repeat(64)}` })]),
      /wire/,
    ],
    [
      "a namespaced name over the 64-character bound the model's function.name allows",
      def([row({ name: "x".repeat(40) })], { serverId: "s".repeat(30) }),
      /64/,
    ],
    [
      "a disposition the box has never heard of",
      def([row({ name: "get_thing", v1: "quarantined" as never, note: "n" })]),
      /get_thing.*disposition/,
    ],
    [
      "a grade the box has never heard of",
      def([row({ name: "get_thing", grade: "mutate" as never })]),
      /get_thing.*grade/,
    ],
  ];

  it.each(cases)("%s", (_label, bad, expected) => {
    const violations = remoteToolTableViolations(bad);
    expect(violations.length, "the validator let a broken table through").toBeGreaterThan(0);
    expect(violations.join("\n")).toMatch(expected);
  });

  it("accepts a name of exactly 64 characters once namespaced, and refuses 65", () => {
    const id = "a-server"; // 8 chars + "__" = 10
    const fits = def([row({ name: "x".repeat(MAX_NAMESPACED_TOOL_NAME_LENGTH - 10) })], { serverId: id });
    const over = def([row({ name: "x".repeat(MAX_NAMESPACED_TOOL_NAME_LENGTH - 9) })], { serverId: id });
    expect(MAX_NAMESPACED_TOOL_NAME_LENGTH).toBe(64);
    expect(remoteToolTableViolations(fits)).toEqual([]);
    expect(remoteToolTableViolations(over).join("\n")).toMatch(/64/);
  });
});

describe("the policy built from a table (TC-1.3)", () => {
  const policy = createTablePolicy(FIXTURE_ID, FIXTURE_ROWS);

  it("allows a classified read the operator admitted", () => {
    expect(decide(policy, "get_thing")).toEqual({ kind: "allow" });
    expect(decide(policy, "list_things")).toEqual({ kind: "allow" });
  });

  it("denies a classified write or destructive tool with the ADR-043 §3 code", () => {
    for (const name of ["save_thing", "wipe_things"]) {
      expect(decide(policy, name)).toMatchObject({ kind: "deny", code: REMOTE_TABLE_DENY_CODES.writeBlocked });
    }
  });

  it("denies a read held back as EXCLUDED with its OWN code, carrying the row's note", () => {
    const d = decide(policy, "peek_secret_thing");
    expect(d).toMatchObject({ kind: "deny", code: REMOTE_TABLE_DENY_CODES.excluded });
    expect(d.kind === "deny" && d.message).toContain("held back for the context budget");
  });

  it("denies a name the table has never heard of, fail-closed — including names the object prototype owns", () => {
    for (const name of ["delete_everything", "constructor", "toString", "hasOwnProperty"]) {
      expect(decide(policy, name), name).toMatchObject({
        kind: "deny",
        code: REMOTE_TABLE_DENY_CODES.notClassified,
      });
    }
  });

  it("tells the model not to retry, in every refusal", () => {
    for (const name of ["save_thing", "peek_secret_thing", "delete_everything"]) {
      const d = decide(policy, name);
      expect(d.kind).toBe("deny");
      expect(d.kind === "deny" && d.message.toLowerCase()).toContain("do not retry");
    }
  });

  it("allows exactly the read set derived from the table, and nothing else", () => {
    const reads = remoteReadToolsOf(FIXTURE_ROWS);
    expect([...reads].sort()).toEqual(["get_thing", "list_things"]);
    for (const r of FIXTURE_ROWS) {
      expect(decide(policy, r.name).kind === "allow", r.name).toBe(reads.has(r.name));
    }
  });

  describe("a speaks-only-for-its-own-server policy", () => {
    it("falls through to the fallback for another server — even for a name this table allows", () => {
      const fallback = vi.fn(() => ({ kind: "deny" as const, code: "OTHER", message: "no" }));
      const scoped = createTablePolicy(FIXTURE_ID, FIXTURE_ROWS, { fallback });
      // `get_thing` is a read HERE. If the server id were ignored this would
      // come back `allow` and a second vendor's tool would inherit this one's
      // clearance.
      expect(decide(scoped, "get_thing", "another-vendor")).toMatchObject({ kind: "deny", code: "OTHER" });
      expect(fallback).toHaveBeenCalledOnce();
    });

    it("defaults to deny-all for another server when no fallback is supplied", () => {
      const input = {
        serverId: "another-vendor",
        wireName: "get_thing",
        namespacedName: "another-vendor__get_thing",
        args: {},
      };
      expect(policy(input)).toEqual(DENY_ALL_REMOTE_TOOLS(input));
    });
  });

  /**
   * The case a future EDIT introduces, and which no shipped row exhibits — so
   * both layers are exercised against rows the table does not contain, the way
   * `atlassian-tool-policy.test.ts` does for Atlassian.
   */
  describe("a mis-edited row is still refused (TC-1.3)", () => {
    const misMarkedWrite: RemoteToolRow = {
      name: "save_thing",
      grade: "write",
      v1: "allowed",
      note: "synthetic fixture — a field edited by mistake",
    };
    const heldBackRead: RemoteToolRow = {
      name: "get_thing",
      grade: "read",
      v1: "blocked-write",
      note: "synthetic fixture — a read an operator deliberately held back",
    };

    it("a write marked `allowed` is dropped by the derivation, because grade is checked too", () => {
      expect(remoteReadToolsOf([misMarkedWrite]).has("save_thing")).toBe(false);
    });

    it("…and refused at dispatch as a write, whatever its disposition says", () => {
      expect(classifyTableRow(misMarkedWrite, "fixture-bearer__save_thing")).toMatchObject({
        kind: "deny",
        code: REMOTE_TABLE_DENY_CODES.writeBlocked,
      });
    });

    it("the derivation still admits a genuine read, so it is not just refusing everything", () => {
      expect(remoteReadToolsOf([{ name: "get_thing", grade: "read", v1: "allowed" }]).has("get_thing")).toBe(true);
    });

    it("a read the operator held back is dropped by the derivation and refused at dispatch", () => {
      expect(remoteReadToolsOf([heldBackRead]).has("get_thing")).toBe(false);
      expect(classifyTableRow(heldBackRead, "fixture-bearer__get_thing")).toMatchObject({
        kind: "deny",
        code: REMOTE_TABLE_DENY_CODES.writeBlocked,
      });
    });

    it("an excluded read keeps its OWN code, so the two remedies stay apart", () => {
      expect(classifyTableRow({ ...heldBackRead, v1: "excluded" }, "fixture-bearer__get_thing")).toMatchObject({
        kind: "deny",
        code: REMOTE_TABLE_DENY_CODES.excluded,
      });
    });

    it("fails CLOSED on a disposition nobody has taught it about yet", () => {
      const future = { ...heldBackRead, v1: "quarantined" } as unknown as RemoteToolRow;
      expect(classifyTableRow(future, "fixture-bearer__get_thing")).toMatchObject({ kind: "deny" });
    });

    it("refuses a name the table lists TWICE as unclassified, however each row reads", () => {
      // An ambiguous privilege is not resolved in whichever direction iteration
      // order happened to prefer.
      const ambiguous = createTablePolicy(FIXTURE_ID, [
        { name: "get_thing", grade: "read", v1: "allowed" },
        { name: "get_thing", grade: "write", v1: "blocked-write", note: "n" },
      ]);
      expect(decide(ambiguous, "get_thing")).toMatchObject({
        kind: "deny",
        code: REMOTE_TABLE_DENY_CODES.notClassified,
      });
      const alsoAmbiguous = createTablePolicy(FIXTURE_ID, [
        { name: "get_thing", grade: "write", v1: "blocked-write", note: "n" },
        { name: "get_thing", grade: "read", v1: "allowed" },
      ]);
      expect(decide(alsoAmbiguous, "get_thing").kind).toBe("deny");
    });
  });
});

describe("the refusal codes are the ones the rest of the track already switches on (TC-1.3)", () => {
  it("are Atlassian's three shared codes, and the record's, so a record-reviewed read can still fill a table hole", () => {
    expect(REMOTE_TABLE_DENY_CODES).toEqual({
      notClassified: ATLASSIAN_DENY_CODES.notClassified,
      writeBlocked: ATLASSIAN_DENY_CODES.writeBlocked,
      excluded: ATLASSIAN_DENY_CODES.excluded,
    });
    // `composeRemoteCallPolicy` fills a hole only when the table's refusal
    // carries THIS code. A generic table that spelled it differently would
    // silently stop an owner's review from ever applying.
    expect(REMOTE_TABLE_DENY_CODES.notClassified).toBe(RECORD_DENY_CODES.notClassified);
    expect(REMOTE_TABLE_DENY_CODES.writeBlocked).toBe(RECORD_DENY_CODES.writeBlocked);
  });
});

describe("the registry says which table speaks for which server (TC-1.3)", () => {
  it("ships Atlassian's table and NO vendor table — the allowlist and the profile stay the only opt-ins", () => {
    expect(Object.keys(REMOTE_TOOL_TABLES)).toEqual([ATLASSIAN_SERVER_ID]);
    expect(REMOTE_TOOL_TABLE_DEFS).toEqual([]);
    expect(Object.isFrozen(REMOTE_TOOL_TABLES)).toBe(true);
    expect(Object.isFrozen(REMOTE_TOOL_TABLE_DEFS)).toBe(true);
  });

  it("registers Atlassian's own policy, on the API-token mode, decision for decision", () => {
    // The singleton used to build exactly this and nothing else.
    const previous = createAtlassianRemoteCallPolicy({
      authMode: "api-token",
      fallback: DENY_ALL_REMOTE_TOOLS,
    });
    for (const row of ATLASSIAN_TOOL_CLASSIFICATIONS) {
      const input = {
        serverId: ATLASSIAN_SERVER_ID,
        wireName: row.name,
        namespacedName: namespacedToolName(ATLASSIAN_SERVER_ID, row.name),
        args: {},
      };
      expect(remoteToolTablePolicy(input), row.name).toEqual(previous(input));
    }
    // …and an unclassified name, which no row names.
    const unknown = {
      serverId: ATLASSIAN_SERVER_ID,
      wireName: "deleteEverything",
      namespacedName: "atlassian__deleteEverything",
      args: {},
    };
    expect(remoteToolTablePolicy(unknown)).toEqual(previous(unknown));
  });

  it("DENIES every server no table speaks for — and the default is the shipping deny-all, verbatim", () => {
    for (const serverId of ["another-vendor", "ext-anything", "constructor"]) {
      const input = {
        serverId,
        wireName: "get_thing",
        namespacedName: `${serverId}__get_thing`,
        args: {},
      };
      expect(remoteToolTablePolicy(input), serverId).toEqual(DENY_ALL_REMOTE_TOOLS(input));
    }
  });

  it("reads the registry by OWN property: 'constructor' is a legal server id and is not a table", () => {
    const input = {
      serverId: "constructor",
      wireName: "get_thing",
      namespacedName: "constructor__get_thing",
      args: {},
    };
    // With a bare index this is `Object`, which "returns" the input object —
    // no `kind` — and a caller that only checks for "deny" would dispatch.
    expect(remoteToolTablePolicy(input).kind).toBe("deny");
  });

  describe("built from vendor tables", () => {
    const registry = buildRemoteToolTables([FIXTURE_DEF]);

    it("registers each vendor's policy under its own id, beside Atlassian's", () => {
      expect(Object.keys(registry).sort()).toEqual([ATLASSIAN_SERVER_ID, FIXTURE_ID].sort());
      expect(decide(registry[FIXTURE_ID]!, "get_thing")).toEqual({ kind: "allow" });
      expect(decide(registry[FIXTURE_ID]!, "save_thing")).toMatchObject({ kind: "deny" });
    });

    it("lets a vendor table speak for its own server and for no other", () => {
      expect(decide(registry[FIXTURE_ID]!, "get_thing", ATLASSIAN_SERVER_ID)).toMatchObject({ kind: "deny" });
      expect(decide(registry[ATLASSIAN_SERVER_ID]!, "get_thing", FIXTURE_ID)).toMatchObject({ kind: "deny" });
    });

    it("can never replace Atlassian's reviewed table — a vendor def claiming its id loses", () => {
      const hostile = buildRemoteToolTables([
        {
          serverId: ATLASSIAN_SERVER_ID,
          rows: [{ name: "createJiraIssue", grade: "read", v1: "allowed" }],
          provenance: "hostile",
        },
      ]);
      // The reviewed table still says createJiraIssue is a blocked write.
      expect(decide(hostile[ATLASSIAN_SERVER_ID]!, "createJiraIssue", ATLASSIAN_SERVER_ID)).toMatchObject({
        kind: "deny",
        code: REMOTE_TABLE_DENY_CODES.writeBlocked,
      });
    });

    it("is frozen", () => {
      expect(Object.isFrozen(registry)).toBe(true);
    });
  });
});

describe("the set of vendor tables is itself checked (TC-1.3)", () => {
  it("is clean for the tables that ship — and for a well-formed one", () => {
    expect(remoteToolTableSetViolations(REMOTE_TOOL_TABLE_DEFS)).toEqual([]);
    expect(remoteToolTableSetViolations([FIXTURE_DEF])).toEqual([]);
  });

  it("refuses two tables for one server, and a table claiming Atlassian's id", () => {
    expect(remoteToolTableSetViolations([FIXTURE_DEF, FIXTURE_DEF]).join("\n")).toMatch(/more than one/);
    expect(
      remoteToolTableSetViolations([{ ...FIXTURE_DEF, serverId: ATLASSIAN_SERVER_ID }]).join("\n"),
    ).toMatch(/atlassian/);
  });

  it("carries each table's own violations, naming the server", () => {
    const broken = { ...FIXTURE_DEF, provenance: "" };
    expect(remoteToolTableSetViolations([broken]).join("\n")).toMatch(/fixture-bearer.*provenance/);
  });
});

describe("every vendor table that ships is a table for a connectable server (TC-1.3)", () => {
  // Vacuous while no vendor ships, and live for every vendor data PR: this is
  // the loop a new table is added to by being appended to REMOTE_TOOL_TABLE_DEFS.
  it("breaks no invariant, and names an mcp provider whose id, mcpServerId and operator domain agree", () => {
    for (const def of REMOTE_TOOL_TABLE_DEFS) {
      expect(remoteToolTableViolations(def), def.serverId).toEqual([]);
      const descriptor = providerDescriptor(def.serverId);
      expect(descriptor?.track, `${def.serverId} is not an mcp provider`).toBe("mcp");
      expect(descriptor?.track === "mcp" && descriptor.mcpServerId).toBe(def.serverId);
      expect(descriptor?.id).toBe(def.serverId);
      expect(remoteServerDomain(def.serverId), `${def.serverId} has no operator domain`).toBeDefined();
    }
  });
});
