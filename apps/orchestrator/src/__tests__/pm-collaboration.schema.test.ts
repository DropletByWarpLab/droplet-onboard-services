/**
 * WARP-3519 (ADR-069 WS-2) — schema + migration assertions for comment
 * edit/delete, @mentions, reactions and watchers.
 *
 * Vitest mocks @prisma/client (see ./setup.ts), so this guards schema.prisma and
 * the migration SQL directly. Same pattern as pm-work-item-relation.schema.test.ts
 * and pm-schema-hardening.schema.test.ts, for the same reason: the two CHECK
 * constraints, the enum-add guards and the backfill live only in migration SQL,
 * and a datamodel push never runs them.
 *
 * Their BEHAVIOUR is proven against a real Postgres in pm-collaboration.pg.test.ts.
 * This file proves they are still SHIPPED, and that the one list the dashboard
 * builds its per-verb sentences from (PM_ACTIVITY_VERBS) is still the Prisma enum.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PM_ACTIVITY_VERBS, PM_TIMELINE_MIRRORED_VERBS } from "@droplet/shared-types";
import { MIGRATIONS_DIR, readSchema } from "./helpers/test-paths.js";

const SCHEMA = readSchema();

/** The folder name is part of the contract: the stamp fixes where it sorts. */
const MIGRATION = "20261004020000_warp_3519_pm_collaboration";
const SQL_PATH = join(MIGRATIONS_DIR, MIGRATION, "migration.sql");
const SQL = existsSync(SQL_PATH) ? readFileSync(SQL_PATH, "utf8") : "";

/** The SQL with `--` comments removed: a statement is judged on what RUNS, not
 *  on what the header says about it (the header names every constraint and verb). */
const CODE = SQL.replace(/--.*$/gm, "");

/** Whitespace-insensitive form, for comparing an expression across a reformat. */
const norm = (s: string): string =>
  s.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
const NORM = norm(CODE);

/** Every `DO $$ BEGIN … END $$;` block, whole. */
const DO_BLOCKS = [...CODE.matchAll(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g)].map((m) => m[0]);
const guardedByDuplicateObject = (block: string): boolean =>
  /EXCEPTION\s+WHEN duplicate_object THEN null;/.test(block);

/** A `model`/`enum` body from schema.prisma, doc comments removed (a `///` line
 *  naming a field is not a declaration of it). */
function block(kind: "model" | "enum", name: string): string {
  const match = new RegExp(`${kind} ${name} \\{([\\s\\S]*?)\\n\\}`).exec(SCHEMA);
  expect(match, `${kind} ${name} must exist in schema.prisma`).not.toBeNull();
  return match![1].replace(/\/\/.*$/gm, "");
}

function enumMembers(name: string): string[] {
  return block("enum", name)
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((token) => token.length > 0);
}

const NEW_VERBS = [
  "comment_edited",
  "comment_deleted",
  "watcher_added",
  "watcher_removed",
  "mentioned",
] as const;

// ── schema.prisma ────────────────────────────────────────────────────────────

describe("schema.prisma — PmComment edit + soft delete (WARP-3519)", () => {
  it("declares editedAt, isDeleted (default false), deletedAt and deletedById", () => {
    const body = block("model", "PmComment");
    // editedAt is nullable on purpose: null = never edited.
    expect(body).toMatch(/\beditedAt\s+DateTime\?/);
    // `isDeleted` is the canonical signal — a plain Boolean, not derived from
    // `deletedAt IS NOT NULL` (CLAUDE.md "no guessing").
    expect(body).toMatch(/\bisDeleted\s+Boolean\s+@default\(false\)/);
    expect(body).toMatch(/\bdeletedAt\s+DateTime\?/);
    expect(body).toMatch(/\bdeletedById\s+String\?/);
  });

  it("carries both back-relations the hydrated read joins through", () => {
    const body = block("model", "PmComment");
    expect(body).toMatch(/\breactions\s+PmCommentReaction\[\]/);
    expect(body).toMatch(/\bmentions\s+PmCommentMention\[\]/);
  });

  it("PmWorkItem carries the watchers back-relation", () => {
    expect(block("model", "PmWorkItem")).toMatch(/\bwatchers\s+PmWorkItemWatcher\[\]/);
  });
});

