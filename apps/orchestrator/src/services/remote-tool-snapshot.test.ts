/**
 * WARP-3703 (ADR-043 TC-1.3) — the generic tool-surface drift gate: one snapshot
 * per vendor table, one loop over all of them.
 *
 * `atlassian-tool-snapshot.test.ts` byte-compares Atlassian's committed
 * artefact and is not edited. This file is the same gate for every OTHER server:
 * `docs/security/<serverId>-mcp-tool-surface.json` is regenerated from the
 * table and compared, so editing a table without the artefact — or the artefact
 * without the table — goes red, and a diff on it is read as a privilege change.
 *
 * Like Atlassian's, it catches OUR drift and cannot catch the vendor's: that is
 * the session's `catalog_changed` state at runtime.
 *
 * No vendor ships, so the loop over the committed artefacts is vacuous today and
 * live for every vendor data PR. The tests under "the gate itself" are what make
 * that more than a claim: they drive the same comparison over a TEST-ONLY
 * fixture table and files in a temp directory, so the loop is shown to be able
 * to go red.
 *
 * Regenerate one server's artefact with
 *   UPDATE_REMOTE_TOOL_SNAPSHOT=<serverId> npm run -w @droplet/orchestrator test -- remote-tool-snapshot
 */
import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ATLASSIAN_SNAPSHOT_PATH } from "./atlassian-tool-snapshot.js";
import {
  REMOTE_TOOL_SNAPSHOT_FORMAT,
  buildRemoteToolSnapshot,
  remoteToolSnapshotPath,
} from "./remote-tool-snapshot.js";
import {
  REMOTE_TOOL_TABLE_DEFS,
  remoteReadToolsOf,
  type RemoteToolRow,
  type RemoteToolTableDef,
} from "./remote-tool-tables.js";
import { repoPath } from "../__tests__/helpers/test-paths.js";

const ROWS: readonly RemoteToolRow[] = [
  { name: "get_thing", grade: "read", v1: "allowed" },
  { name: "list_things", grade: "read", v1: "allowed" },
  { name: "save_thing", grade: "write", v1: "blocked-write", note: "ADR-043 §3." },
];

const FIXTURE: RemoteToolTableDef = {
  serverId: "fixture-bearer",
  rows: ROWS,
  provenance: "Names taken from a fixture, NOT a live tools/list; Warp Lab holds no credential.",
};

/**
 * Whether the committed text is the regenerated one, or WHY not.
 *
 * Compared with line endings normalised, and only on the committed side: a
 * checkout with `core.autocrlf` (every Windows clone) reads the LF blob back as
 * CRLF, and that must not turn a security artefact "out of date". Everything
 * else is byte-for-byte.
 */
function driftOf(def: RemoteToolTableDef, committed: string | null): string | null {
  const path = remoteToolSnapshotPath(def.serverId);
  if (committed === null) {
    return `${path} is missing — regenerate with UPDATE_REMOTE_TOOL_SNAPSHOT=${def.serverId}`;
  }
  if (committed.replace(/\r\n/g, "\n") !== buildRemoteToolSnapshot(def)) {
    return (
      `${path} is out of date with its table. This file is a SECURITY artefact — read the ` +
      `diff as a privilege change before regenerating with UPDATE_REMOTE_TOOL_SNAPSHOT=${def.serverId}.`
    );
  }
  return null;
}

describe("where a snapshot lives", () => {
  it("is docs/security/<serverId>-mcp-tool-surface.json", () => {
    expect(remoteToolSnapshotPath("linear")).toBe("docs/security/linear-mcp-tool-surface.json");
  });

  it("names Atlassian's committed artefact the same way, so one naming rule covers every server", () => {
    expect(remoteToolSnapshotPath("atlassian")).toBe(ATLASSIAN_SNAPSHOT_PATH);
  });

  it("refuses to build a path from anything that is not a server id", () => {
    for (const bad of ["../etc/passwd", "a/b", "Linear", "", "x_y", "a".repeat(33)]) {
      expect(() => remoteToolSnapshotPath(bad), JSON.stringify(bad)).toThrow(/server id/);
    }
  });
});

