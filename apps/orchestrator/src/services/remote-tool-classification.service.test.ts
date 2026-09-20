/**
 * WARP-2426 — the operator-owned classification record.
 *
 *   1. Every discovered tool lands as a CONFIRMING WRITE — including one
 *      whose wire name and description read as a search. MUTATION (the
 *      ticket's most valuable): flip `requiresWrite` in
 *      IMPORT_DEFAULT_CLASSIFICATION → red.
 *   2. Re-discovery touches only the "seen" facts; a person's demotion or
 *      block survives every reconnect.
 *   3. classifyRemoteTool refuses: an unseen tool, an empty reviewer, and
 *      the one combination no writer may produce — a write with no
 *      confirmation.
 *   4. The record-backed policy: no row / denied / write / reviewed read.
 *   5. Composed over a table: `denied` wins over a table allow; a reviewed
 *      read fills a table hole; a table write-block cannot be demoted around.
 *   6. The import-path enumeration: no file outside the service creates or
 *      upserts a classification row.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import {
  IMPORT_DEFAULT_CLASSIFICATION,
  RECORD_DENY_CODES,
  RemoteToolClassificationCache,
  classifyRemoteTool,
  composeRemoteCallPolicy,
  createRecordBackedRemoteCallPolicy,
  recordDiscoveredRemoteTools,
  type ClassificationPrisma,
  type RemoteToolClassificationRow,
} from "./remote-tool-classification.service.js";
import type { RemoteCallPolicy } from "./mcp-multiplexer.service.js";

/** A map-backed stand-in for the one Prisma model this module touches. */
function fakePrisma(seed: RemoteToolClassificationRow[] = []) {
  const rows = new Map<string, RemoteToolClassificationRow>();
  const k = (s: string, t: string) => `${s}|${t}`;
  for (const r of seed) rows.set(k(r.serverId, r.toolName), r);
  const model = {
    findUnique: async ({ where }: { where: { serverId_toolName: { serverId: string; toolName: string } } }) =>
      rows.get(k(where.serverId_toolName.serverId, where.serverId_toolName.toolName)) ?? null,
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { serverId_toolName: { serverId: string; toolName: string } };
      create: Omit<RemoteToolClassificationRow, "reviewedBy" | "reviewedAt">;
      update: Partial<RemoteToolClassificationRow>;
    }) => {
      const key = k(where.serverId_toolName.serverId, where.serverId_toolName.toolName);
      const existing = rows.get(key);
      const next: RemoteToolClassificationRow = existing
        ? { ...existing, ...update }
        : { reviewedBy: null, reviewedAt: null, ...create };
      rows.set(key, next);
      return next;
    },
    update: async ({
      where,
      data,
    }: {
      where: { serverId_toolName: { serverId: string; toolName: string } };
      data: Partial<RemoteToolClassificationRow>;
    }) => {
      const key = k(where.serverId_toolName.serverId, where.serverId_toolName.toolName);
      const next = { ...(rows.get(key) as RemoteToolClassificationRow), ...data };
      rows.set(key, next);
      return next;
    },
    findMany: async ({ where }: { where?: { serverId?: string } } = {}) =>
      [...rows.values()].filter((r) => !where?.serverId || r.serverId === where.serverId),
  };
  return { prisma: { remoteToolClassification: model } as unknown as ClassificationPrisma, rows };
}

const T0 = new Date("2026-09-19T20:00:00Z");
const T1 = new Date("2026-09-20T20:00:00Z");

