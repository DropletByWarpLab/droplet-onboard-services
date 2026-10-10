/**
 * WARP-2434 (Romain, 2026-10-08: keep reviewed tools working on upgrade) — the
 * seed migration's predicate, pinned to the dispatch policy it mirrors.
 *
 * SQL cannot call the policy, so the migration carries the curated Atlassian
 * names as text. This test (1) pins those lists to ATLASSIAN_TOOL_CLASSIFICATIONS,
 * and (2) evaluates the migration's predicate, transcribed over the parsed lists,
 * against `composeRemoteCallPolicy` + the Atlassian table for every combination
 * of row state: seed(row) must equal "stage's dispatch allows it today".
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { MIGRATIONS_DIR } from "./helpers/test-paths.js";
import {
  ATLASSIAN_SERVER_ID,
  ATLASSIAN_TOOL_CLASSIFICATIONS,
  createAtlassianRemoteCallPolicy,
} from "../services/atlassian-tool-policy.js";
import { DENY_ALL_REMOTE_TOOLS } from "../services/mcp-multiplexer.service.js";
import {
  composeRemoteCallPolicy,
  type RemoteToolClassificationRow,
} from "../services/remote-tool-classification.service.js";

const sql = readFileSync(
  path.join(MIGRATIONS_DIR, "20261008210100_warp_2434_seed_allowlist", "migration.sql"),
  "utf-8",
);
const names = (s: string): string[] => [...s.matchAll(/'([A-Za-z0-9_.-]+)'/g)].map((m) => m[1]!);
const inList = /"toolName" IN \(([\s\S]*?)\)/.exec(sql)![1]!;
const notInList = /"toolName" NOT IN \(([\s\S]*?)\)/.exec(sql)![1]!;
const seededReads = names(inList);
const tableNames = names(notInList);

const authPolicy = createAtlassianRemoteCallPolicy({ authMode: "api-token", fallback: DENY_ALL_REMOTE_TOOLS });

describe("seed migration for the allowlist", () => {
  it("never seeds denied rows or extension servers, and fills only reviewed reads", () => {
    expect(sql).toContain('"denied" = false');
    expect(sql).toContain(`"serverId" NOT LIKE 'ext-%'`);
    expect(sql).toContain('"reviewedAt" IS NOT NULL');
    expect(sql).toContain('"requiresWrite" = false');
  });

  it("carries exactly the curated table: every row name, and the api-token-reachable v1 reads", () => {
    expect([...tableNames].sort()).toEqual(ATLASSIAN_TOOL_CLASSIFICATIONS.map((t) => t.name).sort());
    const reachableReads = ATLASSIAN_TOOL_CLASSIFICATIONS.filter(
      (t) => authPolicy({ serverId: ATLASSIAN_SERVER_ID, wireName: t.name, namespacedName: t.name, args: {} }).kind === "allow",
    ).map((t) => t.name);
    expect([...seededReads].sort()).toEqual(reachableReads.sort());
  });

  /** The migration's WHERE clause, transcribed. */
  const seeds = (r: Pick<RemoteToolClassificationRow, "serverId" | "toolName" | "denied" | "requiresWrite" | "reviewedAt">) =>
    !r.denied &&
    !r.serverId.startsWith("ext-") &&
    ((r.serverId === "atlassian" && seededReads.includes(r.toolName)) ||
      (r.reviewedAt !== null &&
        !r.requiresWrite &&
        (r.serverId !== "atlassian" || !tableNames.includes(r.toolName))));

  it("equals what stage's dispatch allows today, for every row state", () => {
    const tools: Array<[string, string]> = [
      ...ATLASSIAN_TOOL_CLASSIFICATIONS.map((t) => [ATLASSIAN_SERVER_ID, t.name] as [string, string]),
      [ATLASSIAN_SERVER_ID, "someNewTool"],
      ["othervendor", "list"],
    ];
    let checked = 0;
    for (const [serverId, toolName] of tools)
      for (const denied of [false, true])
        for (const requiresWrite of [false, true])
          for (const reviewed of [false, true]) {
            const row: RemoteToolClassificationRow = {
              serverId,
              toolName,
              requiresWrite,
              requiresConfirmation: requiresWrite,
              denied,
              reviewedBy: reviewed ? "owner" : null,
              reviewedAt: reviewed ? new Date(0) : null,
              wireDescription: null,
              firstSeenAt: new Date(0),
              lastSeenAt: new Date(0),
            };
            const policy = composeRemoteCallPolicy({
              lookup: () => row,
              table: (i) => (i.serverId === ATLASSIAN_SERVER_ID ? authPolicy(i) : DENY_ALL_REMOTE_TOOLS(i)),
            });
            // WARP-3962 — "runs without a thumbs-up": an `ask` write is a separate state.
            const d = policy({ serverId, wireName: toolName, namespacedName: `${serverId}__${toolName}`, args: {} });
            const today = d.kind === "allow" && d.requiresConfirmation !== true;
            expect(seeds(row), JSON.stringify({ serverId, toolName, denied, requiresWrite, reviewed })).toBe(today);
            checked++;
          }
    expect(checked).toBe(tools.length * 8);
  });
});