describe("the snapshot a table generates", () => {
  it("is pinned to the byte: two-space JSON, a trailing newline, the table's tools sorted by name", () => {
    expect(buildRemoteToolSnapshot(FIXTURE)).toBe(
      [
        "{",
        '  "format": 1,',
        '  "serverId": "fixture-bearer",',
        `  "provenance": ${JSON.stringify(FIXTURE.provenance)},`,
        '  "toolCount": 3,',
        '  "v1ReadToolCount": 2,',
        '  "tools": [',
        "    {",
        '      "name": "get_thing",',
        '      "grade": "read",',
        '      "v1": "allowed"',
        "    },",
        "    {",
        '      "name": "list_things",',
        '      "grade": "read",',
        '      "v1": "allowed"',
        "    },",
        "    {",
        '      "name": "save_thing",',
        '      "grade": "write",',
        '      "v1": "blocked-write",',
        '      "note": "ADR-043 §3."',
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n"),
    );
    expect(REMOTE_TOOL_SNAPSHOT_FORMAT).toBe(1);
  });

  it("carries its provenance IN the file, not only in a PR description", () => {
    const doc = JSON.parse(buildRemoteToolSnapshot(FIXTURE)) as { provenance: string; serverId: string };
    expect(doc.provenance).toBe(FIXTURE.provenance);
    expect(doc.serverId).toBe("fixture-bearer");
  });

  it("counts agree with the table it was generated from", () => {
    const doc = JSON.parse(buildRemoteToolSnapshot(FIXTURE)) as {
      toolCount: number;
      v1ReadToolCount: number;
      tools: unknown[];
    };
    expect(doc.toolCount).toBe(ROWS.length);
    expect(doc.v1ReadToolCount).toBe(remoteReadToolsOf(ROWS).size);
    expect(doc.tools).toHaveLength(ROWS.length);
  });

  it("is sorted by name, so a MOVED row produces no diff and a NEW row produces one", () => {
    const shuffled = { ...FIXTURE, rows: [ROWS[2]!, ROWS[0]!, ROWS[1]!] };
    expect(buildRemoteToolSnapshot(shuffled)).toBe(buildRemoteToolSnapshot(FIXTURE));

    const extra = { ...FIXTURE, rows: [...ROWS, { name: "zap_thing", grade: "destructive", v1: "blocked-write", note: "n" } as const] };
    expect(buildRemoteToolSnapshot(extra)).not.toBe(buildRemoteToolSnapshot(FIXTURE));
  });

  it("omits an absent note rather than writing null", () => {
    expect(buildRemoteToolSnapshot(FIXTURE)).not.toContain("null");
    const doc = JSON.parse(buildRemoteToolSnapshot(FIXTURE)) as { tools: { name: string; note?: string }[] };
    expect(doc.tools.find((t) => t.name === "get_thing")).not.toHaveProperty("note");
  });
});

describe("the gate itself can go red (TC-1.3)", () => {
  /** A file in a temp directory standing in for the committed artefact. */
  function committedAs(text: string): string {
    const file = join(mkdtempSync(join(tmpdir(), "remote-tool-snapshot-")), "committed.json");
    writeFileSync(file, text, "utf8");
    return readFileSync(file, "utf8");
  }

  it("passes for an artefact that is exactly what the table generates", () => {
    expect(driftOf(FIXTURE, committedAs(buildRemoteToolSnapshot(FIXTURE)))).toBeNull();
  });

  it("passes for the same artefact checked out with CRLF line endings (core.autocrlf)", () => {
    const crlf = buildRemoteToolSnapshot(FIXTURE).replace(/\n/g, "\r\n");
    expect(driftOf(FIXTURE, committedAs(crlf))).toBeNull();
  });

  it("is RED when a row's disposition is edited without regenerating — a privilege change", () => {
    const stale = buildRemoteToolSnapshot(FIXTURE);
    const edited: RemoteToolTableDef = {
      ...FIXTURE,
      rows: ROWS.map((r) => (r.name === "get_thing" ? { ...r, v1: "excluded", note: "held back" } : r)),
    };
    expect(driftOf(edited, committedAs(stale))).toMatch(/out of date.*privilege change/);
  });

  it("is RED when the artefact is edited by hand without changing the table", () => {
    const handEdited = buildRemoteToolSnapshot(FIXTURE).replace('"blocked-write"', '"allowed"');
    expect(driftOf(FIXTURE, committedAs(handEdited))).toMatch(/out of date/);
  });

  it("is RED when the artefact does not exist, and says how to regenerate it", () => {
    expect(driftOf(FIXTURE, null)).toMatch(/is missing.*UPDATE_REMOTE_TOOL_SNAPSHOT=fixture-bearer/);
  });
});

describe("every vendor table's committed snapshot is byte-identical to what it generates (TC-1.3)", () => {
  // Vacuous while no vendor ships; live the day one is appended to
  // REMOTE_TOOL_TABLE_DEFS, and "the gate itself" above is what shows it can fail.
  it("holds for every table in the registry", () => {
    for (const def of REMOTE_TOOL_TABLE_DEFS) {
      // Anchored to the repo, never to the runner's cwd (WARP-2654).
      const committedPath = repoPath(remoteToolSnapshotPath(def.serverId));
      if (process.env.UPDATE_REMOTE_TOOL_SNAPSHOT === def.serverId) {
        writeFileSync(committedPath, buildRemoteToolSnapshot(def), "utf8");
      }
      const committed = existsSync(committedPath) ? readFileSync(committedPath, "utf8") : null;
      expect(driftOf(def, committed), def.serverId).toBeNull();
    }
  });

  it("is registered for exactly the tables that ship", () => {
    expect(REMOTE_TOOL_TABLE_DEFS.map((d) => d.serverId)).toEqual([]);
  });
});