describe("recordDiscoveredRemoteTools — the one import path", () => {
  it("lands every discovered tool as a confirming write, whatever the wire says it is", async () => {
    const { prisma, rows } = fakePrisma();
    const out = await recordDiscoveredRemoteTools(
      prisma,
      "atlassian",
      [
        // The wire says "search" and "get". The record does not care.
        { wireName: "searchJiraIssuesUsingJql", description: "Search issues (read-only)" },
        { wireName: "getConfluencePage", description: "Get a page. readOnlyHint: true" },
        { wireName: "createJiraIssue", description: "Create an issue" },
      ],
      T0,
    );
    expect(out).toEqual({ created: ["searchJiraIssuesUsingJql", "getConfluencePage", "createJiraIssue"], seen: 3 });
    for (const name of ["searchJiraIssuesUsingJql", "getConfluencePage", "createJiraIssue"]) {
      const row = rows.get(`atlassian|${name}`)!;
      expect(row).toMatchObject({ requiresWrite: true, requiresConfirmation: true, denied: false, reviewedBy: null, reviewedAt: null });
      expect(row.firstSeenAt).toEqual(T0);
    }
    // The constant the whole story rests on, pinned by value.
    expect(IMPORT_DEFAULT_CLASSIFICATION).toEqual({ requiresWrite: true, requiresConfirmation: true, denied: false });
    expect(Object.isFrozen(IMPORT_DEFAULT_CLASSIFICATION)).toBe(true);
  });

  it("re-discovery refreshes lastSeenAt and the wire description only — a person's decision survives a reconnect", async () => {
    const { prisma, rows } = fakePrisma();
    await recordDiscoveredRemoteTools(prisma, "atlassian", [{ wireName: "getConfluencePage", description: "v1" }], T0);
    const demoted = await classifyRemoteTool(
      prisma,
      { serverId: "atlassian", toolName: "getConfluencePage", requiresWrite: false, requiresConfirmation: false, denied: false, reviewedBy: "romain" },
      T0,
    );
    expect(demoted.ok).toBe(true);

    const again = await recordDiscoveredRemoteTools(prisma, "atlassian", [{ wireName: "getConfluencePage", description: "v2" }], T1);
    expect(again).toEqual({ created: [], seen: 1 });
    const row = rows.get("atlassian|getConfluencePage")!;
    expect(row).toMatchObject({
      requiresWrite: false,
      requiresConfirmation: false,
      denied: false,
      reviewedBy: "romain",
      reviewedAt: T0,
      wireDescription: "v2",
      firstSeenAt: T0,
      lastSeenAt: T1,
    });
  });
});

describe("classifyRemoteTool — a person's act", () => {
  it("refuses a tool the server never advertised", async () => {
    const { prisma } = fakePrisma();
    const r = await classifyRemoteTool(prisma, {
      serverId: "atlassian", toolName: "ghost", requiresWrite: false, requiresConfirmation: false, denied: false, reviewedBy: "romain",
    });
    expect(r).toMatchObject({ ok: false, code: "NOT_FOUND" });
  });

  it("refuses an empty reviewer, and the write-without-confirmation combination", async () => {
    const { prisma } = fakePrisma();
    await recordDiscoveredRemoteTools(prisma, "atlassian", [{ wireName: "createJiraIssue" }], T0);
    expect(
      await classifyRemoteTool(prisma, {
        serverId: "atlassian", toolName: "createJiraIssue", requiresWrite: false, requiresConfirmation: false, denied: false, reviewedBy: "  ",
      }),
    ).toMatchObject({ ok: false, code: "NO_REVIEWER" });
    expect(
      await classifyRemoteTool(prisma, {
        serverId: "atlassian", toolName: "createJiraIssue", requiresWrite: true, requiresConfirmation: false, denied: false, reviewedBy: "romain",
      }),
    ).toMatchObject({ ok: false, code: "UNCONFIRMED_WRITE" });
  });

  it("blocks and unblocks, stamping the reviewer each time", async () => {
    const { prisma, rows } = fakePrisma();
    await recordDiscoveredRemoteTools(prisma, "atlassian", [{ wireName: "createJiraIssue" }], T0);
    const blocked = await classifyRemoteTool(
      prisma,
      { serverId: "atlassian", toolName: "createJiraIssue", requiresWrite: true, requiresConfirmation: true, denied: true, reviewedBy: "romain" },
      T1,
    );
    expect(blocked).toMatchObject({ ok: true, row: { denied: true, reviewedBy: "romain", reviewedAt: T1 } });
    expect(rows.get("atlassian|createJiraIssue")!.denied).toBe(true);
  });
});

function row(over: Partial<RemoteToolClassificationRow>): RemoteToolClassificationRow {
  return {
    serverId: "atlassian",
    toolName: "t",
    requiresWrite: true,
    requiresConfirmation: true,
    denied: false,
    reviewedBy: null,
    reviewedAt: null,
    wireDescription: null,
    firstSeenAt: T0,
    lastSeenAt: T0,
    ...over,
  };
}

const call = (serverId: string, wireName: string) => ({
  serverId,
  wireName,
  namespacedName: `${serverId}__${wireName}`,
  args: {},
});

describe("the record-backed policy", () => {
  it("denies a tool with no row as NOT_CLASSIFIED — never seen is never allowed", () => {
    const cache = new RemoteToolClassificationCache();
    const policy = createRecordBackedRemoteCallPolicy(cache.lookup);
    expect(policy(call("atlassian", "getConfluencePage"))).toMatchObject({ kind: "deny", code: RECORD_DENY_CODES.notClassified });
  });

  it("denies the import default (a confirming write) as WRITE_NOT_PERMITTED — ADR-043 §3 still holds", () => {
    const cache = new RemoteToolClassificationCache();
    cache.seed([row({ toolName: "getConfluencePage" })]);
    const policy = createRecordBackedRemoteCallPolicy(cache.lookup);
    expect(policy(call("atlassian", "getConfluencePage"))).toMatchObject({ kind: "deny", code: RECORD_DENY_CODES.writeBlocked });
  });

  it("denies a blocked tool as DENIED, and allows a reviewed read", () => {
    const cache = new RemoteToolClassificationCache();
    cache.seed([
      row({ toolName: "createJiraIssue", denied: true, reviewedBy: "romain", reviewedAt: T0 }),
      row({ toolName: "getConfluencePage", requiresWrite: false, requiresConfirmation: false, reviewedBy: "romain", reviewedAt: T0 }),
    ]);
    const policy = createRecordBackedRemoteCallPolicy(cache.lookup);
    expect(policy(call("atlassian", "createJiraIssue"))).toMatchObject({ kind: "deny", code: RECORD_DENY_CODES.denied });
    expect(policy(call("atlassian", "getConfluencePage"))).toEqual({ kind: "allow" });
  });
});