describe.each([
  {
    name: "PmCommentReaction",
    parent: "PmComment",
    parentKey: "commentId",
    unique: "@@unique([commentId, userId, emoji])",
    userIdIndex: false,
  },
  {
    name: "PmWorkItemWatcher",
    parent: "PmWorkItem",
    parentKey: "workItemId",
    unique: "@@unique([workItemId, userId])",
    userIdIndex: true,
  },
  {
    name: "PmCommentMention",
    parent: "PmComment",
    parentKey: "commentId",
    unique: "@@unique([commentId, userId])",
    userIdIndex: true,
  },
])("schema.prisma — model $name (WARP-3519)", ({ name, parent, parentKey, unique, userIdIndex }) => {
  it(`is unique on ${unique.slice(10, -2)} — adding the same row twice is a no-op, not a second row`, () => {
    expect(block("model", name)).toContain(unique);
  });

  if (userIdIndex) {
    it("indexes userId — 'what am I watching / mentioned in' is a read by person", () => {
      expect(block("model", name)).toContain("@@index([userId])");
    });
  }

  it(`is deleted WITH its ${parent} (onDelete: Cascade), and that is its only relation`, () => {
    const body = block("model", name);
    expect(body).toMatch(
      new RegExp(
        `@relation\\(fields: \\[${parentKey}\\],\\s*references: \\[id\\],\\s*onDelete: Cascade\\)`,
      ),
    );
    expect((body.match(/@relation\(/g) ?? []).length).toBe(1);
    expect((body.match(/onDelete: Cascade/g) ?? []).length).toBe(1);
  });

  it("holds userId as a plain User.id string, no foreign key (the PM attribution convention)", () => {
    const body = block("model", name);
    expect(body).toMatch(/\buserId\s+String\b(?!\?)/);
    expect(body).not.toMatch(/fields: \[userId\]/);
  });
});

describe("schema.prisma — PmWorkItemWatcher.reason and the enums (WARP-3519)", () => {
  it("reason is a required PmWatchReason", () => {
    expect(block("model", "PmWorkItemWatcher")).toMatch(/\breason\s+PmWatchReason\b(?!\?)/);
  });

  it("PmWatchReason is exactly CREATOR | ASSIGNEE | COMMENTER | MENTIONED | MANUAL", () => {
    expect(enumMembers("PmWatchReason")).toEqual([
      "CREATOR",
      "ASSIGNEE",
      "COMMENTER",
      "MENTIONED",
      "MANUAL",
    ]);
  });

  it("PmActivityVerb declares the five new verbs", () => {
    expect(enumMembers("PmActivityVerb")).toEqual(expect.arrayContaining([...NEW_VERBS]));
  });
});

// ── the dashboard's verb list is the Prisma enum ─────────────────────────────

describe("PM_ACTIVITY_VERBS (@droplet/shared-types) is the Prisma enum", () => {
  // The dashboard builds one sentence per verb from an exhaustive
  // Record<PmActivityVerb, …> keyed off this list. A verb added to the schema
  // and not here would compile everywhere and render as nothing in the timeline.
  it("lists every member of enum PmActivityVerb, in schema order", () => {
    expect([...PM_ACTIVITY_VERBS]).toEqual(enumMembers("PmActivityVerb"));
  });

  it("PM_TIMELINE_MIRRORED_VERBS only names verbs that exist", () => {
    for (const verb of PM_TIMELINE_MIRRORED_VERBS) {
      expect(PM_ACTIVITY_VERBS as readonly string[], `${verb} must be a PmActivityVerb`).toContain(verb);
    }
  });
});

// ── the migration ────────────────────────────────────────────────────────────

describe(`migration ${MIGRATION}`, () => {
  it("ships under the pinned folder name, and the stamp is unique", () => {
    const folders = readdirSync(MIGRATIONS_DIR);
    expect(folders).toContain(MIGRATION);
    expect(existsSync(SQL_PATH), `${MIGRATION}/migration.sql must exist`).toBe(true);
    expect(CODE.trim().length).toBeGreaterThan(0);
    // Two folders sharing a stamp apply in an order nobody chose.
    expect(folders.filter((d) => d.startsWith(MIGRATION.slice(0, 14)))).toEqual([MIGRATION]);
  });

  it("sorts after the migrations that create what it alters", () => {
    // Prisma applies folders in name order; this one ALTERs PmActivityVerb and
    // PmComment and references PmWorkItem / PmWorkItemAssignee.
    for (const needle of [
      "native_pm_foundation",
      "warp_884_885_pm_schema_hardening",
      "warp_2586_pm_work_item_relation",
    ]) {
      const prior = readdirSync(MIGRATIONS_DIR).find((d) => d.includes(needle));
      expect(prior, `a migration matching "${needle}" must exist`).toBeDefined();
      expect(MIGRATION > prior!, `${MIGRATION} must sort after ${prior}`).toBe(true);
    }
  });

  describe("is idempotent — safe to re-run on a populated database", () => {
    it("guards the one CREATE TYPE with duplicate_object", () => {
      expect((CODE.match(/CREATE TYPE/g) ?? []).length).toBe(1);
      const owner = DO_BLOCKS.find((b) => /CREATE TYPE "PmWatchReason"/.test(b));
      expect(owner, "CREATE TYPE must sit inside a DO block").toBeDefined();
      expect(guardedByDuplicateObject(owner!)).toBe(true);
      expect(NORM).toContain(
        `CREATE TYPE "PmWatchReason" AS ENUM ('CREATOR', 'ASSIGNEE', 'COMMENTER', 'MENTIONED', 'MANUAL')`,
      );
    });

    it("adds every column and creates every table and index with IF NOT EXISTS", () => {
      expect(CODE.match(/ADD COLUMN\s+(?!IF NOT EXISTS)/gi) ?? [], "unguarded ADD COLUMN").toEqual([]);
      expect(CODE.match(/CREATE TABLE\s+(?!IF NOT EXISTS)/gi) ?? [], "unguarded CREATE TABLE").toEqual([]);
      expect(
        CODE.match(/CREATE (?:UNIQUE )?INDEX\s+(?!IF NOT EXISTS)/gi) ?? [],
        "unguarded CREATE INDEX",
      ).toEqual([]);
      // …and there is something for those rules to apply to.
      expect((CODE.match(/ADD COLUMN IF NOT EXISTS/g) ?? []).length).toBe(4);
      expect((CODE.match(/CREATE TABLE IF NOT EXISTS/g) ?? []).length).toBe(3);
      expect((CODE.match(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g) ?? []).length).toBe(5);
    });

    it("wraps every ADD CONSTRAINT in a duplicate_object-guarded DO block", () => {
      const names = [...CODE.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].map((m) => m[1]);
      expect(names.sort()).toEqual(
        [
          "PmCommentMention_commentId_fkey",
          "PmCommentReaction_commentId_fkey",
          "PmComment_deleted_matches_flag",
          "PmComment_tombstone_has_no_body",
          "PmWorkItemWatcher_workItemId_fkey",
        ].sort(),
      );
      for (const name of names) {
        const owner = DO_BLOCKS.find((b) => b.includes(`ADD CONSTRAINT "${name}"`));
        expect(owner, `${name} must sit inside a DO block`).toBeDefined();
        expect(guardedByDuplicateObject(owner!), `${name} must tolerate a re-run`).toBe(true);
      }
    });
  });

  describe("PmComment edit + soft-delete columns", () => {
    it.each([
      `"editedAt" TIMESTAMP(3)`,
      `"isDeleted" BOOLEAN NOT NULL DEFAULT false`,
      `"deletedAt" TIMESTAMP(3)`,
      `"deletedById" TEXT`,
    ])("adds %s", (column) => {
      expect(NORM).toMatch(new RegExp(`ALTER TABLE "PmComment" ADD COLUMN IF NOT EXISTS [^;]*${escapeRe(column)}`));
    });

    it.each([
      [
        "PmComment_deleted_matches_flag",
        `CHECK ("isDeleted" = ("deletedAt" IS NOT NULL) AND ("deletedById" IS NULL OR "isDeleted"))`,
      ],
      ["PmComment_tombstone_has_no_body", `CHECK (NOT "isDeleted" OR "commentHtml" = '')`],
    ])("%s is a CHECK on PmComment with exactly this expression", (name, check) => {
      // The flag and the audit pair can never disagree, and a tombstone never
      // carries text. Behaviour is proven against Postgres in the pg lane.
      expect(NORM).toContain(`ALTER TABLE "PmComment" ADD CONSTRAINT "${name}" ${check}`);
    });
  });

  describe("PmActivityVerb extension", () => {
    it("adds exactly five values", () => {
      expect((CODE.match(/ADD VALUE/g) ?? []).length).toBe(NEW_VERBS.length);
    });

    it.each(NEW_VERBS)("adds %s behind a pg_enum existence check", (verb) => {
      const owner = DO_BLOCKS.find((b) => b.includes(`ADD VALUE '${verb}'`));
      expect(owner, `'${verb}' must be added inside a DO block`).toBeDefined();
      const sql = norm(owner!);
      expect(sql).toContain("IF NOT EXISTS (");
      expect(sql).toContain("FROM pg_enum");
      expect(sql).toContain("typname = 'PmActivityVerb'");
      expect(sql).toContain(`enumlabel = '${verb}'`);
      expect(sql).toContain(`ALTER TYPE "PmActivityVerb" ADD VALUE '${verb}';`);
      // The guard precedes the add.
      expect(sql.indexOf(`enumlabel = '${verb}'`)).toBeLessThan(sql.indexOf(`ADD VALUE '${verb}'`));
    });

    it.each(NEW_VERBS)("never USES %s anywhere else in the file", (verb) => {
      // Postgres refuses to use an enum value added by ALTER TYPE in the same
      // transaction, and Prisma applies a migration file in one. A later
      // INSERT/UPDATE/cast naming the value would fail on a real database while
      // passing every mocked test. Only the guard and the ADD may name it.
      const rest = CODE.replace(new RegExp(`enumlabel = '${verb}'`, "g"), "").replace(
        new RegExp(`ADD VALUE '${verb}'`, "g"),
        "",
      );
      expect(rest.includes(`'${verb}'`), `'${verb}' is referenced outside its guard and ADD VALUE`).toBe(false);
      expect(CODE.includes(`'${verb}'::"PmActivityVerb"`)).toBe(false);
    });
  });

  describe("the new tables", () => {
    it.each([
      [
        "PmCommentReaction",
        [
          `"id" TEXT NOT NULL`,
          `"commentId" TEXT NOT NULL`,
          `"userId" TEXT NOT NULL`,
          `"emoji" TEXT NOT NULL`,
          `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
          `CONSTRAINT "PmCommentReaction_pkey" PRIMARY KEY ("id")`,
        ],
      ],
      [
        "PmWorkItemWatcher",
        [
          `"id" TEXT NOT NULL`,
          `"workItemId" TEXT NOT NULL`,
          `"userId" TEXT NOT NULL`,
          `"reason" "PmWatchReason" NOT NULL`,
          `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
          `CONSTRAINT "PmWorkItemWatcher_pkey" PRIMARY KEY ("id")`,
        ],
      ],
      [
        "PmCommentMention",
        [
          `"id" TEXT NOT NULL`,
          `"commentId" TEXT NOT NULL`,
          `"userId" TEXT NOT NULL`,
          `"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP`,
          `CONSTRAINT "PmCommentMention_pkey" PRIMARY KEY ("id")`,
        ],
      ],
    ])("%s is created with the columns the schema declares", (table, columns) => {
      const created = new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\((.*?)\\);`).exec(NORM);
      expect(created, `CREATE TABLE ${table} must exist`).not.toBeNull();
      for (const column of columns) expect(created![1]).toContain(column);
    });

    it.each([
      ["PmCommentReaction_commentId_userId_emoji_key", "PmCommentReaction", `"commentId", "userId", "emoji"`, true],
      ["PmWorkItemWatcher_workItemId_userId_key", "PmWorkItemWatcher", `"workItemId", "userId"`, true],
      ["PmWorkItemWatcher_userId_idx", "PmWorkItemWatcher", `"userId"`, false],
      ["PmCommentMention_commentId_userId_key", "PmCommentMention", `"commentId", "userId"`, true],
      ["PmCommentMention_userId_idx", "PmCommentMention", `"userId"`, false],
    ])("%s indexes %s(%s) under the name Prisma expects", (name, table, columns, unique) => {
      // The names are the ones `prisma migrate diff` derives from the schema's
      // @@unique / @@index; any other name reads as drift.
      expect(NORM).toContain(
        `CREATE ${unique ? "UNIQUE " : ""}INDEX IF NOT EXISTS "${name}" ON "${table}"(${columns});`,
      );
    });

    it.each([
      ["PmCommentReaction_commentId_fkey", "PmCommentReaction", "commentId", "PmComment"],
      ["PmWorkItemWatcher_workItemId_fkey", "PmWorkItemWatcher", "workItemId", "PmWorkItem"],
      ["PmCommentMention_commentId_fkey", "PmCommentMention", "commentId", "PmComment"],
    ])("%s cascades from %s.%s to %s", (name, table, column, parent) => {
      expect(NORM).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}") REFERENCES "${parent}"("id") ON DELETE CASCADE ON UPDATE CASCADE;`,
      );
    });

    it("puts no foreign key on a userId or deletedById (a User.id string, not an FK)", () => {
      expect(CODE).not.toMatch(/FOREIGN KEY \("userId"\)/);
      expect(CODE).not.toMatch(/FOREIGN KEY \("deletedById"\)/);
      expect(CODE).not.toMatch(/REFERENCES "User"/);
    });
  });

  describe("the watcher backfill", () => {
    it("writes one ASSIGNEE watcher per existing assignee, carrying the assignment's createdAt", () => {
      expect((CODE.match(/INSERT INTO/g) ?? []).length, "the file backfills ASSIGNEE and nothing else").toBe(1);
      const insert = /INSERT INTO "PmWorkItemWatcher"[\s\S]*?;/.exec(CODE);
      expect(insert, "the backfill INSERT must exist").not.toBeNull();
      const sql = norm(insert![0]);
      expect(sql).toMatch(/^INSERT INTO "PmWorkItemWatcher" \("id", "workItemId", "userId", "reason", "createdAt"\) SELECT /);
      expect(sql).toContain(`'ASSIGNEE'::"PmWatchReason"`);
      expect(sql).toMatch(/\w+\."createdAt" FROM "PmWorkItemAssignee"/);
      // every existing assignment, not a filtered subset
      expect(sql).not.toMatch(/\bWHERE\b/i);
    });

    it("is idempotent: ON CONFLICT (workItemId, userId) DO NOTHING", () => {
      expect(NORM).toMatch(
        /FROM "PmWorkItemAssignee" \w+ ON CONFLICT \("workItemId", "userId"\) DO NOTHING;/,
      );
    });

    it("runs after the type, the table and the unique index it conflicts on exist", () => {
      const at = (needle: string) => CODE.indexOf(needle);
      const type = at(`CREATE TYPE "PmWatchReason"`);
      const table = at(`CREATE TABLE IF NOT EXISTS "PmWorkItemWatcher"`);
      const unique = at(`"PmWorkItemWatcher_workItemId_userId_key"`);
      const insert = at(`INSERT INTO "PmWorkItemWatcher"`);
      for (const [label, pos] of [["type", type], ["table", table], ["unique index", unique], ["insert", insert]] as const) {
        expect(pos, `${label} must be present`).toBeGreaterThan(-1);
      }
      expect(type).toBeLessThan(table);
      expect(table).toBeLessThan(unique);
      expect(unique).toBeLessThan(insert);
    });
  });

  it("is additive: nothing is dropped, truncated or deleted", () => {
    const destructive = [...CODE.matchAll(/\b(?:DROP|TRUNCATE|DELETE\s+FROM)\b[^;]*/gi)].map((m) => m[0].trim());
    expect(destructive).toEqual([]);
  });
});

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