describe("composed over a compiled table", () => {
  const table: RemoteCallPolicy = (input) => {
    if (input.wireName === "tableRead") return { kind: "allow" };
    if (input.wireName === "tableWrite") return { kind: "deny", code: "REMOTE_WRITE_NOT_PERMITTED", message: "table says write" };
    return { kind: "deny", code: RECORD_DENY_CODES.notClassified, message: "table hole" };
  };

  it("the record's block wins over the table's allow", () => {
    const cache = new RemoteToolClassificationCache();
    cache.seed([row({ toolName: "tableRead", requiresWrite: false, requiresConfirmation: false, denied: true, reviewedBy: "romain", reviewedAt: T0 })]);
    const policy = composeRemoteCallPolicy({ lookup: cache.lookup, table });
    expect(policy(call("atlassian", "tableRead"))).toMatchObject({ kind: "deny", code: RECORD_DENY_CODES.denied });
  });

  it("the table's allow stands when the record has only the import default", () => {
    const cache = new RemoteToolClassificationCache();
    cache.seed([row({ toolName: "tableRead" })]);
    const policy = composeRemoteCallPolicy({ lookup: cache.lookup, table });
    expect(policy(call("atlassian", "tableRead"))).toEqual({ kind: "allow" });
  });

  it("a reviewed read fills a table HOLE — and only a hole", () => {
    const cache = new RemoteToolClassificationCache();
    cache.seed([
      row({ toolName: "hole", requiresWrite: false, requiresConfirmation: false, reviewedBy: "romain", reviewedAt: T0 }),
      // MUTATION: let the record override any table deny and this goes red —
      // the reviewed JSON is a floor a demotion cannot reach around.
      row({ toolName: "tableWrite", requiresWrite: false, requiresConfirmation: false, reviewedBy: "romain", reviewedAt: T0 }),
    ]);
    const policy = composeRemoteCallPolicy({ lookup: cache.lookup, table });
    expect(policy(call("atlassian", "hole"))).toEqual({ kind: "allow" });
    expect(policy(call("atlassian", "tableWrite"))).toMatchObject({ kind: "deny", code: "REMOTE_WRITE_NOT_PERMITTED", message: "table says write" });
  });

  it("a hole with only the import default keeps the table's own NOT_CLASSIFIED code", () => {
    const cache = new RemoteToolClassificationCache();
    cache.seed([row({ toolName: "hole" })]);
    const policy = composeRemoteCallPolicy({ lookup: cache.lookup, table });
    expect(policy(call("atlassian", "hole"))).toMatchObject({ kind: "deny", code: RECORD_DENY_CODES.notClassified, message: "table hole" });
  });

  it("with no table, the record is the whole authority — the shipping state for any second server", () => {
    const cache = new RemoteToolClassificationCache();
    cache.seed([row({ serverId: "vendor2", toolName: "list", requiresWrite: false, requiresConfirmation: false, reviewedBy: "romain", reviewedAt: T0 })]);
    const policy = composeRemoteCallPolicy({ lookup: cache.lookup });
    expect(policy(call("vendor2", "list"))).toEqual({ kind: "allow" });
    expect(policy(call("vendor2", "other"))).toMatchObject({ kind: "deny", code: RECORD_DENY_CODES.notClassified });
  });
});

describe("every import path", () => {
  it("no file outside the service creates or upserts a classification row", () => {
    // Enumerates the tree rather than trusting a list: a second writer added
    // anywhere under src/ turns this red. The service is the one path, and
    // its default is the frozen constant above.
    const root = path.resolve(__dirname, "..");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.ts$/.test(name) || /\.test\.ts$/.test(name)) continue;
        if (p.endsWith(path.join("services", "remote-tool-classification.service.ts"))) continue;
        const src = readFileSync(p, "utf8");
        if (/remoteToolClassification\s*\.\s*(create|upsert|createMany|update|updateMany)\b/.test(src)) {
          offenders.push(path.relative(root, p));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
