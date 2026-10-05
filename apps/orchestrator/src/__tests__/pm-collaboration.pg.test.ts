/**
 * WARP-3519 (ADR-069 WS-2) — comments, @mentions, reactions, watchers and the
 * merged activity timeline, against a REAL Postgres.
 *
 * WHAT ONLY A DATABASE CAN PROVE HERE
 *
 *   CHECKs        — `PmComment_deleted_matches_flag` and
 *                   `PmComment_tombstone_has_no_body` live in migration SQL
 *                   (Prisma's schema language cannot express them). A mocked
 *                   client accepts every row they reject, so a green unit suite
 *                   says nothing about them; each is driven by a RAW write that
 *                   bypasses the services, and each violating shape is built to
 *                   trip exactly ONE of the two.
 *   unique keys   — reaction (comment, user, emoji), watcher (item, user) and
 *                   mention (comment, user) are what turn "add it twice" into a
 *                   no-op instead of a count of two. Same for the CASCADEs.
 *   the backfill  — the migration's watcher backfill is SQL in a file, not
 *                   code. It is extracted from the migration and run for real,
 *                   twice.
 *   keyset paging — the timeline cursor has to survive rows that share a
 *                   timestamp (one transaction writes several activity rows in
 *                   the same millisecond). Only real rows prove that.
 *   the races     — edit-vs-delete and delete-vs-delete are forced, not hoped
 *                   for: one side is parked INSIDE its transaction holding the
 *                   row lock, and the other is released only once
 *                   pg_stat_activity shows it waiting on that lock
 *                   (workspace-delete-race.pg.test.ts is the precedent).
 *   the sweep     — the notification decision reads watchers, mentions and
 *                   users out of real tables, and the exactly-once claim is a
 *                   real `UPDATE ... WHERE "notifyStatus" = 'pending'`.
 *
 * Every service call is the REAL one. The only mock is the MQTT leaf
 * (`../services/mqtt.service.js`), exactly as in activity-notify.pg.test.ts:
 * every DECISION and every write stays real.
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL like every *.pg.test.ts.
 * Local: scripts/test-orchestrator-pg.sh.
 *
 * FIXTURE SCOPING — the DB is shared by the pg suites. Every row this file
 * mints is namespaced `warp3519-` (workspace slug, project name, usernames) and
 * every cleanup is scoped to that prefix, FK-ordered — never an unscoped
 * deleteMany, never a TRUNCATE. The lane runs with --no-file-parallelism and
 * this file relies on it: the notify sweep reads EVERY pending PmActivity row
 * in the database, so a sibling suite's in-flight rows would be swept by ours.
 * Assertions on notifications therefore read OUR NotificationLog rows by
 * username, never the sweep's database-wide counters.
 */
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { $Enums, Prisma, PrismaClient } from "@prisma/client";
import { PM_ACTIVITY_VERBS, PM_REACTION_EMOJI, PM_TIMELINE_MIRRORED_VERBS } from "@droplet/shared-types";
import { MIGRATIONS_DIR } from "./helpers/test-paths.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

// Leaf EFFECT only. The NotificationLog rows this suite reads are written by
// the real sweep.
vi.mock("../services/mqtt.service.js", () => ({ publish: vi.fn() }));

import * as pm from "../services/pm/pm.service.js";
import * as collab from "../services/pm/pm-collaboration.service.js";
import { runActivityNotifySweep, SETTLE_MS } from "../services/activity-notify.service.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const PREFIX = "warp3519-";
const OURS = { startsWith: PREFIX } as const;

type RoleName = "owner" | "admin" | "family" | "guest" | "service";

interface Person {
  id: string;
  username: string;
  displayName: string;
  role: RoleName;
}

interface Item {
  id: string;
  sequenceId: number;
  name: string;
  /** "W19A-1001" — how the notify sweep names an item in a notification body. */
  key: string;
}

const THUMBS_UP = "\u{1F44D}";
const THUMBS_DOWN = "\u{1F44E}";
const PARTY = "\u{1F389}";
const ROCKET = "\u{1F680}";
/** U+2764 on its own: what several keyboards emit. */
const BARE_HEART = "❤";
/** U+2764 U+FE0F: the canonical, stored form. */
const HEART = "❤️";

/** A well-formed id that belongs to nobody. */
const GHOST = { id: "11111111-1111-4111-8111-111111111111", displayName: "Ghost Writer" };

const NO_ACTOR: collab.CollabActor = { id: null, role: undefined };
const actor = (p: Person): collab.CollabActor => ({ id: p.id, role: p.role });

/**
 * The clock every sweep runs on. Service-written rows are stamped "now", so the
 * sweep's settle window would hide them; this is far enough ahead to clear it
 * AND any clock skew between this host and the database container (a WSL2
 * Postgres is routinely seconds off).
 */
const SWEEP_AHEAD_MS = SETTLE_MS + 5 * 60_000;

/** A fixed, distant-past instant for rows whose ORDER or AGE a test must pin. */
const LONG_AGO = new Date("2026-01-01T00:00:00.000Z");

/** Timeline fixtures: entry n sits n seconds after T0. */
const T0 = Date.parse("2026-03-01T10:00:00.000Z");
const tAt = (n: number) => new Date(T0 + n * 1_000);

// ── tiny pure helpers ───────────────────────────────────────────────────────

/** `<span data-mention-id>` — the one span the sanitizer keeps. */
const chip = (p: { id: string; displayName: string }) =>
  `<span data-mention-id="${p.id}">@${p.displayName}</span>`;
/** What a dropped mention is unwrapped to in the stored html. */
const plain = (p: { displayName: string }) => `@${p.displayName}`;
const para = (...parts: string[]) => `<p>${parts.join(" ")}</p>`;
const sorted = (xs: readonly string[]) => [...xs].sort();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Awaits `p` and asserts it rejected with `Error(code)` — the services' error convention. */
async function rejectsWith(p: Promise<unknown>, code: string): Promise<void> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e ?? new Error("rejected with a nullish value"),
  );
  expect(err, `expected a rejection with "${code}", but the call resolved`).toBeDefined();
  expect(err instanceof Error ? err.message : String(err)).toBe(code);
}

/** Settles into a value or the error, so a refusal can be inspected later. */
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The migration's watcher backfill: the final INSERT ... ON CONFLICT ... DO
 * NOTHING statement, as written in the migration file (so a rewrite of the
 * migration is what gets tested, not a copy of it here).
 */
function backfillStatement(): string {
  const dir = readdirSync(MIGRATIONS_DIR).find((d) => d.includes("warp_3519_pm_collaboration"));
  expect(dir, "the WARP-3519 migration directory must exist").toBeDefined();
  const sql = readFileSync(join(MIGRATIONS_DIR, dir as string, "migration.sql"), "utf8");
  const found = [
    ...sql.matchAll(/INSERT\s+INTO\s+"PmWorkItemWatcher"[\s\S]*?ON\s+CONFLICT[\s\S]*?DO\s+NOTHING\s*;/gi),
  ];
  expect(found.length, "the migration must carry the watcher backfill").toBeGreaterThan(0);
  return found[found.length - 1][0];
}

describe.skipIf(!RUN)("PM collaboration — comments, mentions, reactions, watchers, timeline (WARP-3519)", () => {
  let prisma: PrismaClient;
  /** Every SQL statement the client has issued — for the "no N+1" assertions. */
  let queryCount = 0;

  let owner!: Person;
  let admin!: Person;
  /** The author most tests comment as. */
  let ann!: Person;
  let ben!: Person;
  let cara!: Person;
  let dan!: Person;
  /** An ordinary member who is set as a project's lead only where a test says so. */
  let lead!: Person;
  /** A third ordinary member, for "somebody uninvolved". */
  let eve!: Person;
  /** A guest who is never assigned anywhere unless a test assigns them. */
  let guest!: Person;
  /** A guest that tests assign to ONE item. */
  let guestAssigned!: Person;
  let deact!: Person;
  let svc!: Person;

  let workspaceSeq = 0;
  let seq = 1000;
  let workspaceId = "";
  let project!: { id: string; identifier: string };
  let todo!: { id: string; name: string };
  let doing!: { id: string; name: string };
  /** The default fixture item: no assignees, no watchers, no comments, no activity. */
  let item!: Item;

  // ── fixtures ──────────────────────────────────────────────────────────────

  async function makePerson(
    key: string,
    role: RoleName,
    displayName: string,
    directoryStatus: "ACTIVE" | "DEACTIVATED" = "ACTIVE",
  ): Promise<Person> {
    const username = `${PREFIX}${key}`;
    const row = await prisma.user.create({ data: { username, displayName, role, directoryStatus } });
    return { id: row.id, username, displayName, role };
  }

  /** `n` active members with ids known up front, for the 20-mention cap. */
  async function makeCrowd(n: number): Promise<Person[]> {
    const people: Person[] = Array.from({ length: n }, (_, i) => {
      const nn = String(i + 1).padStart(2, "0");
      return { id: randomUUID(), username: `${PREFIX}crowd-${nn}`, displayName: `Crowd ${nn}`, role: "family" };
    });
    await prisma.user.createMany({
      data: people.map((p) => ({ id: p.id, username: p.username, displayName: p.displayName, role: p.role })),
    });
    return people;
  }

  /**
   * A work item written straight to the table: no watchers, no activity, no
   * auto-anything. Sequence ids start at 1001 so they never collide with the
   * numbers `pm.createWorkItem` takes from the project counter.
   */
  async function rawItem(
    over: {
      name?: string;
      project?: { id: string; identifier: string };
      assignees?: Person[];
      stateId?: string | null;
      createdById?: string | null;
    } = {},
  ): Promise<Item> {
    const proj = over.project ?? project;
    const sequenceId = ++seq;
    const row = await prisma.pmWorkItem.create({
      data: {
        projectId: proj.id,
        sequenceId,
        name: `${PREFIX}${over.name ?? `item-${sequenceId}`}`,
        stateId: over.stateId ?? null,
        createdById: over.createdById ?? null,
        assignees: over.assignees?.length
          ? { create: over.assignees.map((a) => ({ userId: a.id })) }
          : undefined,
      },
    });
    return { id: row.id, sequenceId, name: row.name, key: `${proj.identifier}-${sequenceId}` };
  }

  const say = (who: Person | null, itemId: string, html: string) =>
    pm.addComment(prisma, who?.id ?? null, itemId, html);

  const watch = (
    it_: Item,
    who: Person,
    reason: $Enums.PmWatchReason = "MANUAL",
    createdAt?: Date,
  ) =>
    prisma.pmWorkItemWatcher.create({
      data: { workItemId: it_.id, userId: who.id, reason, ...(createdAt ? { createdAt } : {}) },
    });

  /** Pushes a comment's timestamps into the past so "an edit changes updatedAt" is not a same-millisecond coin flip. */
  const backdate = (commentId: string) =>
    prisma.pmComment.update({ where: { id: commentId }, data: { createdAt: LONG_AGO, updatedAt: LONG_AGO } });

  /**
   * A comment written straight to the table at fixture time `n` (a tombstone
   * satisfies both CHECKs). The timestamp is pinned, so order is a fact and
   * not a race between two inserts in the same millisecond.
   */
  const seedComment = (
    workItemId: string,
    n: number,
    over: { authorId?: string | null; html?: string; deleted?: boolean } = {},
  ) =>
    prisma.pmComment.create({
      data: {
        workItemId,
        authorId: over.authorId === undefined ? ann.id : over.authorId,
        commentHtml: over.deleted ? "" : (over.html ?? `<p>comment ${n}</p>`),
        createdAt: tAt(n),
        updatedAt: tAt(n),
        ...(over.deleted ? { isDeleted: true, deletedAt: tAt(n + 3_600), deletedById: ann.id } : {}),
      },
    });

  /** An activity row at fixture time `n`, already out of the notification queue. */
  const seedActivity = (
    workItemId: string,
    n: number,
    verb: $Enums.PmActivityVerb,
    over: { actorId?: string | null; field?: string | null; oldValue?: string | null; newValue?: string | null } = {},
  ) =>
    prisma.pmActivity.create({
      data: {
        workItemId,
        actorId: over.actorId === undefined ? ann.id : over.actorId,
        verb,
        field: over.field ?? null,
        oldValue: over.oldValue ?? null,
        newValue: over.newValue ?? null,
        createdAt: tAt(n),
        notifyStatus: "not_needed",
      },
    });

  // ── database readers ─────────────────────────────────────────────────────

  const storedComment = (id: string) => prisma.pmComment.findUniqueOrThrow({ where: { id } });

  const activityRows = (workItemId: string, verb?: $Enums.PmActivityVerb) =>
    prisma.pmActivity.findMany({
      where: { workItemId, ...(verb ? { verb } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });

  const verbsOf = async (workItemId: string) => sorted((await activityRows(workItemId)).map((r) => r.verb));

  /** `{ [userId]: reason }` — one full-set assertion pins WHO is watching and WHY. */
  const watcherReasons = async (workItemId: string) =>
    Object.fromEntries(
      (await prisma.pmWorkItemWatcher.findMany({ where: { workItemId } })).map((w) => [w.userId, w.reason]),
    );

  const mentionedIds = async (commentId: string) =>
    sorted((await prisma.pmCommentMention.findMany({ where: { commentId } })).map((m) => m.userId));

  const reactionRows = (commentId: string) => prisma.pmCommentReaction.findMany({ where: { commentId } });

  /** Every OUR-user NotificationLog title, grouped by username. */
  async function inbox(): Promise<Record<string, string[]>> {
    const rows = await prisma.notificationLog.findMany({
      where: { username: OURS },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { username: true, title: true },
    });
    const out: Record<string, string[]> = {};
    for (const r of rows) (out[r.username] ??= []).push(r.title);
    return out;
  }

  const lines = (who: Person) =>
    prisma.notificationLog.findMany({
      where: { username: who.username },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { kind: true, title: true, body: true },
    });

  /** `verb:notifyStatus` of every activity row on an item, sorted. */
  const claimStates = async (workItemId: string) =>
    sorted((await activityRows(workItemId)).map((r) => `${r.verb}:${r.notifyStatus}`));

  const sweep = (opts: Parameters<typeof runActivityNotifySweep>[1] = {}) =>
    runActivityNotifySweep(prisma, { now: () => Date.now() + SWEEP_AHEAD_MS, ...opts });

  /** Statements issued while `fn` runs. The settle sleeps let the client's async query log drain. */
  async function countQueries(fn: () => Promise<unknown>): Promise<number> {
    await sleep(80);
    const before = queryCount;
    await fn();
    await sleep(80);
    return queryCount - before;
  }

  // ── row-lock choreography for the races ──────────────────────────────────

  /**
   * Runs `work` inside an interactive transaction and keeps that transaction
   * OPEN until `release()`: whatever row locks `work` took stay held while the
   * caller starts the other side of a race.
   */
  function parkedTx(work: (tx: Prisma.TransactionClient) => Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let done!: Promise<void>;
    const parked = new Promise<void>((resolve, reject) => {
      done = prisma.$transaction(
        async (tx) => {
          try {
            await work(tx);
          } catch (err) {
            reject(err);
            throw err;
          }
          resolve();
          await gate;
        },
        { timeout: 30_000, maxWait: 10_000 },
      );
    });
    return { parked, release, done };
  }

  /** Blocks until some backend waits on a lock while running a statement containing `fragment`. */
  async function waitingOnLock(fragment: string): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
      const rows = await prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE ${`%${fragment}%`}`;
      if (rows[0].n > 0) return;
      await sleep(50);
    }
    throw new Error(`no backend waited on a lock running ${fragment}`);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async function cleanupOurRows() {
    // Workspace → projects → items → comments / reactions / mentions /
    // watchers / assignees / labels / states / activity, all by CASCADE.
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.notificationLog.deleteMany({ where: { username: OURS } });
  }

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    const client = new RealPrismaClient({ log: [{ emit: "event", level: "query" }] });
    (client as unknown as { $on: (event: "query", cb: () => void) => void }).$on("query", () => {
      queryCount += 1;
    });
    prisma = client as unknown as PrismaClient;
    await prisma.$connect();

    // A crashed earlier run may have left rows behind.
    await cleanupOurRows();
    await prisma.user.deleteMany({ where: { username: OURS } });

    owner = await makePerson("owner", "owner", "Olive Owner");
    admin = await makePerson("admin", "admin", "Adam Admin");
    ann = await makePerson("ann", "family", "Ann Author");
    ben = await makePerson("ben", "family", "Ben Builder");
    cara = await makePerson("cara", "family", "Cara Carpenter");
    dan = await makePerson("dan", "family", "Dan Driver");
    lead = await makePerson("lead", "family", "Lee Lead");
    eve = await makePerson("eve", "family", "Eve Extra");
    guest = await makePerson("guest", "guest", "Gus Guest");
    guestAssigned = await makePerson("guest-assigned", "guest", "Gwen Guest");
    deact = await makePerson("deact", "family", "Dee Deactivated", "DEACTIVATED");
    svc = await makePerson("svc", "service", "Sam Service");
  });

  afterAll(async () => {
    await cleanupOurRows();
    await prisma.user.deleteMany({ where: { username: OURS } });
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await cleanupOurRows();
    seq = 1000;
    const ws = await prisma.pmWorkspace.create({
      data: { slug: `${PREFIX}ws-${Date.now()}-${++workspaceSeq}`, name: `${PREFIX}ws` },
    });
    workspaceId = ws.id;
    const proj = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: `${PREFIX}alpha`, identifier: "W19A" },
    });
    project = { id: proj.id, identifier: proj.identifier };
    const s1 = await prisma.pmState.create({
      data: { projectId: proj.id, name: `${PREFIX}Todo`, group: "unstarted", isDefault: true, sortOrder: 1 },
    });
    const s2 = await prisma.pmState.create({
      data: { projectId: proj.id, name: `${PREFIX}Doing`, group: "started", sortOrder: 2 },
    });
    todo = { id: s1.id, name: s1.name };
    doing = { id: s2.id, name: s2.name };
    item = await rawItem({ name: "item", stateId: todo.id });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // A. SCHEMA INVARIANTS — raw prisma writes, the services bypassed
  // ═════════════════════════════════════════════════════════════════════════

  describe("A. schema invariants (raw writes, services bypassed)", () => {
    const rawComment = (over: Partial<Prisma.PmCommentUncheckedCreateInput> = {}) =>
      prisma.pmComment.create({
        data: { workItemId: item.id, authorId: ann.id, commentHtml: "<p>hi</p>", ...over },
      });

    describe("PmComment_deleted_matches_flag", () => {
      // Defends: a "deleted" row with no audit timestamp. The flag is the
      // canonical signal and deletedAt the audit pair; they must never disagree.
      // The body is '' so the OTHER check is not the one that fires.
      it("rejects isDeleted without deletedAt", async () => {
        await expect(rawComment({ isDeleted: true, commentHtml: "" })).rejects.toThrow(
          /PmComment_deleted_matches_flag/,
        );
      });

      // Defends: the mirror image — a timestamp on a row the flag calls live
      // would make "is it deleted?" depend on which column a reader trusts.
      it("rejects deletedAt without isDeleted", async () => {
        await expect(rawComment({ deletedAt: new Date() })).rejects.toThrow(/PmComment_deleted_matches_flag/);
      });

      // Defends: a recorded deleter on a comment that was never deleted (the
      // `deletedById IS NULL OR isDeleted` half of the check).
      it("rejects deletedById without isDeleted", async () => {
        await expect(rawComment({ deletedById: ann.id })).rejects.toThrow(/PmComment_deleted_matches_flag/);
      });

      // Defends: the check is not satisfied by supplying the audit pair alone.
      it("rejects deletedAt + deletedById while the flag still says live", async () => {
        await expect(rawComment({ deletedAt: new Date(), deletedById: ann.id })).rejects.toThrow(
          /PmComment_deleted_matches_flag/,
        );
      });
    });

    describe("PmComment_tombstone_has_no_body", () => {
      // Defends: a non-service writer leaving the text of a "deleted" comment
      // readable. Flag + timestamp + deleter are all consistent here, so only
      // the body check can be the one that fires.
      it("rejects a tombstone that still has a body", async () => {
        await expect(
          rawComment({
            isDeleted: true,
            deletedAt: new Date(),
            deletedById: ann.id,
            commentHtml: "<p>still readable</p>",
          }),
        ).rejects.toThrow(/PmComment_tombstone_has_no_body/);
      });

      // Defends: the CHECKs are not so strict they reject the shape the service
      // writes — flag set, timestamp, deleter, empty body.
      it("accepts a valid tombstone, with or without a recorded deleter", async () => {
        const withDeleter = await rawComment({
          isDeleted: true,
          deletedAt: new Date(),
          deletedById: owner.id,
          commentHtml: "",
        });
        expect(withDeleter).toMatchObject({ isDeleted: true, deletedById: owner.id, commentHtml: "" });
        const noDeleter = await rawComment({ isDeleted: true, deletedAt: new Date(), commentHtml: "" });
        expect(noDeleter).toMatchObject({ isDeleted: true, deletedById: null, commentHtml: "" });
      });

      // Defends: the database as the LAST line of defence against an edit that
      // lost a race with a delete and tries to write text back onto the
      // tombstone — the UPDATE path is guarded too, not just INSERT.
      it("refuses to give a tombstone its body back through UPDATE", async () => {
        const dead = await rawComment({
          isDeleted: true,
          deletedAt: new Date(),
          deletedById: ann.id,
          commentHtml: "",
        });
        await expect(
          prisma.pmComment.update({ where: { id: dead.id }, data: { commentHtml: "<p>back from the dead</p>" } }),
        ).rejects.toThrow(/PmComment_tombstone_has_no_body/);
        expect((await storedComment(dead.id)).commentHtml).toBe("");
      });

      // Defends: a delete that flips the flag but forgets to clear the body.
      it("refuses to flag a comment deleted while its body is still there", async () => {
        const live = await rawComment();
        await expect(
          prisma.pmComment.update({ where: { id: live.id }, data: { isDeleted: true, deletedAt: new Date() } }),
        ).rejects.toThrow(/PmComment_tombstone_has_no_body/);
        // …and the shape the service writes is the one that goes through.
        const done = await prisma.pmComment.update({
          where: { id: live.id },
          data: { isDeleted: true, deletedAt: new Date(), deletedById: ann.id, commentHtml: "" },
        });
        expect(done).toMatchObject({ isDeleted: true, commentHtml: "" });
      });
    });

    describe("unique keys", () => {
      // Defends: adding the same reaction twice being a count of two. A
      // different emoji, or the same emoji from somebody else, is a new row.
      it("PmCommentReaction is unique per (comment, user, emoji)", async () => {
        const c = await rawComment();
        await prisma.pmCommentReaction.create({ data: { commentId: c.id, userId: ben.id, emoji: THUMBS_UP } });
        await expect(
          prisma.pmCommentReaction.create({ data: { commentId: c.id, userId: ben.id, emoji: THUMBS_UP } }),
        ).rejects.toMatchObject({ code: "P2002" });
        await prisma.pmCommentReaction.create({ data: { commentId: c.id, userId: ben.id, emoji: ROCKET } });
        await prisma.pmCommentReaction.create({ data: { commentId: c.id, userId: cara.id, emoji: THUMBS_UP } });
        expect(await prisma.pmCommentReaction.count({ where: { commentId: c.id } })).toBe(3);
      });

      // Defends: two watcher rows for one person, which would notify them
      // twice. The key is (item, user) — the REASON is not part of it, so a
      // second row with another reason is refused too.
      it("PmWorkItemWatcher is unique per (item, user) whatever the reason", async () => {
        await watch(item, ben, "MANUAL");
        await expect(watch(item, ben, "MANUAL")).rejects.toMatchObject({ code: "P2002" });
        await expect(watch(item, ben, "COMMENTER")).rejects.toMatchObject({ code: "P2002" });
        await watch(item, cara, "MANUAL");
        expect(await prisma.pmWorkItemWatcher.count({ where: { workItemId: item.id } })).toBe(2);
      });

      // Defends: a person mentioned twice in one comment becoming two mention
      // rows (and so two notifications).
      it("PmCommentMention is unique per (comment, user)", async () => {
        const c = await rawComment();
        await prisma.pmCommentMention.create({ data: { commentId: c.id, userId: ben.id } });
        await expect(
          prisma.pmCommentMention.create({ data: { commentId: c.id, userId: ben.id } }),
        ).rejects.toMatchObject({ code: "P2002" });
        await prisma.pmCommentMention.create({ data: { commentId: c.id, userId: cara.id } });
        expect(await prisma.pmCommentMention.count({ where: { commentId: c.id } })).toBe(2);
      });
    });

    describe("CASCADE", () => {
      // Defends: a hard delete of a comment (an admin purge, a fix-up script)
      // stranding reactions and mentions that point at nothing — and, the
      // other way round, the cascade eating a SIBLING comment's rows.
      it("deleting a comment takes its reactions and mentions with it, and only its own", async () => {
        const gone = await rawComment();
        const kept = await rawComment({ commentHtml: "<p>other</p>" });
        for (const c of [gone, kept]) {
          await prisma.pmCommentReaction.create({ data: { commentId: c.id, userId: ben.id, emoji: THUMBS_UP } });
          await prisma.pmCommentMention.create({ data: { commentId: c.id, userId: cara.id } });
        }
        await prisma.pmComment.delete({ where: { id: gone.id } });
        expect(await prisma.pmCommentReaction.count({ where: { commentId: gone.id } })).toBe(0);
        expect(await prisma.pmCommentMention.count({ where: { commentId: gone.id } })).toBe(0);
        expect(await prisma.pmCommentReaction.count({ where: { commentId: kept.id } })).toBe(1);
        expect(await prisma.pmCommentMention.count({ where: { commentId: kept.id } })).toBe(1);
      });

      // Defends: deleting a work item leaving comments, watchers or (through
      // the comment) reactions and mentions behind. The sibling item's rows
      // prove the cascade is scoped.
      it("deleting a work item takes its comments, watchers, reactions and mentions with it", async () => {
        const doomed = await rawItem({ name: "doomed" });
        const sibling = await rawItem({ name: "sibling" });
        const commentIds: string[] = [];
        for (const it_ of [doomed, sibling]) {
          const c = await prisma.pmComment.create({
            data: { workItemId: it_.id, authorId: ann.id, commentHtml: "<p>x</p>" },
          });
          commentIds.push(c.id);
          await prisma.pmCommentReaction.create({ data: { commentId: c.id, userId: ben.id, emoji: PARTY } });
          await prisma.pmCommentMention.create({ data: { commentId: c.id, userId: cara.id } });
          await watch(it_, dan, "MANUAL");
        }
        await prisma.pmWorkItem.delete({ where: { id: doomed.id } });

        expect(await prisma.pmComment.count({ where: { workItemId: doomed.id } })).toBe(0);
        expect(await prisma.pmWorkItemWatcher.count({ where: { workItemId: doomed.id } })).toBe(0);
        expect(await prisma.pmCommentReaction.count({ where: { commentId: commentIds[0] } })).toBe(0);
        expect(await prisma.pmCommentMention.count({ where: { commentId: commentIds[0] } })).toBe(0);

        expect(await prisma.pmComment.count({ where: { workItemId: sibling.id } })).toBe(1);
        expect(await prisma.pmWorkItemWatcher.count({ where: { workItemId: sibling.id } })).toBe(1);
        expect(await prisma.pmCommentReaction.count({ where: { commentId: commentIds[1] } })).toBe(1);
        expect(await prisma.pmCommentMention.count({ where: { commentId: commentIds[1] } })).toBe(1);
      });
    });

    describe("PmActivityVerb", () => {
      // Defends: a verb the service writes that the migration forgot to add to
      // the enum (Postgres refuses it at the first write, on a customer's box).
      it.each(["comment_edited", "comment_deleted", "watcher_added", "watcher_removed", "mentioned"] as const)(
        "can write a %s row",
        async (verb) => {
          const row = await prisma.pmActivity.create({
            data: { workItemId: item.id, actorId: ann.id, verb, field: "comment", notifyStatus: "not_needed" },
          });
          expect((await prisma.pmActivity.findUniqueOrThrow({ where: { id: row.id } })).verb).toBe(verb);
        },
      );

      // Defends: the shared PM_ACTIVITY_VERBS list (what the dashboard's
      // exhaustive verb table is typed against) drifting from the database
      // enum — "the timeline renders every verb" cannot rot into "every verb
      // somebody remembered".
      it("is exactly the list in @droplet/shared-types", async () => {
        const rows = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
          SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
          WHERE t.typname = 'PmActivityVerb'`;
        expect(sorted(rows.map((r) => r.enumlabel))).toEqual(sorted(PM_ACTIVITY_VERBS));
      });
    });

    describe("the migration's watcher backfill", () => {
      const T1 = new Date("2026-02-01T08:00:00.000Z");
      const T2 = new Date("2026-02-02T08:00:00.000Z");
      const T3 = new Date("2026-02-03T08:00:00.000Z");

      const rowsFor = async (ids: string[]) =>
        (
          await prisma.pmWorkItemWatcher.findMany({
            where: { workItemId: { in: ids } },
            orderBy: [{ workItemId: "asc" }, { userId: "asc" }],
          })
        ).map((w) => ({
          id: w.id,
          workItemId: w.workItemId,
          userId: w.userId,
          reason: w.reason,
          createdAt: w.createdAt.toISOString(),
        }));

      // Defends: the backfill (a) creating exactly one ASSIGNEE row per
      // assignee with the assignee row's own createdAt, (b) clobbering a
      // watcher row that is already there, (c) inventing watchers for people
      // who merely created an item or commented on it long ago — a behaviour
      // change, not a record of one — and (d) not being idempotent, which it
      // must be because a migration can be re-applied on a populated database.
      it("adds one ASSIGNEE row per assignee, keeps existing rows, and a second run changes nothing", async () => {
        const statement = backfillStatement();
        expect(statement.trim().replace(/;\s*$/, ""), "must be a single statement").not.toContain(";");

        const a = await rawItem({ name: "backfill-a", createdById: ann.id });
        const b = await rawItem({ name: "backfill-b" });
        await prisma.pmWorkItemAssignee.createMany({
          data: [
            { workItemId: a.id, userId: ben.id, createdAt: T1 },
            { workItemId: a.id, userId: cara.id, createdAt: T2 },
            { workItemId: b.id, userId: ben.id, createdAt: T3 },
          ],
        });
        // cara already watches `a` by hand: the backfill must leave that row alone.
        await watch(a, cara, "MANUAL", T3);
        await prisma.pmComment.create({
          data: { workItemId: a.id, authorId: dan.id, commentHtml: "<p>months ago</p>" },
        });

        await prisma.$executeRawUnsafe(statement);
        const first = await rowsFor([a.id, b.id]);
        expect(first.map(({ id: _id, ...rest }) => rest)).toEqual(
          [
            { workItemId: a.id, userId: ben.id, reason: "ASSIGNEE", createdAt: T1.toISOString() },
            { workItemId: a.id, userId: cara.id, reason: "MANUAL", createdAt: T3.toISOString() },
            { workItemId: b.id, userId: ben.id, reason: "ASSIGNEE", createdAt: T3.toISOString() },
          ].sort((x, y) => (x.workItemId + x.userId).localeCompare(y.workItemId + y.userId)),
        );
        // Exactly one ASSIGNEE row per assignee that had no row — and none for
        // the creator or the commenter.
        expect(first.filter((r) => r.reason === "ASSIGNEE")).toHaveLength(2);
        expect(first.some((r) => r.userId === ann.id || r.userId === dan.id)).toBe(false);

        await prisma.$executeRawUnsafe(statement);
        expect(await rowsFor([a.id, b.id])).toEqual(first);
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // B. COMMENTS + MENTIONS
  // ═════════════════════════════════════════════════════════════════════════

  describe("B. comments and @mentions", () => {
    describe("addComment", () => {
      // Defends: the extended wire shape the dashboard renders from — every
      // WS-2 field is present (null / false / empty, not omitted) on a plain comment.
      it("returns the extended ApiComment", async () => {
        const c = await say(ann, item.id, para("hello"));
        expect(c).toMatchObject({
          workItemId: item.id,
          authorId: ann.id,
          commentHtml: "<p>hello</p>",
          editedAt: null,
          deleted: false,
          deletedAt: null,
          deletedById: null,
          mentions: [],
          reactions: [],
        });
        expect(new Date(c.createdAt).toISOString()).toBe(c.createdAt);
        expect(new Date(c.updatedAt).toISOString()).toBe(c.updatedAt);
      });

      // Defends: the unknown-item path stays a typed error rather than an FK 500.
      it("refuses an unknown work item", async () => {
        await rejectsWith(say(ann, GHOST.id, para("x")), "work_item_not_found");
      });

      describe("who can be mentioned — readers only", () => {
        const cases: Array<{
          label: string;
          who: () => { id: string; displayName: string };
          kept: boolean;
          assignGuest?: boolean;
        }> = [
          { label: "an ordinary member", who: () => ben, kept: true },
          { label: "an owner", who: () => owner, kept: true },
          { label: "an admin", who: () => admin, kept: true },
          { label: "a guest who is NOT assigned to the item", who: () => guest, kept: false },
          { label: "a guest assigned to THAT item", who: () => guestAssigned, kept: true, assignGuest: true },
          { label: "a deactivated user", who: () => deact, kept: false },
          { label: "a service-role user", who: () => svc, kept: false },
          { label: "an id that belongs to nobody", who: () => GHOST, kept: false },
        ];

        for (const c of cases) {
          // Defends: the read rule, per kind of user. A kept mention yields a
          // mention row, a `mentioned` activity row and a MENTIONED watcher; a
          // dropped one is unwrapped to plain "@Name" in the STORED html and
          // leaves NO row, NO activity and NO watcher — a mention is a
          // notification and a subscription, so an unreadable mention would
          // leak the item's existence to somebody who may not see it.
          it(`${c.kept ? "keeps" : "drops"} a mention of ${c.label}`, async () => {
            const target = c.who();
            const where = c.assignGuest
              ? await rawItem({ name: "guest-item", assignees: [guestAssigned] })
              : item;
            const created = await say(ann, where.id, para("cc", chip(target)));

            const stored = await storedComment(created.id);
            const mentionActs = (await activityRows(where.id, "mentioned")).map(
              ({ actorId, field, oldValue, newValue }) => ({ actorId, field, oldValue, newValue }),
            );
            const reasons = await watcherReasons(where.id);

            if (c.kept) {
              expect(created.mentions).toEqual([target.id]);
              expect(await mentionedIds(created.id)).toEqual([target.id]);
              expect(stored.commentHtml).toBe(para("cc", chip(target)));
              expect(mentionActs).toEqual([
                { actorId: ann.id, field: "comment", oldValue: created.id, newValue: target.id },
              ]);
              expect(reasons).toEqual({ [ann.id]: "COMMENTER", [target.id]: "MENTIONED" });
            } else {
              expect(created.mentions).toEqual([]);
              expect(await mentionedIds(created.id)).toEqual([]);
              expect(stored.commentHtml).toBe(para("cc", plain(target)));
              expect(stored.commentHtml).not.toContain("data-mention-id");
              expect(mentionActs).toEqual([]);
              expect(reasons).toEqual({ [ann.id]: "COMMENTER" });
            }
          });
        }

        // Defends: "assigned" being read as a global fact about the guest. The
        // rule is per ITEM — a guest is admitted to the one thing assigned to them.
        it("a guest assigned to a DIFFERENT item is not a reader of this one", async () => {
          await rawItem({ name: "elsewhere", assignees: [guestAssigned] });
          const created = await say(ann, item.id, para("cc", chip(guestAssigned)));
          expect(created.mentions).toEqual([]);
          expect((await storedComment(created.id)).commentHtml).toBe(para("cc", plain(guestAssigned)));
          expect(await activityRows(item.id, "mentioned")).toEqual([]);
          expect(await watcherReasons(item.id)).toEqual({ [ann.id]: "COMMENTER" });
        });

        // Defends: the readers/non-readers split being applied per comment
        // rather than per mention (all-or-nothing), and the stored html
        // keeping the span for exactly the people the rows say.
        it("keeps the readers and drops the rest within ONE comment", async () => {
          const created = await say(ann, item.id, para(chip(ben), chip(deact), chip(cara), chip(guest), chip(GHOST)));
          const readers = sorted([ben.id, cara.id]);
          expect(sorted(created.mentions)).toEqual(readers);
          expect(await mentionedIds(created.id)).toEqual(readers);
          expect((await storedComment(created.id)).commentHtml).toBe(
            para(chip(ben), plain(deact), chip(cara), plain(guest), plain(GHOST)),
          );
          expect(sorted((await activityRows(item.id, "mentioned")).map((r) => r.newValue ?? ""))).toEqual(readers);
          expect(await watcherReasons(item.id)).toEqual({
            [ann.id]: "COMMENTER",
            [ben.id]: "MENTIONED",
            [cara.id]: "MENTIONED",
          });
        });
      });

      // Defends: one person mentioned twice becoming two rows / two notifications.
      it("a person mentioned twice is one mention", async () => {
        const created = await say(ann, item.id, para(chip(ben), "and again", chip(ben)));
        expect(created.mentions).toEqual([ben.id]);
        expect(await prisma.pmCommentMention.count({ where: { commentId: created.id } })).toBe(1);
        expect(await activityRows(item.id, "mentioned")).toHaveLength(1);
      });

      // Defends: mentions being read from anything but the sanitized span —
      // the client never supplies a list, and "@Ben" typed as text is just text.
      it("plain '@Name' text is not a mention", async () => {
        const created = await say(ann, item.id, para(plain(ben)));
        expect(created.mentions).toEqual([]);
        expect(await activityRows(item.id, "mentioned")).toEqual([]);
        expect(await watcherReasons(item.id)).toEqual({ [ann.id]: "COMMENTER" });
      });

      // Defends: a span with a hostile / malformed id surviving into storage,
      // where its id is later read back to decide who is notified.
      it("a span whose id is not id-shaped is plain text, not a mention", async () => {
        const created = await say(ann, item.id, `<p><span data-mention-id="not an id">@Ben</span></p>`);
        expect(created.mentions).toEqual([]);
        expect((await storedComment(created.id)).commentHtml).toBe("<p>@Ben</p>");
        expect(await prisma.pmCommentMention.count({ where: { commentId: created.id } })).toBe(0);
      });

      // Defends: the 20-mention cap (spam / fan-out guard). Every mention here
      // is a valid reader, so the cap is the only thing that can drop one. The
      // stored html, the rows and the activity must all agree on who survived —
      // a span left in the html without a row would render a chip that never notified.
      it("caps a comment at 20 mentions; the rest become plain text", async () => {
        const crowd = await makeCrowd(25);
        const created = await say(ann, item.id, para(...crowd.map(chip)));

        expect(created.mentions).toHaveLength(20);
        const rows = await mentionedIds(created.id);
        expect(rows).toHaveLength(20);
        expect(sorted(created.mentions)).toEqual(rows);
        expect(await activityRows(item.id, "mentioned")).toHaveLength(20);

        const stored = (await storedComment(created.id)).commentHtml;
        expect(stored.match(/data-mention-id=/g)).toHaveLength(20);
        const kept = new Set(created.mentions);
        for (const p of crowd) {
          if (kept.has(p.id)) expect(stored).toContain(`data-mention-id="${p.id}"`);
          else {
            expect(stored).not.toContain(p.id);
            expect(stored).toContain(plain(p));
          }
        }
        // the author plus the 20 who were kept
        expect(Object.keys(await watcherReasons(item.id))).toHaveLength(21);
      });

      // Defends: the author being told about their own comment. A self-mention
      // must not queue a `mentioned` row (and so cannot notify the author), and
      // the author stays a COMMENTER watcher with exactly one watcher row.
      it("mentioning yourself writes no `mentioned` activity for you", async () => {
        const created = await say(ann, item.id, para("note to self", chip(ann), chip(ben)));
        expect(created.mentions).toContain(ben.id);
        expect((await activityRows(item.id, "mentioned")).map((r) => r.newValue)).toEqual([ben.id]);
        expect(await watcherReasons(item.id)).toEqual({ [ann.id]: "COMMENTER", [ben.id]: "MENTIONED" });
      });

      // Defends: auto-watch overwriting a reason somebody already has. The
      // reason is what they were doing when first subscribed, and it is kept.
      it("an existing watcher keeps their original reason", async () => {
        await watch(item, ann, "CREATOR");
        await watch(item, ben, "MANUAL");
        await watch(item, cara, "ASSIGNEE");
        const created = await say(ann, item.id, para(chip(ben), chip(cara), chip(dan)));
        expect(created.mentions).toHaveLength(3);
        expect(await watcherReasons(item.id)).toEqual({
          [ann.id]: "CREATOR",
          [ben.id]: "MANUAL",
          [cara.id]: "ASSIGNEE",
          [dan.id]: "MENTIONED",
        });
      });

      // Defends: an AI/system comment (no actor) inventing an author watcher,
      // or losing its mentions — they still watch and are still told.
      it("an AI comment has no author watcher, but its mentions still watch and queue", async () => {
        const created = await say(null, item.id, para(chip(ben)));
        expect(created.authorId).toBeNull();
        expect(await watcherReasons(item.id)).toEqual({ [ben.id]: "MENTIONED" });
        const commented = await activityRows(item.id, "commented");
        expect(commented.map((r) => r.actorId)).toEqual([null]);
        const mentioned = await activityRows(item.id, "mentioned");
        expect(mentioned.map((r) => ({ actorId: r.actorId, newValue: r.newValue }))).toEqual([
          { actorId: null, newValue: ben.id },
        ]);
      });

      // Defends: the activity contract — `commented` carries the comment id as
      // newValue; each `mentioned` carries comment id (old) and the person
      // (new); auto-watch writes NO watcher_added; nothing else is written.
      it("writes exactly `commented` + one `mentioned` per person, shaped per the contract", async () => {
        const created = await say(ann, item.id, para(chip(ben), chip(cara)));
        const key = (r: { verb: string; newValue: string | null }) => `${r.verb}/${r.newValue}`;
        const rows = (await activityRows(item.id))
          .map(({ verb, actorId, field, oldValue, newValue }) => ({ verb, actorId, field, oldValue, newValue }))
          .sort((a, b) => key(a).localeCompare(key(b)));
        const expected = [
          { verb: "commented", actorId: ann.id, field: "comment", oldValue: null, newValue: created.id },
          { verb: "mentioned", actorId: ann.id, field: "comment", oldValue: created.id, newValue: ben.id },
          { verb: "mentioned", actorId: ann.id, field: "comment", oldValue: created.id, newValue: cara.id },
        ].sort((a, b) => key(a).localeCompare(key(b)));
        expect(rows).toEqual(expected);
      });
    });

    // ── edit ─────────────────────────────────────────────────────────────────

    describe("editComment", () => {
      // Defends: the happy path — sanitized body stored, editedAt + updatedAt
      // moved, createdAt left alone (it is the comment's place in the thread),
      // exactly one `comment_edited` row naming the editor and the comment.
      it("lets the author rewrite the body and records it", async () => {
        const c = await say(ann, item.id, para("first"));
        await backdate(c.id);
        const before = (await activityRows(item.id)).length;

        const edited = await collab.editComment(prisma, actor(ann), c.id, para("second"));

        expect(edited).toMatchObject({ id: c.id, commentHtml: "<p>second</p>", deleted: false });
        expect(edited.editedAt).not.toBeNull();
        expect(Date.parse(edited.editedAt as string)).toBeGreaterThan(LONG_AGO.getTime());
        expect(Date.parse(edited.updatedAt)).toBeGreaterThan(LONG_AGO.getTime());

        const row = await storedComment(c.id);
        expect(row.commentHtml).toBe("<p>second</p>");
        expect(row.editedAt).not.toBeNull();
        expect(row.updatedAt.getTime()).toBeGreaterThan(LONG_AGO.getTime());
        expect(row.createdAt.getTime()).toBe(LONG_AGO.getTime());

        const rows = (await activityRows(item.id, "comment_edited")).map(
          ({ actorId, field, oldValue, newValue }) => ({ actorId, field, oldValue, newValue }),
        );
        expect(rows).toEqual([{ actorId: ann.id, field: "comment", oldValue: null, newValue: c.id }]);
        expect((await activityRows(item.id)).length).toBe(before + 1);
      });

      const strangers: Array<[string, () => Person]> = [
        ["an ordinary member", () => ben],
        ["an owner", () => owner],
        ["an admin", () => admin],
        ["a guest", () => guest],
      ];
      for (const [label, who] of strangers) {
        // Defends: editing as moderation. Owner/admin may DELETE another
        // person's comment but never put words in their mouth.
        it(`${label} cannot edit somebody else's comment`, async () => {
          const c = await say(ann, item.id, para("mine"));
          const before = (await activityRows(item.id)).length;
          await rejectsWith(collab.editComment(prisma, actor(who()), c.id, para("hijacked")), "comment_forbidden");
          const row = await storedComment(c.id);
          expect(row.commentHtml).toBe("<p>mine</p>");
          expect(row.editedAt).toBeNull();
          expect((await activityRows(item.id)).length).toBe(before);
        });
      }

      // Defends: `null === null` — an AI comment (authorId null) being
      // "authored by" a null actor, and so editable by the unauthenticated /
      // system path. AI comments are never editable, by anyone.
      it("an AI comment is never editable — not by an admin, not by a null actor", async () => {
        const ai = await say(null, item.id, para("generated"));
        await rejectsWith(collab.editComment(prisma, actor(admin), ai.id, para("x")), "comment_forbidden");
        await rejectsWith(collab.editComment(prisma, NO_ACTOR, ai.id, para("x")), "comment_forbidden");
        await rejectsWith(collab.editComment(prisma, { id: null, role: "admin" }, ai.id, para("x")), "comment_forbidden");
        expect((await storedComment(ai.id)).commentHtml).toBe("<p>generated</p>");
      });

      // Defends: a null actor editing a HUMAN comment.
      it("a null actor cannot edit a human comment", async () => {
        const c = await say(ann, item.id, para("mine"));
        await rejectsWith(collab.editComment(prisma, NO_ACTOR, c.id, para("x")), "comment_forbidden");
        expect((await storedComment(c.id)).commentHtml).toBe("<p>mine</p>");
      });

      // The contract fixes the ORDER of the checks. Each pair below defends one
      // link of it.
      // Defends: the not-found path.
      it("a missing comment is comment_not_found", async () => {
        await rejectsWith(collab.editComment(prisma, actor(ann), GHOST.id, para("x")), "comment_not_found");
      });

      // Defends: leaking that a comment was deleted to somebody who has no
      // business with it — forbidden is decided BEFORE deleted.
      it("a stranger editing a tombstone is told forbidden, not deleted", async () => {
        const dead = await say(ann, item.id, para("gone"));
        await collab.deleteComment(prisma, actor(ann), dead.id);
        await rejectsWith(collab.editComment(prisma, actor(ben), dead.id, para("x")), "comment_forbidden");
      });

      // Defends: the author hitting a tombstone being told so — deleted is
      // decided BEFORE empty, so an empty body cannot mask it.
      it("the author editing a tombstone is told comment_deleted, even with an empty body", async () => {
        const dead = await say(ann, item.id, para("gone"));
        await collab.deleteComment(prisma, actor(ann), dead.id);
        await rejectsWith(collab.editComment(prisma, actor(ann), dead.id, para("x")), "comment_deleted");
        await rejectsWith(collab.editComment(prisma, actor(ann), dead.id, ""), "comment_deleted");
      });

      // Defends: forbidden is decided BEFORE empty.
      it("a stranger sending an empty body to a live comment is forbidden, not 'empty'", async () => {
        const live = await say(ann, item.id, para("alive"));
        await rejectsWith(collab.editComment(prisma, actor(ben), live.id, ""), "comment_forbidden");
      });

      const empties: Array<[string, string]> = [
        ["an empty string", ""],
        ["only spaces", "   "],
        ["an empty paragraph", "<p></p>"],
        ["whitespace inside a paragraph", "<p>  \n </p>"],
        ["a lone line break", "<p><br></p>"],
        ["tags with no text in them", "<p><strong></strong></p>"],
        ["a script that sanitizes away entirely", "<script>alert(1)</script>"],
      ];
      for (const [label, html] of empties) {
        // Defends: wiping a comment to nothing through the edit path (delete is
        // the way to remove one), including bodies that only LOOK non-empty
        // until the sanitizer has run. The comment is untouched.
        it(`rejects a body that is empty after sanitizing: ${label}`, async () => {
          const c = await say(ann, item.id, para("keep me"));
          const before = (await activityRows(item.id)).length;
          await rejectsWith(collab.editComment(prisma, actor(ann), c.id, html), "empty_comment");
          const row = await storedComment(c.id);
          expect(row.commentHtml).toBe("<p>keep me</p>");
          expect(row.editedAt).toBeNull();
          expect((await activityRows(item.id)).length).toBe(before);
        });
      }

      // Defends: a "no change" save stamping "(edited)" and writing a
      // comment_edited row. The comparison is made AFTER sanitizing, so a body
      // that differs from the stored one only by markup the sanitizer drops is
      // still a no-op.
      it("an edit that sanitizes to the stored body is a no-op", async () => {
        const c = await say(ann, item.id, para("same"));
        await backdate(c.id);
        const before = (await activityRows(item.id)).map((r) => r.id);

        for (const html of ["<p>same</p>", `<p onclick="steal()">same</p>`]) {
          const out = await collab.editComment(prisma, actor(ann), c.id, html);
          expect(out).toMatchObject({ id: c.id, commentHtml: "<p>same</p>", editedAt: null });
        }

        const row = await storedComment(c.id);
        expect(row.editedAt).toBeNull();
        expect(row.updatedAt.getTime()).toBe(LONG_AGO.getTime());
        expect((await activityRows(item.id)).map((r) => r.id)).toEqual(before);
      });

      // Defends: the edit path being a way AROUND the stored-XSS boundary.
      it("sanitizes an edit exactly like a new comment", async () => {
        const c = await say(ann, item.id, para("clean"));
        const out = await collab.editComment(
          prisma,
          actor(ann),
          c.id,
          `<p>x</p><script>alert(1)</script><p onclick="steal()">y</p>`,
        );
        expect(out.commentHtml).toBe("<p>x</p><p>y</p>");
        expect((await storedComment(c.id)).commentHtml).toBe("<p>x</p><p>y</p>");
      });

      // Defends: the edit racing a delete, in its sequential form — text must
      // not come back onto a tombstone.
      it("an edit after a delete does not bring the text back", async () => {
        const c = await say(ann, item.id, para("secret"));
        await collab.deleteComment(prisma, actor(ann), c.id);
        await rejectsWith(collab.editComment(prisma, actor(ann), c.id, para("resurrected")), "comment_deleted");
        expect(await storedComment(c.id)).toMatchObject({ commentHtml: "", isDeleted: true, editedAt: null });
        expect(await activityRows(item.id, "comment_edited")).toEqual([]);
      });

      describe("mentions on edit", () => {
        // Defends: re-notifying people who were already mentioned. Only an ADDED
        // mention gets a new row, watcher and `mentioned` activity; cara's
        // original row is the only one she has.
        it("adds rows only for NEWLY mentioned people", async () => {
          const c = await say(ann, item.id, para("hi", chip(cara)));
          const out = await collab.editComment(prisma, actor(ann), c.id, para("hi", chip(cara), chip(ben)));

          const both = sorted([cara.id, ben.id]);
          expect(sorted(out.mentions)).toEqual(both);
          expect(await mentionedIds(c.id)).toEqual(both);
          const acts = await activityRows(item.id, "mentioned");
          expect(sorted(acts.map((a) => a.newValue ?? ""))).toEqual(both);
          expect(acts.find((a) => a.newValue === ben.id)).toMatchObject({
            actorId: ann.id,
            field: "comment",
            oldValue: c.id,
          });
          expect(await watcherReasons(item.id)).toEqual({
            [ann.id]: "COMMENTER",
            [cara.id]: "MENTIONED",
            [ben.id]: "MENTIONED",
          });
          expect(await activityRows(item.id, "comment_edited")).toHaveLength(1);
        });

        // Defends: a removed mention lingering as a row, so the person stays
        // "mentioned" in a comment that no longer mentions them.
        it("removes the mention row of a removed mention", async () => {
          const c = await say(ann, item.id, para(chip(cara), chip(ben)));
          const out = await collab.editComment(prisma, actor(ann), c.id, para(chip(ben)));
          expect(out.mentions).toEqual([ben.id]);
          expect(await mentionedIds(c.id)).toEqual([ben.id]);
        });

        // Defends: a removed mention still pinging the person later (the row is
        // still pending) — AND, the other way, rewriting history: a mention
        // that was already delivered stays `sent`.
        it("retracts a pending `mentioned` row of a removed mention, and leaves a SENT one alone", async () => {
          const c = await say(ann, item.id, para(chip(cara), chip(dan), chip(ben)));
          const notifiedAt = new Date("2026-02-01T00:00:00.000Z");
          const caraRow = await prisma.pmActivity.findFirstOrThrow({
            where: { workItemId: item.id, verb: "mentioned", newValue: cara.id },
          });
          await prisma.pmActivity.update({
            where: { id: caraRow.id },
            data: { notifyStatus: "sent", notifiedAt },
          });

          await collab.editComment(prisma, actor(ann), c.id, para(chip(ben))); // drops cara AND dan

          const by = Object.fromEntries(
            (await activityRows(item.id, "mentioned")).map((r) => [r.newValue as string, r]),
          );
          expect(by[cara.id]).toMatchObject({ notifyStatus: "sent" });
          expect(by[cara.id].notifiedAt?.getTime()).toBe(notifiedAt.getTime());
          expect(by[dan.id]).toMatchObject({ notifyStatus: "not_needed", notifiedAt: null });
          expect(by[ben.id]).toMatchObject({ notifyStatus: "pending" });
        });

        // Defends: the read rule being skipped on the edit path.
        it("applies the same read rule to a mention added by edit", async () => {
          const c = await say(ann, item.id, para("hi"));
          const out = await collab.editComment(
            prisma,
            actor(ann),
            c.id,
            para("hi", chip(ben), chip(deact), chip(guest), chip(svc), chip(GHOST)),
          );
          expect(out.mentions).toEqual([ben.id]);
          expect(out.commentHtml).toBe(para("hi", chip(ben), plain(deact), plain(guest), plain(svc), plain(GHOST)));
          expect(await mentionedIds(c.id)).toEqual([ben.id]);
          expect((await activityRows(item.id, "mentioned")).map((r) => r.newValue)).toEqual([ben.id]);
          expect(await watcherReasons(item.id)).toEqual({ [ann.id]: "COMMENTER", [ben.id]: "MENTIONED" });
        });

        // Defends: the author's own mention queueing a notification when added by edit.
        it("an edit that adds a mention of the author writes no `mentioned` row for them", async () => {
          const c = await say(ann, item.id, para("hi"));
          await collab.editComment(prisma, actor(ann), c.id, para("hi", chip(ann), chip(ben)));
          expect((await activityRows(item.id, "mentioned")).map((r) => r.newValue)).toEqual([ben.id]);
        });

        // Defends: a re-send of an unchanged body (mention spans included)
        // being treated as an edit, and so re-notifying.
        it("re-sending a body with its mention unchanged is a no-op", async () => {
          const c = await say(ann, item.id, para("hi", chip(ben)));
          const before = (await activityRows(item.id)).map((r) => r.id);
          const out = await collab.editComment(prisma, actor(ann), c.id, para("hi", chip(ben)));
          expect(out.editedAt).toBeNull();
          expect((await activityRows(item.id)).map((r) => r.id)).toEqual(before);
          expect(await mentionedIds(c.id)).toEqual([ben.id]);
        });
      });
    });

    // ── delete ───────────────────────────────────────────────────────────────

    describe("deleteComment", () => {
      it("removes ready and in-flight comment attachments while preserving item attachments", async () => {
        const c = await say(ann, item.id, para("with files"));
        const data = (status: "READY" | "UPLOADING", commentId: string | null) => ({
          workItemId: item.id, commentId, status, fileName: "note.txt", mimeType: "text/plain",
          sizeBytes: BigInt(4), sha256: "a".repeat(64), storageKey: randomUUID(), uploadedById: ann.id,
        });
        await prisma.pmAttachment.create({ data: data("READY", c.id) });
        await prisma.pmAttachment.create({ data: data("UPLOADING", c.id) });
        const keep = await prisma.pmAttachment.create({ data: data("READY", null) });
        await collab.deleteComment(prisma, actor(ann), c.id);
        expect(await prisma.pmAttachment.count({ where: { commentId: c.id } })).toBe(0);
        expect(await prisma.pmAttachment.findUnique({ where: { id: keep.id } })).not.toBeNull();
      });
      // Defends: the tombstone shape (flag, timestamp, deleter, empty body) in
      // both the API and the row, with the author and the place in the thread
      // preserved so the conversation does not collapse.
      it("turns the comment into a tombstone and keeps the thread's shape", async () => {
        const c = await say(ann, item.id, para("regret"));
        await backdate(c.id);

        const out = await collab.deleteComment(prisma, actor(ann), c.id);

        expect(out).toMatchObject({
          id: c.id,
          workItemId: item.id,
          authorId: ann.id,
          commentHtml: "",
          deleted: true,
          deletedById: ann.id,
          mentions: [],
          reactions: [],
        });
        expect(Date.parse(out.deletedAt as string)).toBeGreaterThan(LONG_AGO.getTime());
        const row = await storedComment(c.id);
        expect(row).toMatchObject({ commentHtml: "", isDeleted: true, deletedById: ann.id, authorId: ann.id });
        expect(row.deletedAt).not.toBeNull();
        expect(row.createdAt.getTime()).toBe(LONG_AGO.getTime());
      });

      const deleters: Array<[string, () => Person]> = [
        ["the author", () => ann],
        ["an owner", () => owner],
        ["an admin", () => admin],
      ];
      for (const [label, who] of deleters) {
        // Defends: the delete authority — author OR owner/admin — and that the
        // deleter, not the author, is what is recorded.
        it(`${label} can delete the comment, and is recorded as the deleter`, async () => {
          const c = await say(ann, item.id, para("x"));
          const out = await collab.deleteComment(prisma, actor(who()), c.id);
          expect(out).toMatchObject({ deleted: true, deletedById: who().id });
          expect(await storedComment(c.id)).toMatchObject({ isDeleted: true, deletedById: who().id });
        });
      }

      // Defends: delete authority leaking to ordinary members — including a
      // project LEAD, whose authority is over watchers, not over other people's words.
      it("an ordinary member, a project lead and a guest cannot delete somebody else's comment", async () => {
        await prisma.pmProject.update({ where: { id: project.id }, data: { leadId: lead.id } });
        const c = await say(ann, item.id, para("mine"));
        for (const who of [ben, lead, guest]) {
          await rejectsWith(collab.deleteComment(prisma, actor(who), c.id), "comment_forbidden");
        }
        expect(await storedComment(c.id)).toMatchObject({ isDeleted: false, commentHtml: "<p>mine</p>" });
        expect(await activityRows(item.id, "comment_deleted")).toEqual([]);
      });

      // Defends: AI comments having no moderator. Not editable by anyone, but
      // an owner/admin can still remove one.
      it("an admin can delete an AI comment; a null actor cannot delete anything", async () => {
        const ai = await say(null, item.id, para("generated"));
        const human = await say(ann, item.id, para("mine"));
        await rejectsWith(collab.deleteComment(prisma, NO_ACTOR, ai.id), "comment_forbidden");
        await rejectsWith(collab.deleteComment(prisma, NO_ACTOR, human.id), "comment_forbidden");
        const out = await collab.deleteComment(prisma, actor(admin), ai.id);
        expect(out).toMatchObject({ deleted: true, deletedById: admin.id, authorId: null });
      });

      // Defends: a missing comment staying a typed error.
      it("a missing comment is comment_not_found", async () => {
        await rejectsWith(collab.deleteComment(prisma, actor(ann), GHOST.id), "comment_not_found");
      });

      // Defends: reactions / mentions on a deleted comment surviving it (they
      // would still count, and still be addressed) — and the delete reaching
      // past its own comment.
      it("clears the comment's reactions and mentions, and nobody else's", async () => {
        const target = await say(ann, item.id, para("a", chip(ben)));
        const other = await say(ann, item.id, para("b", chip(cara)));
        await collab.addReaction(prisma, actor(ben), target.id, THUMBS_UP);
        await collab.addReaction(prisma, actor(ben), other.id, THUMBS_UP);

        await collab.deleteComment(prisma, actor(ann), target.id);

        expect(await reactionRows(target.id)).toEqual([]);
        expect(await mentionedIds(target.id)).toEqual([]);
        expect(await reactionRows(other.id)).toHaveLength(1);
        expect(await mentionedIds(other.id)).toEqual([cara.id]);
      });

      // Defends: the activity convention — oldValue carries the comment id,
      // newValue is null, actor is the DELETER.
      it("writes `comment_deleted` naming the deleter and the comment", async () => {
        const c = await say(ann, item.id, para("x"));
        await collab.deleteComment(prisma, actor(admin), c.id);
        const rows = (await activityRows(item.id, "comment_deleted")).map(
          ({ actorId, field, oldValue, newValue }) => ({ actorId, field, oldValue, newValue }),
        );
        expect(rows).toEqual([{ actorId: admin.id, field: "comment", oldValue: c.id, newValue: null }]);
      });

      // Defends: a deleted comment still notifying — its `commented` and
      // `mentioned` rows are retracted while pending. Not over-reaching: another
      // comment's pending rows, and a row that was already SENT, are left alone.
      it("retracts the comment's pending notifications, and only those", async () => {
        const doomed = await say(ann, item.id, para("a", chip(ben), chip(cara)));
        const survivor = await say(ann, item.id, para("b", chip(dan)));
        const caraRow = await prisma.pmActivity.findFirstOrThrow({
          where: { workItemId: item.id, verb: "mentioned", newValue: cara.id },
        });
        await prisma.pmActivity.update({
          where: { id: caraRow.id },
          data: { notifyStatus: "sent", notifiedAt: LONG_AGO },
        });

        await collab.deleteComment(prisma, actor(ann), doomed.id);

        const rows = await activityRows(item.id);
        const find = (verb: string, commentId: string, person?: string) =>
          rows.find(
            (r) =>
              r.verb === verb &&
              (verb === "commented" ? r.newValue === commentId : r.oldValue === commentId) &&
              (person === undefined || r.newValue === person),
          );
        expect(find("commented", doomed.id)?.notifyStatus).toBe("not_needed");
        expect(find("mentioned", doomed.id, ben.id)?.notifyStatus).toBe("not_needed");
        expect(find("mentioned", doomed.id, cara.id)?.notifyStatus).toBe("sent");
        expect(find("commented", survivor.id)?.notifyStatus).toBe("pending");
        expect(find("mentioned", survivor.id, dan.id)?.notifyStatus).toBe("pending");
      });

      // Defends: a double click / retried request writing a second
      // `comment_deleted` or re-stamping who deleted it and when. Another
      // person finishing the job later does not re-stamp it either.
      it("a second delete is a no-op that returns the same tombstone", async () => {
        const c = await say(ann, item.id, para("x"));
        const first = await collab.deleteComment(prisma, actor(ann), c.id);
        const after = (await activityRows(item.id)).map((r) => r.id);

        const again = await collab.deleteComment(prisma, actor(ann), c.id);
        const byAdmin = await collab.deleteComment(prisma, actor(admin), c.id);

        for (const out of [again, byAdmin]) {
          expect(out).toMatchObject({ deleted: true, deletedById: ann.id, deletedAt: first.deletedAt });
        }
        expect((await activityRows(item.id)).map((r) => r.id)).toEqual(after);
        expect(await activityRows(item.id, "comment_deleted")).toHaveLength(1);
      });

      // Defends: the work item's comment count including tombstones.
      it("work-item commentCount excludes deleted comments", async () => {
        const first = await say(ann, item.id, para("1"));
        await say(ben, item.id, para("2"));
        const third = await say(cara, item.id, para("3"));
        const countOf = async () => (await pm.getWorkItem(prisma, item.id)).commentCount;
        const listedCount = async () =>
          (await pm.listWorkItems(prisma, project.id)).items.find((i) => i.id === item.id)?.commentCount;

        expect(await countOf()).toBe(3);
        await collab.deleteComment(prisma, actor(ann), first.id);
        expect(await countOf()).toBe(2);
        expect(await listedCount()).toBe(2);
        await collab.deleteComment(prisma, actor(admin), third.id);
        expect(await countOf()).toBe(1);
        expect(await listedCount()).toBe(1);
      });
    });

    // ── list ─────────────────────────────────────────────────────────────────

    describe("listComments", () => {
      // Defends: the thread's order and shape — oldest first, tombstones kept
      // in place and blanked, live comments carrying their reaction summary
      // (allowlist order) and mentions.
      it("lists oldest first, tombstones included and blanked, live comments hydrated", async () => {
        const c1 = await seedComment(item.id, 1, { html: para("one") });
        const c2 = await seedComment(item.id, 2, { deleted: true, authorId: ben.id });
        const c3 = await seedComment(item.id, 3, { html: para("three", chip(cara)), authorId: cara.id });
        await prisma.pmCommentMention.create({ data: { commentId: c3.id, userId: cara.id } });
        await prisma.pmCommentReaction.createMany({
          data: [
            { commentId: c3.id, userId: ben.id, emoji: ROCKET },
            { commentId: c3.id, userId: dan.id, emoji: ROCKET },
            { commentId: c3.id, userId: ben.id, emoji: THUMBS_UP },
          ],
        });

        const listed = await pm.listComments(prisma, item.id);

        expect(listed.items.map((c) => c.id)).toEqual([c1.id, c2.id, c3.id]);
        expect(listed).toMatchObject({ total: 3, nextCursor: null });
        expect(listed.items[0]).toMatchObject({ commentHtml: para("one"), deleted: false, editedAt: null, reactions: [], mentions: [] });
        expect(listed.items[1]).toMatchObject({
          authorId: ben.id,
          commentHtml: "",
          deleted: true,
          deletedById: ann.id,
          mentions: [],
          reactions: [],
        });
        expect(listed.items[1].deletedAt).not.toBeNull();
        expect(listed.items[2].mentions).toEqual([cara.id]);
        expect(listed.items[2].reactions.map(({ emoji, count, userIds }) => ({ emoji, count, userIds: sorted(userIds) }))).toEqual([
          { emoji: THUMBS_UP, count: 1, userIds: [ben.id] },
          { emoji: ROCKET, count: 2, userIds: sorted([ben.id, dan.id]) },
        ]);
      });

      // Defends: a stray reaction/mention row on a tombstone (a write that
      // raced the delete, a non-service writer) leaking into the view.
      it("a tombstone is blank even if a stray reaction or mention row survived", async () => {
        const dead = await seedComment(item.id, 1, { deleted: true });
        await prisma.pmCommentReaction.create({ data: { commentId: dead.id, userId: ben.id, emoji: THUMBS_UP } });
        await prisma.pmCommentMention.create({ data: { commentId: dead.id, userId: cara.id } });
        const [listed] = (await pm.listComments(prisma, item.id)).items;
        expect(listed).toMatchObject({ deleted: true, commentHtml: "", mentions: [], reactions: [] });
      });

      // Defends: the unknown-item path.
      it("an unknown work item is work_item_not_found", async () => {
        await rejectsWith(pm.listComments(prisma, GHOST.id), "work_item_not_found");
      });

      // Defends: N+1 hydration. The statement count must not grow with the
      // number of comments (every comment here has a reaction AND a mention,
      // so no conditional query is skipped in the small run and issued in the large one).
      it("hydrates reactions and mentions in a fixed number of queries", async () => {
        const add = async (count: number, from: number) => {
          for (let i = 0; i < count; i += 1) {
            const c = await seedComment(item.id, from + i, { authorId: ann.id });
            await prisma.pmCommentReaction.create({ data: { commentId: c.id, userId: ben.id, emoji: THUMBS_UP } });
            await prisma.pmCommentMention.create({ data: { commentId: c.id, userId: cara.id } });
          }
        };
        await add(2, 1);
        const small = await countQueries(() => pm.listComments(prisma, item.id));
        await add(10, 10);
        const large = await countQueries(() => pm.listComments(prisma, item.id));
        expect(small).toBeGreaterThan(0);
        expect(large).toBe(small);
      });
    });

    // ── races ────────────────────────────────────────────────────────────────

    describe("races, forced with a parked transaction", () => {
      // Defends: an edit that read the comment BEFORE a delete committed
      // writing its text onto the tombstone afterwards. The delete is parked
      // inside its transaction holding the row lock; the real edit is started,
      // is seen waiting on that lock, and is only then let through. It must
      // lose — cleanly, as a 409-class refusal (comment_deleted, or
      // concurrent_mutation if the implementation serialises) — and the
      // tombstone must stay a tombstone (the CHECK would turn a naive write
      // into a constraint error, which is not an acceptable answer either).
      it("an edit that loses to a delete does not resurrect the text", async () => {
        const c = await say(ann, item.id, para("secret"));
        const winner = parkedTx(async (tx) => {
          await tx.$executeRaw`UPDATE "PmComment" SET "commentHtml" = '', "isDeleted" = true, "deletedAt" = now(), "deletedById" = ${admin.id} WHERE "id" = ${c.id}`;
        });
        await winner.parked;

        const edit = settle(collab.editComment(prisma, actor(ann), c.id, para("resurrected")));
        await waitingOnLock("PmComment");
        winner.release();
        await winner.done;
        const out = await edit;

        if (out.ok) throw new Error("the edit succeeded after the delete committed");
        expect(["comment_deleted", "concurrent_mutation"]).toContain(messageOf(out.error));
        expect(await storedComment(c.id)).toMatchObject({ commentHtml: "", isDeleted: true, editedAt: null });
        expect(await activityRows(item.id, "comment_edited")).toEqual([]);
      }, 30_000);

      // Defends: two concurrent deletes writing two `comment_deleted` rows (or
      // the loser reporting itself as the deleter). The loser must write
      // nothing and answer with the stored tombstone — or refuse as
      // concurrent_mutation if the implementation serialises.
      it("a delete that loses to another delete writes nothing and reports the stored tombstone", async () => {
        const c = await say(ann, item.id, para("x"));
        const winner = parkedTx(async (tx) => {
          await tx.pmComment.update({
            where: { id: c.id },
            data: { commentHtml: "", isDeleted: true, deletedAt: new Date(), deletedById: owner.id },
          });
          await tx.pmActivity.create({
            data: {
              workItemId: item.id,
              actorId: owner.id,
              verb: "comment_deleted",
              field: "comment",
              oldValue: c.id,
              notifyStatus: "not_needed",
            },
          });
        });
        await winner.parked;

        const loser = settle(collab.deleteComment(prisma, actor(ann), c.id));
        await waitingOnLock("PmComment");
        winner.release();
        await winner.done;
        const out = await loser;

        if (out.ok) {
          expect(out.value).toMatchObject({ deleted: true, commentHtml: "", deletedById: owner.id });
        } else {
          expect(messageOf(out.error)).toBe("concurrent_mutation");
        }
        // exactly the winner's row — the loser wrote none
        expect(await activityRows(item.id, "comment_deleted")).toHaveLength(1);
        expect(await storedComment(c.id)).toMatchObject({ isDeleted: true, deletedById: owner.id });
      }, 30_000);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // C. REACTIONS
  // ═════════════════════════════════════════════════════════════════════════

  describe("C. reactions", () => {
    let comment!: pm.ApiComment;

    beforeEach(async () => {
      comment = await say(ann, item.id, para("react to me"));
    });

    const react = (who: Person, emoji: string) => collab.addReaction(prisma, actor(who), comment.id, emoji);
    const unreact = (who: Person, emoji: string) => collab.removeReaction(prisma, actor(who), comment.id, emoji);
    const summary = (c: pm.ApiComment) =>
      c.reactions.map(({ emoji, count, userIds }) => ({ emoji, count, userIds: sorted(userIds) }));

    // Defends: the allowlist silently shrinking or the order drifting — every
    // allowlisted emoji is accepted (added in REVERSE so the order asserted is
    // the allowlist's, not insertion order) and reported in allowlist order.
    it("accepts every allowlisted emoji and reports them in allowlist order", async () => {
      for (const e of [...PM_REACTION_EMOJI].reverse()) {
        expect((await react(ben, e)).created).toBe(true);
      }
      expect(sorted((await reactionRows(comment.id)).map((r) => r.emoji))).toEqual(sorted(PM_REACTION_EMOJI));
      const [listed] = (await pm.listComments(prisma, item.id)).items;
      expect(listed.reactions.map((r) => r.emoji)).toEqual([...PM_REACTION_EMOJI]);
    });

    const refused: Array<[string, string]> = [
      ["an emoji outside the list", "\u{1F525}"],
      ["a near-miss face (grinning, not smiling-eyes)", "\u{1F600}"],
      ["a skin-tone variant of an allowed emoji", `${THUMBS_UP}\u{1F3FD}`],
      ["two allowed emoji glued together", `${THUMBS_UP}${THUMBS_DOWN}`],
      ["an allowed emoji followed by text", `${THUMBS_UP}x`],
      ["plain text", "thumbsup"],
      ["an empty string", ""],
      ["whitespace", "   "],
    ];
    for (const [label, emoji] of refused) {
      // Defends: the list being closed — a family of look-alikes, free text or
      // a free-for-all column would turn a reaction into an arbitrary string
      // stored per user per comment.
      it(`refuses ${label} with invalid_emoji and stores nothing`, async () => {
        await rejectsWith(react(ben, emoji), "invalid_emoji");
        await rejectsWith(unreact(ben, emoji), "invalid_emoji");
        expect(await reactionRows(comment.id)).toEqual([]);
      });
    }

    // Defends: the bare heart (several keyboards emit U+2764 without the
    // variation selector) being stored as a SECOND, never-matching string —
    // it is canonicalised on the way in, and either spelling addresses the
    // same reaction on add and remove.
    it("accepts the bare U+2764 heart and stores it canonically as U+2764 U+FE0F", async () => {
      const out = await react(ben, BARE_HEART);
      expect(out.created).toBe(true);
      expect(summary(out.comment)).toEqual([{ emoji: HEART, count: 1, userIds: [ben.id] }]);
      expect((await reactionRows(comment.id)).map((r) => r.emoji)).toEqual([HEART]);

      expect((await react(ben, HEART)).created).toBe(false);
      expect(await reactionRows(comment.id)).toHaveLength(1);

      await unreact(ben, BARE_HEART);
      expect(await reactionRows(comment.id)).toEqual([]);
    });

    // Defends: a repeated click being a count of two. Idempotent per
    // (comment, user, emoji): the second add reports created:false and the
    // summary still says one.
    it("adding the same reaction twice is idempotent", async () => {
      const first = await react(ben, THUMBS_UP);
      const second = await react(ben, THUMBS_UP);
      expect([first.created, second.created]).toEqual([true, false]);
      expect(summary(second.comment)).toEqual([{ emoji: THUMBS_UP, count: 1, userIds: [ben.id] }]);
      expect(await reactionRows(comment.id)).toHaveLength(1);
    });

    // Defends: reactions not being per person — two people on one emoji is
    // two, and taking yours back must not take theirs.
    it("reactions are per user: each person removes only their own", async () => {
      await react(ben, THUMBS_UP);
      await react(cara, THUMBS_UP);
      const out = await unreact(ben, THUMBS_UP);
      expect(summary(out)).toEqual([{ emoji: THUMBS_UP, count: 1, userIds: [cara.id] }]);
      expect(await reactionRows(comment.id)).toHaveLength(1);
    });

    // Defends: the summary contract — { emoji, count, userIds } per emoji, in
    // allowlist order whatever order they arrived in, and an emoji with no
    // reactions left is absent (count > 0 only), not present with 0.
    it("summarises as { emoji, count, userIds } in allowlist order, count > 0 only", async () => {
      await react(ben, ROCKET);
      await react(cara, THUMBS_UP);
      await react(ben, THUMBS_UP);
      await react(ann, PARTY);
      const last = await react(dan, BARE_HEART);

      expect(summary(last.comment)).toEqual([
        { emoji: THUMBS_UP, count: 2, userIds: sorted([ben.id, cara.id]) },
        { emoji: PARTY, count: 1, userIds: [ann.id] },
        { emoji: HEART, count: 1, userIds: [dan.id] },
        { emoji: ROCKET, count: 1, userIds: [ben.id] },
      ]);

      const afterRemoval = await unreact(ann, PARTY);
      expect(afterRemoval.reactions.map((r) => r.emoji)).toEqual([THUMBS_UP, HEART, ROCKET]);
    });

    // Defends: removal failing (or writing something) when there is nothing
    // to remove — a stale UI clicking "un-react" twice must be harmless.
    it("removing a reaction that is not there is a harmless no-op", async () => {
      await react(cara, THUMBS_UP);
      const out = await unreact(ben, THUMBS_UP);
      expect(summary(out)).toEqual([{ emoji: THUMBS_UP, count: 1, userIds: [cara.id] }]);
      expect(await reactionRows(comment.id)).toHaveLength(1);
      await unreact(ben, ROCKET);
      expect(await reactionRows(comment.id)).toHaveLength(1);
    });

    // Defends: a reaction becoming a timeline / notification event. There is
    // no verb for it, and the contract writes no activity for one.
    it("writes no activity row", async () => {
      const before = (await activityRows(item.id)).map((r) => r.id);
      await react(ben, THUMBS_UP);
      await react(ben, THUMBS_UP);
      await unreact(ben, THUMBS_UP);
      expect((await activityRows(item.id)).map((r) => r.id)).toEqual(before);
    });

    // Defends: a tombstone collecting reactions (or a stale client clearing
    // one) — both directions are refused with the same code as an edit.
    it("a deleted comment refuses both add and remove with comment_deleted", async () => {
      await collab.deleteComment(prisma, actor(ann), comment.id);
      await rejectsWith(react(ben, THUMBS_UP), "comment_deleted");
      await rejectsWith(unreact(ben, THUMBS_UP), "comment_deleted");
      expect(await reactionRows(comment.id)).toEqual([]);
    });

    // Defends: the unknown-comment path in both directions.
    it("an unknown comment is comment_not_found for add and remove", async () => {
      await rejectsWith(collab.addReaction(prisma, actor(ben), GHOST.id, THUMBS_UP), "comment_not_found");
      await rejectsWith(collab.removeReaction(prisma, actor(ben), GHOST.id, THUMBS_UP), "comment_not_found");
    });

    // Defends: an anonymous reaction row (userId has to be somebody) from a
    // system / unauthenticated path.
    it("a null actor is comment_forbidden for add and remove, and stores nothing", async () => {
      await rejectsWith(collab.addReaction(prisma, NO_ACTOR, comment.id, THUMBS_UP), "comment_forbidden");
      await rejectsWith(collab.removeReaction(prisma, NO_ACTOR, comment.id, THUMBS_UP), "comment_forbidden");
      expect(await reactionRows(comment.id)).toEqual([]);
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // D. WATCHERS
  // ═════════════════════════════════════════════════════════════════════════

  describe("D. watchers", () => {
    const watcherEvents = async (workItemId: string) =>
      (await activityRows(workItemId))
        .filter((r) => r.verb === "watcher_added" || r.verb === "watcher_removed")
        .map(({ verb, actorId, field, oldValue, newValue }) => ({ verb, actorId, field, oldValue, newValue }));
    const brief = (ws: Array<{ userId: string; reason: string }>) =>
      ws.map(({ userId, reason }) => ({ userId, reason }));

    describe("auto-watch when work is created", () => {
      // Defends: creating an item not subscribing its creator and assignees —
      // and auto-watch being narrated as `watcher_added` (it is not a manual
      // act; the assignment already has its own row).
      it("watches the creator (CREATOR) and every assignee (ASSIGNEE), with no watcher activity", async () => {
        const created = await pm.createWorkItem(prisma, ann.id, project.id, {
          name: `${PREFIX}auto`,
          assignees: [ben.id, cara.id],
        });
        expect(await watcherReasons(created.id)).toEqual({
          [ann.id]: "CREATOR",
          [ben.id]: "ASSIGNEE",
          [cara.id]: "ASSIGNEE",
        });
        expect(await verbsOf(created.id)).toEqual(["assigned", "assigned", "created"]);
      });

      // Defends: the unique key tripping (P2002) when the creator assigns
      // themself — one row, and the reason is the first thing they did.
      it("a creator who is also an assignee is ONE row, reason CREATOR", async () => {
        const created = await pm.createWorkItem(prisma, ann.id, project.id, {
          name: `${PREFIX}self-assigned`,
          assignees: [ann.id, ben.id],
        });
        expect(await watcherReasons(created.id)).toEqual({ [ann.id]: "CREATOR", [ben.id]: "ASSIGNEE" });
        expect(await prisma.pmWorkItemWatcher.count({ where: { workItemId: created.id } })).toBe(2);
      });

      // Defends: a system/MCP-created item (no actor) inventing a creator
      // watcher or failing on the null.
      it("with no actor there is no creator row, and assignees still watch", async () => {
        const created = await pm.createWorkItem(prisma, null, project.id, {
          name: `${PREFIX}system-made`,
          assignees: [ben.id],
        });
        expect(await watcherReasons(created.id)).toEqual({ [ben.id]: "ASSIGNEE" });
      });
    });

    describe("auto-watch when work is updated", () => {
      // Defends: an assignment added in a PATCH not subscribing the new
      // assignee, and an UNassignment dropping the row (being taken off an item
      // does not mean you stopped caring about it). Neither writes watcher activity.
      it("a newly added assignee watches as ASSIGNEE, and unassigning keeps the row", async () => {
        const created = await pm.createWorkItem(prisma, ann.id, project.id, {
          name: `${PREFIX}update`,
          assignees: [ben.id],
        });
        await pm.updateWorkItem(prisma, ann.id, created.id, { assignees: [ben.id, cara.id] });
        const expected = { [ann.id]: "CREATOR", [ben.id]: "ASSIGNEE", [cara.id]: "ASSIGNEE" };
        expect(await watcherReasons(created.id)).toEqual(expected);

        await pm.updateWorkItem(prisma, ann.id, created.id, { assignees: [cara.id] }); // ben is taken off
        expect(await watcherReasons(created.id)).toEqual(expected);
        expect(await watcherEvents(created.id)).toEqual([]);
      });

      // Defends: assignment overwriting the reason of somebody already watching.
      it("a person who already watches keeps their reason when they are assigned", async () => {
        const created = await pm.createWorkItem(prisma, ann.id, project.id, { name: `${PREFIX}keep-reason` });
        await prisma.pmWorkItemWatcher.create({
          data: { workItemId: created.id, userId: dan.id, reason: "MANUAL" },
        });
        await pm.updateWorkItem(prisma, ann.id, created.id, { assignees: [dan.id] });
        expect(await watcherReasons(created.id)).toEqual({ [ann.id]: "CREATOR", [dan.id]: "MANUAL" });
      });
    });

    describe("listWatchers", () => {
      const T1 = new Date("2026-02-01T00:00:00.000Z");
      const T2 = new Date("2026-02-02T00:00:00.000Z");
      const T3 = new Date("2026-02-03T00:00:00.000Z");
      const T4 = new Date("2026-02-04T00:00:00.000Z");

      // Defends: the watch list reading only the table. Assignees ALWAYS watch,
      // including ones assigned before the table existed (no row): they are
      // derived (reason ASSIGNEE, the assignee row's createdAt). A person who
      // is both gets ONE entry and the explicit row wins; the order is by
      // createdAt across derived and explicit entries alike.
      it("unions explicit rows with assignees that have none: one entry per user, oldest first", async () => {
        const t = await rawItem({ name: "union" });
        await prisma.pmWorkItemAssignee.createMany({
          data: [
            { workItemId: t.id, userId: ben.id, createdAt: T1 },
            { workItemId: t.id, userId: cara.id, createdAt: T2 },
          ],
        });
        await watch(t, dan, "COMMENTER", T3);
        await watch(t, cara, "MANUAL", T4);

        const out = await collab.listWatchers(prisma, t.id);

        expect(out.map(({ userId, reason, createdAt }) => ({ userId, reason, createdAt }))).toEqual([
          { userId: ben.id, reason: "ASSIGNEE", createdAt: T1.toISOString() },
          { userId: dan.id, reason: "COMMENTER", createdAt: T3.toISOString() },
          { userId: cara.id, reason: "MANUAL", createdAt: T4.toISOString() },
        ]);
      });

      // Defends: a derived entry persisting after the assignment ends.
      it("a derived assignee entry disappears when they are unassigned", async () => {
        const t = await rawItem({ name: "derived", assignees: [ben] });
        expect(brief(await collab.listWatchers(prisma, t.id))).toEqual([{ userId: ben.id, reason: "ASSIGNEE" }]);
        await prisma.pmWorkItemAssignee.deleteMany({ where: { workItemId: t.id } });
        expect(await collab.listWatchers(prisma, t.id)).toEqual([]);
      });

      // Defends: the unknown-item path (HTTP: 404 work_item_not_found).
      it("an unknown work item is work_item_not_found", async () => {
        await rejectsWith(collab.listWatchers(prisma, GHOST.id), "work_item_not_found");
      });
    });

    describe("addWatcher", () => {
      // Defends: the watch button — a MANUAL row for yourself, narrated once as
      // `watcher_added` (actor = who did it, newValue = who is now watching).
      it("watching yourself creates a MANUAL row and writes watcher_added", async () => {
        const out = await collab.addWatcher(prisma, actor(ben), item.id);
        expect(out.created).toBe(true);
        expect(brief(out.watchers)).toEqual([{ userId: ben.id, reason: "MANUAL" }]);
        expect(await watcherReasons(item.id)).toEqual({ [ben.id]: "MANUAL" });
        expect(await watcherEvents(item.id)).toEqual([
          { verb: "watcher_added", actorId: ben.id, field: "watchers", oldValue: null, newValue: ben.id },
        ]);
      });

      // Defends: a second click writing a second row of activity.
      it("watching twice is created:false and writes nothing the second time", async () => {
        await collab.addWatcher(prisma, actor(ben), item.id);
        const again = await collab.addWatcher(prisma, actor(ben), item.id);
        expect(again.created).toBe(false);
        expect(brief(again.watchers)).toEqual([{ userId: ben.id, reason: "MANUAL" }]);
        expect(await watcherEvents(item.id)).toHaveLength(1);
      });

      // Defends: "already watching" being decided on the REASON — an assignee
      // is already watching (their row exists), keeps ASSIGNEE, and narrates nothing.
      it("an assignee who already has an automatic row is created:false, reason unchanged", async () => {
        const created = await pm.createWorkItem(prisma, ann.id, project.id, {
          name: `${PREFIX}assignee-watch`,
          assignees: [ben.id],
        });
        const out = await collab.addWatcher(prisma, actor(ben), created.id);
        expect(out.created).toBe(false);
        expect(await watcherReasons(created.id)).toEqual({ [ann.id]: "CREATOR", [ben.id]: "ASSIGNEE" });
        expect(await watcherEvents(created.id)).toEqual([]);
      });

      describe("watching somebody else", () => {
        const authorities: Array<[string, () => Person]> = [
          ["an owner", () => owner],
          ["an admin", () => admin],
        ];
        for (const [label, who] of authorities) {
          // Defends: the role authority — owner/admin manage anybody's watch list.
          it(`${label} can add another reader, and the activity names who did it`, async () => {
            const out = await collab.addWatcher(prisma, actor(who()), item.id, ben.id);
            expect(out.created).toBe(true);
            expect(await watcherReasons(item.id)).toEqual({ [ben.id]: "MANUAL" });
            expect(await watcherEvents(item.id)).toEqual([
              { verb: "watcher_added", actorId: who().id, field: "watchers", oldValue: null, newValue: ben.id },
            ]);
          });
        }

        // Defends: the lead authority — a project's lead (PmProject.leadId)
        // manages the watch list of its items, without being owner/admin.
        it("the project's lead can", async () => {
          await prisma.pmProject.update({ where: { id: project.id }, data: { leadId: lead.id } });
          const out = await collab.addWatcher(prisma, actor(lead), item.id, ben.id);
          expect(out.created).toBe(true);
          expect(await watcherReasons(item.id)).toEqual({ [ben.id]: "MANUAL" });
        });

        // Defends: authority leaking to ordinary members.
        it("an ordinary member cannot: watch_forbidden, and nothing is written", async () => {
          await rejectsWith(collab.addWatcher(prisma, actor(cara), item.id, ben.id), "watch_forbidden");
          expect(await watcherReasons(item.id)).toEqual({});
          expect(await watcherEvents(item.id)).toEqual([]);
        });

        // Defends: "lead" being read as "lead of ANY project" — it is THIS
        // item's project's lead.
        it("the lead of ANOTHER project cannot", async () => {
          await prisma.pmProject.create({
            data: { workspaceId, name: `${PREFIX}bravo`, identifier: "W19B", leadId: lead.id },
          });
          await rejectsWith(collab.addWatcher(prisma, actor(lead), item.id, ben.id), "watch_forbidden");
          expect(await watcherReasons(item.id)).toEqual({});
        });

        // Defends: a missing identity or role counting as authority.
        it("a null actor, or an actor with no role, cannot manage anybody", async () => {
          await rejectsWith(collab.addWatcher(prisma, NO_ACTOR, item.id), "watch_forbidden");
          await rejectsWith(collab.addWatcher(prisma, NO_ACTOR, item.id, ben.id), "watch_forbidden");
          await rejectsWith(
            collab.addWatcher(prisma, { id: ann.id, role: undefined }, item.id, ben.id),
            "watch_forbidden",
          );
          expect(await watcherReasons(item.id)).toEqual({});
        });

        const cannotRead: Array<[string, () => { id: string }]> = [
          ["a deactivated user", () => deact],
          ["a service-role user", () => svc],
          ["a guest who is not assigned to the item", () => guest],
          ["an id that belongs to nobody", () => GHOST],
        ];
        for (const [label, who] of cannotRead) {
          // Defends: subscribing somebody to an item they may not see — which
          // would leak its activity to them through notifications.
          it(`refuses ${label} as a target: user_cannot_read_item`, async () => {
            await rejectsWith(
              collab.addWatcher(prisma, actor(owner), item.id, who().id),
              "user_cannot_read_item",
            );
            expect(await watcherReasons(item.id)).toEqual({});
            expect(await watcherEvents(item.id)).toEqual([]);
          });
        }

        // Defends: the guest carve-out working one way only — a guest ASSIGNED
        // to the item can read it, so they can be watched.
        it("accepts a guest who IS assigned to the item", async () => {
          const guestItem = await rawItem({ name: "guest-item", assignees: [guestAssigned] });
          const out = await collab.addWatcher(prisma, actor(owner), guestItem.id, guestAssigned.id);
          expect(out.watchers.map((w) => w.userId)).toContain(guestAssigned.id);
        });
      });

      // Defends: the unknown-item path.
      it("an unknown work item is work_item_not_found", async () => {
        await rejectsWith(collab.addWatcher(prisma, actor(ben), GHOST.id), "work_item_not_found");
      });
    });

    describe("removeWatcher", () => {
      // Defends: the unwatch button — the row goes, and `watcher_removed`
      // carries who stopped watching (old) with no new value.
      it("stopping watching deletes the row and writes watcher_removed", async () => {
        await watch(item, ben, "MANUAL");
        const out = await collab.removeWatcher(prisma, actor(ben), item.id);
        expect(out.watchers).toEqual([]);
        expect(await watcherReasons(item.id)).toEqual({});
        expect(await watcherEvents(item.id)).toEqual([
          { verb: "watcher_removed", actorId: ben.id, field: "watchers", oldValue: ben.id, newValue: null },
        ]);
      });

      // Defends: narrating a removal that removed nothing.
      it("stopping when you were not watching writes nothing", async () => {
        await watch(item, cara, "MANUAL");
        const out = await collab.removeWatcher(prisma, actor(ben), item.id);
        expect(brief(out.watchers)).toEqual([{ userId: cara.id, reason: "MANUAL" }]);
        expect(await watcherEvents(item.id)).toEqual([]);
      });

      describe("removing somebody else", () => {
        const authorities: Array<[string, () => Person]> = [
          ["an owner", () => owner],
          ["an admin", () => admin],
        ];
        for (const [label, who] of authorities) {
          // Defends: the same authority rule as adding.
          it(`${label} can`, async () => {
            await watch(item, ben, "MANUAL");
            await collab.removeWatcher(prisma, actor(who()), item.id, ben.id);
            expect(await watcherReasons(item.id)).toEqual({});
            expect(await watcherEvents(item.id)).toEqual([
              { verb: "watcher_removed", actorId: who().id, field: "watchers", oldValue: ben.id, newValue: null },
            ]);
          });
        }

        it("the project's lead can", async () => {
          await prisma.pmProject.update({ where: { id: project.id }, data: { leadId: lead.id } });
          await watch(item, ben, "MANUAL");
          await collab.removeWatcher(prisma, actor(lead), item.id, ben.id);
          expect(await watcherReasons(item.id)).toEqual({});
        });

        it("an ordinary member cannot: watch_forbidden, and the row stays", async () => {
          await watch(item, ben, "MANUAL");
          await rejectsWith(collab.removeWatcher(prisma, actor(cara), item.id, ben.id), "watch_forbidden");
          expect(await watcherReasons(item.id)).toEqual({ [ben.id]: "MANUAL" });
          expect(await watcherEvents(item.id)).toEqual([]);
        });

        it("a null actor cannot remove anybody", async () => {
          await watch(item, ben, "MANUAL");
          await rejectsWith(collab.removeWatcher(prisma, NO_ACTOR, item.id), "watch_forbidden");
          await rejectsWith(collab.removeWatcher(prisma, NO_ACTOR, item.id, ben.id), "watch_forbidden");
          expect(await watcherReasons(item.id)).toEqual({ [ben.id]: "MANUAL" });
        });

        // Defends: a deactivated person's watcher row being un-removable — a
        // manager cleaning up after a leaver must not be refused for the
        // target no longer being able to read the item (the contract lists no
        // 422 for DELETE).
        it("does not require the target to still be a reader", async () => {
          await watch(item, deact, "MENTIONED");
          const out = await collab.removeWatcher(prisma, actor(admin), item.id, deact.id);
          expect(out.watchers).toEqual([]);
          expect(await watcherEvents(item.id)).toEqual([
            { verb: "watcher_removed", actorId: admin.id, field: "watchers", oldValue: deact.id, newValue: null },
          ]);
        });
      });

      // Defends: "assignees always watch" — un-watching an item you are
      // assigned to would be undone by the very next notification decision, so
      // it is refused quietly: list unchanged, row kept, nothing narrated. An
      // admin removing them is the same no-op.
      it("is a no-op for a current assignee", async () => {
        const created = await pm.createWorkItem(prisma, ann.id, project.id, {
          name: `${PREFIX}assigned`,
          assignees: [ben.id],
        });
        const before = await collab.listWatchers(prisma, created.id);

        const self = await collab.removeWatcher(prisma, actor(ben), created.id);
        const byAdmin = await collab.removeWatcher(prisma, actor(admin), created.id, ben.id);

        expect(self.watchers).toEqual(before);
        expect(byAdmin.watchers).toEqual(before);
        expect(await watcherReasons(created.id)).toMatchObject({ [ben.id]: "ASSIGNEE" });
        expect(await watcherEvents(created.id)).toEqual([]);
      });

      // Defends: the no-op rule only covering assignees that have a row — an
      // assignee assigned before the table existed has none, and is still watching.
      it("is a no-op for a legacy assignee who has no row at all", async () => {
        const t = await rawItem({ name: "legacy", assignees: [ben] });
        const out = await collab.removeWatcher(prisma, actor(ben), t.id);
        expect(out.watchers.map((w) => w.userId)).toEqual([ben.id]);
        expect(await watcherEvents(t.id)).toEqual([]);
      });

      // Defends: the leftover row of a former assignee being stuck for ever —
      // once they are no longer assigned they are an ordinary watcher and can leave.
      it("once unassigned, the person can stop watching", async () => {
        const created = await pm.createWorkItem(prisma, ann.id, project.id, {
          name: `${PREFIX}unassigned`,
          assignees: [ben.id],
        });
        await pm.updateWorkItem(prisma, ann.id, created.id, { assignees: [] });
        expect(await watcherReasons(created.id)).toMatchObject({ [ben.id]: "ASSIGNEE" });

        const out = await collab.removeWatcher(prisma, actor(ben), created.id);

        expect(out.watchers.map((w) => w.userId)).toEqual([ann.id]);
        expect(await watcherReasons(created.id)).toEqual({ [ann.id]: "CREATOR" });
        expect(await watcherEvents(created.id)).toEqual([
          { verb: "watcher_removed", actorId: ben.id, field: "watchers", oldValue: ben.id, newValue: null },
        ]);
      });

      // Defends: the unknown-item path.
      it("an unknown work item is work_item_not_found", async () => {
        await rejectsWith(collab.removeWatcher(prisma, actor(ben), GHOST.id), "work_item_not_found");
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // E. TIMELINE
  // ═════════════════════════════════════════════════════════════════════════

  describe("E. timeline", () => {
    type Timeline = Awaited<ReturnType<typeof collab.getTimeline>>;
    type Entry = Timeline["timeline"][number];

    const asComment = (e: Entry) => {
      if (e.type !== "comment") throw new Error(`expected a comment entry, got ${e.type} ${e.id}`);
      return e.comment;
    };
    const asActivity = (e: Entry) => {
      if (e.type !== "activity") throw new Error(`expected an activity entry, got ${e.type} ${e.id}`);
      return e.activity;
    };

    /** Walks `nextCursor` to the end; never trusts it to terminate. */
    async function walk(limit: number, itemId = item.id): Promise<Timeline[]> {
      const pages: Timeline[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 60; i += 1) {
        const page: Timeline = await collab.getTimeline(prisma, itemId, { limit, cursor });
        pages.push(page);
        if (page.nextCursor === null) return pages;
        cursor = page.nextCursor;
      }
      throw new Error(`the cursor never ran out at limit ${limit}`);
    }

    const everything = (itemId = item.id) => collab.getTimeline(prisma, itemId, { limit: 500 });

    // Defends: the merge itself — comments (a tombstone among them) and
    // activity interleaved in ONE list, ascending, "newest last"; a comment
    // sorts by when it was WRITTEN (an edit months later does not move it);
    // the two mirrored verbs never show; and each entry carries its own shape.
    it("merges comments and activity, oldest first, tombstones included", async () => {
      const a0 = await seedActivity(item.id, 0, "created");
      const c1 = await seedComment(item.id, 1, { html: para("first") });
      const a2 = await seedActivity(item.id, 2, "state_changed", {
        field: "state",
        oldValue: todo.id,
        newValue: doing.id,
      });
      const c3 = await seedComment(item.id, 3, { deleted: true, authorId: ben.id });
      const a4 = await seedActivity(item.id, 4, "assigned", { field: "assignees", newValue: ben.id });
      // edited long after everything else — must still sit at its creation time
      await prisma.pmComment.update({ where: { id: c1.id }, data: { editedAt: tAt(900), updatedAt: tAt(900) } });
      // the mirrored rows: the comment entry already says it
      await seedActivity(item.id, 1, "commented", { field: "comment", newValue: c1.id });
      await seedActivity(item.id, 5, "mentioned", { field: "comment", oldValue: c1.id, newValue: cara.id });

      const out = await everything();

      expect(out.timeline.map((e) => `${e.type}:${e.id}`)).toEqual([
        `activity:${a0.id}`,
        `comment:${c1.id}`,
        `activity:${a2.id}`,
        `comment:${c3.id}`,
        `activity:${a4.id}`,
      ]);
      expect(out.timeline.map((e) => e.at)).toEqual([0, 1, 2, 3, 4].map((n) => tAt(n).toISOString()));

      expect(asActivity(out.timeline[2])).toMatchObject({
        id: a2.id,
        workItemId: item.id,
        actorId: ann.id,
        verb: "state_changed",
        field: "state",
        oldValue: todo.id,
        newValue: doing.id,
        createdAt: tAt(2).toISOString(),
      });
      expect(asComment(out.timeline[1])).toMatchObject({
        id: c1.id,
        authorId: ann.id,
        commentHtml: para("first"),
        deleted: false,
        editedAt: tAt(900).toISOString(),
      });
      expect(asComment(out.timeline[3])).toMatchObject({
        id: c3.id,
        authorId: ben.id,
        commentHtml: "",
        deleted: true,
        mentions: [],
        reactions: [],
      });
    });

    // Defends: the stated tie rule — a comment before an activity row at the
    // same instant. The activity row is inserted FIRST so insertion order
    // cannot explain a pass.
    it("at the same instant a comment sorts before an activity row", async () => {
      const a = await seedActivity(item.id, 7, "priority_changed", { field: "priority", oldValue: "low", newValue: "high" });
      const c = await seedComment(item.id, 7);
      const out = await everything();
      expect(out.timeline.map((e) => e.id)).toEqual([c.id, a.id]);
    });

    // Defends: "the timeline renders every verb". One row of EVERY verb the
    // database knows is written directly; every one except the two mirrored
    // verbs must come back, in order. A verb added to the enum later is
    // covered the moment it exists, with no edit here — and the null
    // field / oldValue / newValue these rows carry must not break ref
    // resolution for the verbs that resolve refs.
    it("lists every verb except `commented` and `mentioned`", async () => {
      const rows = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
        SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'PmActivityVerb' ORDER BY e.enumsortorder`;
      const verbs = rows.map((r) => r.enumlabel as $Enums.PmActivityVerb);
      expect(sorted([...PM_TIMELINE_MIRRORED_VERBS])).toEqual(["commented", "mentioned"]);
      for (const [i, verb] of verbs.entries()) await seedActivity(item.id, i, verb);

      const out = await everything();

      const mirrored = new Set<string>(PM_TIMELINE_MIRRORED_VERBS);
      expect(out.timeline.map((e) => asActivity(e).verb)).toEqual(verbs.filter((v) => !mirrored.has(v)));
      expect(out.total).toBe(verbs.length - mirrored.size);
    });

    // Defends: a malformed, empty, null or dangling reference in a history row
    // taking the whole page down. Old rows exist in shapes nobody planned for.
    it("never breaks on null, malformed or dangling ref values", async () => {
      await seedActivity(item.id, 1, "state_changed", { field: "state", oldValue: null, newValue: "not-a-state" });
      await seedActivity(item.id, 2, "label_added", { field: "labels", newValue: "not-a-label" });
      await seedActivity(item.id, 3, "label_removed", { field: "labels", oldValue: GHOST.id });
      await seedActivity(item.id, 4, "relation_added", { field: "relation", newValue: "nonsense" });
      await seedActivity(item.id, 5, "relation_removed", { field: "relation", oldValue: `BLOCKS:${GHOST.id}` });
      await seedActivity(item.id, 6, "relation_added", { field: "relation", newValue: "BLOCKS:" });
      await seedActivity(item.id, 7, "parent_removed", { field: "parentId", oldValue: GHOST.id });

      const out = await everything();

      expect(out.timeline).toHaveLength(7);
      expect(out.refs).toEqual({ states: {}, labels: {}, workItems: {} });
    });

    // Defends: `total` being the PAGE size, or counting the omitted rows. It is
    // the item's whole timeline (comments incl. tombstones + shown activity),
    // whatever the page.
    it("`total` is exact and does not depend on the page", async () => {
      await seedComment(item.id, 1);
      await seedComment(item.id, 2, { deleted: true });
      await seedComment(item.id, 3);
      await seedActivity(item.id, 4, "created");
      await seedActivity(item.id, 5, "priority_changed");
      await seedActivity(item.id, 6, "commented", { field: "comment" });
      await seedActivity(item.id, 7, "mentioned", { field: "comment" });

      expect((await everything()).total).toBe(5);
      const page = await collab.getTimeline(prisma, item.id, { limit: 2 });
      expect(page.timeline).toHaveLength(2);
      expect(page.total).toBe(5);
    });

    // Defends: an item with nothing to resolve still returning the three maps.
    it("is empty-but-well-shaped for an item with no history", async () => {
      expect(await everything()).toEqual({
        timeline: [],
        refs: { states: {}, labels: {}, workItems: {} },
        nextCursor: null,
        total: 0,
      });
    });

    // Defends: an unknown item reaching the queries.
    it("an unknown work item is work_item_not_found", async () => {
      await rejectsWith(collab.getTimeline(prisma, GHOST.id), "work_item_not_found");
    });

    describe("pagination", () => {
      // Defends: forward paging — the first page holds the OLDEST entries, the
      // cursor walks toward the newest, and the pages add up to the unpaged
      // result exactly (no entry twice, none skipped), with nextCursor null
      // only on the last page.
      it("limit 2 over 7 entries walks forward to the end and adds up to the unpaged list", async () => {
        const ids: string[] = [];
        for (let n = 0; n < 7; n += 1) {
          const row = n % 2 === 0 ? await seedActivity(item.id, n, "priority_changed") : await seedComment(item.id, n);
          ids.push(row.id);
        }
        // mirrored rows must not take part in the paging either
        await seedActivity(item.id, 3, "commented", { field: "comment" });
        await seedActivity(item.id, 6, "mentioned", { field: "comment" });

        const unpaged = await everything();
        expect(unpaged.timeline.map((e) => e.id)).toEqual(ids);

        const pages = await walk(2);
        expect(pages.map((p) => p.timeline.length)).toEqual([2, 2, 2, 1]);
        expect(pages.map((p) => p.nextCursor === null)).toEqual([false, false, false, true]);
        const walked = pages.flatMap((p) => p.timeline.map((e) => e.id));
        expect(walked).toEqual(ids);
        expect(new Set(walked).size).toBe(walked.length);
        for (const p of pages) expect(p.total).toBe(7);
      });

      // Defends: a page that ends exactly at the end offering another, empty page.
      it("a limit that exactly fits the remainder ends with nextCursor null — no empty trailing page", async () => {
        for (let n = 0; n < 6; n += 1) await seedActivity(item.id, n, "priority_changed");
        const pages = await walk(3);
        expect(pages.map((p) => p.timeline.length)).toEqual([3, 3]);
        expect(pages.map((p) => p.nextCursor === null)).toEqual([false, true]);
      });

      // Defends: the classic keyset bug — a cursor that is only a timestamp
      // skips or repeats rows that share it. One transaction writes several
      // activity rows in the same millisecond, so ties are the normal case.
      // One instant here holds a comment and three activity rows, and limits
      // 1..5 cut through it at every position.
      it("survives rows that share a timestamp across a page boundary", async () => {
        await seedActivity(item.id, 0, "created");
        await seedActivity(item.id, 1, "assigned", { field: "assignees", newValue: ben.id });
        await seedActivity(item.id, 1, "unassigned", { field: "assignees", oldValue: cara.id });
        await seedComment(item.id, 1);
        await seedActivity(item.id, 1, "priority_changed", { field: "priority", oldValue: "low", newValue: "high" });
        await seedActivity(item.id, 2, "archived");

        const unpaged = (await everything()).timeline.map((e) => e.id);
        expect(unpaged).toHaveLength(6);
        expect(new Set(unpaged).size).toBe(6);

        for (const limit of [1, 2, 3, 4, 5]) {
          const walked = (await walk(limit)).flatMap((p) => p.timeline.map((e) => e.id));
          expect(walked, `limit ${limit}`).toEqual(unpaged);
        }
      });

      // Defends: `limit` being trusted — it is clamped to 1..500, defaults to
      // 100, and a clamped page still reports the truth (`total`, a cursor
      // that reaches the three entries left).
      it("clamps limit to 1..500 and defaults to 100", async () => {
        await prisma.pmActivity.createMany({
          data: Array.from({ length: 503 }, (_, i) => ({
            workItemId: item.id,
            actorId: ann.id,
            verb: "priority_changed" as const,
            field: "priority",
            oldValue: "low",
            newValue: "high",
            createdAt: tAt(i),
            notifyStatus: "not_needed" as const,
          })),
        });
        const size = async (limit?: number) =>
          (await collab.getTimeline(prisma, item.id, limit === undefined ? undefined : { limit })).timeline.length;

        expect(await size()).toBe(100);
        expect(await size(0)).toBe(1);
        expect(await size(-5)).toBe(1);
        expect(await size(500)).toBe(500);
        expect(await size(501)).toBe(500);
        expect(await size(9999)).toBe(500);

        const big = await collab.getTimeline(prisma, item.id, { limit: 9999 });
        expect(big.total).toBe(503);
        expect(big.nextCursor).not.toBeNull();
        const rest = await collab.getTimeline(prisma, item.id, { limit: 9999, cursor: big.nextCursor });
        expect(rest.timeline).toHaveLength(3);
        expect(rest.nextCursor).toBeNull();
      }, 30_000);
    });

    describe("invalid cursors", () => {
      beforeEach(async () => {
        await seedActivity(item.id, 1, "created");
        await seedComment(item.id, 2);
        await seedActivity(item.id, 3, "priority_changed");
      });

      const b64 = (s: string) => Buffer.from(s).toString("base64url");
      const bad: Array<[string, string]> = [
        ["something that is not base64url", "!!!not a cursor!!!"],
        ["base64url of text that is not JSON", b64("not json at all")],
        ["well-formed JSON of the wrong shape", b64(JSON.stringify({ nope: 1 }))],
        ["a JSON null", b64("null")],
        ["a JSON array", b64("[]")],
        ["a JSON number", b64("12345")],
      ];
      for (const [label, cursor] of bad) {
        // Defends: an undecodable cursor reaching a query as a raw error (a
        // 500) instead of the typed refusal the route maps to 400.
        it(`rejects ${label} with invalid_cursor`, async () => {
          await rejectsWith(collab.getTimeline(prisma, item.id, { cursor }), "invalid_cursor");
        });
      }

      // Defends: a cursor that is a real one, truncated in transit.
      it("rejects a real cursor that was cut short", async () => {
        const first = await collab.getTimeline(prisma, item.id, { limit: 1 });
        expect(first.nextCursor).not.toBeNull();
        const cut = (first.nextCursor as string).slice(0, -6);
        await rejectsWith(collab.getTimeline(prisma, item.id, { cursor: cut }), "invalid_cursor");
      });
    });

    describe("refs", () => {
      // Defends: state_changed rows carrying bare ids the client cannot show.
      // Old AND new resolve; an unknown id is left out; a null side is not a
      // key; and — only the rows on THIS page are resolved.
      it("states: resolves state_changed ids to names, omits unknown ones, only for this page", async () => {
        await seedActivity(item.id, 1, "state_changed", { field: "state", oldValue: null, newValue: todo.id });
        await seedActivity(item.id, 2, "state_changed", { field: "state", oldValue: todo.id, newValue: doing.id });
        await seedActivity(item.id, 3, "state_changed", { field: "state", oldValue: doing.id, newValue: GHOST.id });

        const all = await everything();
        expect(all.refs.states).toEqual({ [todo.id]: todo.name, [doing.id]: doing.name });

        const first = await collab.getTimeline(prisma, item.id, { limit: 1 });
        expect(first.refs.states).toEqual({ [todo.id]: todo.name });
      });

      // Defends: label_added / label_removed rows rendering as bare ids.
      it("labels: resolves label_added and label_removed ids to { name, color }", async () => {
        const bug = await prisma.pmLabel.create({
          data: { projectId: project.id, name: `${PREFIX}bug`, color: "#ff0000" },
        });
        const chore = await prisma.pmLabel.create({ data: { projectId: project.id, name: `${PREFIX}chore` } });
        await seedActivity(item.id, 1, "label_added", { field: "labels", newValue: bug.id });
        await seedActivity(item.id, 2, "label_removed", { field: "labels", oldValue: chore.id });
        await seedActivity(item.id, 3, "label_added", { field: "labels", newValue: GHOST.id });

        const out = await everything();

        expect(out.refs.labels).toEqual({
          [bug.id]: { name: bug.name, color: "#ff0000" },
          [chore.id]: { name: chore.name, color: null },
        });
      });

      // Defends: relation_* ("KIND:<id>") and parent_removed rows rendering as
      // bare ids — including a relation to an item in ANOTHER project, whose
      // key carries that project's identifier. An id that no longer resolves
      // (the other end was deleted) is left out.
      it("workItems: resolves relation_* and parent_removed ids to { key, name }, across projects too", async () => {
        const bravo = await prisma.pmProject.create({
          data: { workspaceId, name: `${PREFIX}bravo`, identifier: "W19B" },
        });
        const blocker = await rawItem({ name: "blocker" });
        const abroad = await rawItem({ name: "abroad", project: { id: bravo.id, identifier: bravo.identifier } });
        const parent = await rawItem({ name: "parent" });
        await seedActivity(item.id, 1, "relation_added", { field: "relation", newValue: `BLOCKS:${blocker.id}` });
        await seedActivity(item.id, 2, "relation_removed", { field: "relation", oldValue: `RELATES:${abroad.id}` });
        await seedActivity(item.id, 3, "parent_removed", { field: "parentId", oldValue: parent.id });
        await seedActivity(item.id, 4, "relation_added", { field: "relation", newValue: `DUPLICATES:${GHOST.id}` });

        const out = await everything();

        expect(out.refs.workItems).toEqual({
          [blocker.id]: { key: blocker.key, name: blocker.name },
          [abroad.id]: { key: abroad.key, name: abroad.name },
          [parent.id]: { key: parent.key, name: parent.name },
        });
      });
    });

    describe("comment entries", () => {
      // Defends: the timeline's comments being a thinner shape than the
      // comment list's — they are hydrated the same way (reactions in
      // allowlist order, mentions), and a tombstone is blank.
      it("are hydrated with reactions and mentions, and tombstones are blank", async () => {
        const live = await seedComment(item.id, 1, { html: para("hi", chip(cara)) });
        const dead = await seedComment(item.id, 2, { deleted: true });
        await prisma.pmCommentMention.create({ data: { commentId: live.id, userId: cara.id } });
        await prisma.pmCommentReaction.createMany({
          data: [
            { commentId: live.id, userId: ben.id, emoji: ROCKET },
            { commentId: live.id, userId: dan.id, emoji: THUMBS_UP },
            { commentId: live.id, userId: cara.id, emoji: THUMBS_UP },
            // stray rows on a tombstone must not show
            { commentId: dead.id, userId: ben.id, emoji: PARTY },
          ],
        });
        await prisma.pmCommentMention.create({ data: { commentId: dead.id, userId: ben.id } });

        const out = await everything();
        const [liveEntry, deadEntry] = out.timeline.map(asComment);

        expect(liveEntry.mentions).toEqual([cara.id]);
        expect(
          liveEntry.reactions.map(({ emoji, count, userIds }) => ({ emoji, count, userIds: sorted(userIds) })),
        ).toEqual([
          { emoji: THUMBS_UP, count: 2, userIds: sorted([dan.id, cara.id]) },
          { emoji: ROCKET, count: 1, userIds: [ben.id] },
        ]);
        expect(deadEntry).toMatchObject({ deleted: true, commentHtml: "", mentions: [], reactions: [] });
      });

      // Defends: N+1 hydration in the timeline path (the comment list has its
      // own check). Same rule: the statement count is independent of the number
      // of comments, with a reaction and a mention on every one.
      it("are hydrated in a fixed number of queries", async () => {
        const add = async (count: number, from: number) => {
          for (let i = 0; i < count; i += 1) {
            const c = await seedComment(item.id, from + i);
            await prisma.pmCommentReaction.create({ data: { commentId: c.id, userId: ben.id, emoji: THUMBS_UP } });
            await prisma.pmCommentMention.create({ data: { commentId: c.id, userId: cara.id } });
          }
        };
        await add(2, 1);
        const small = await countQueries(() => collab.getTimeline(prisma, item.id));
        await add(10, 10);
        const large = await countQueries(() => collab.getTimeline(prisma, item.id));
        expect(small).toBeGreaterThan(0);
        expect(large).toBe(small);
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // F. NOTIFICATIONS — through the REAL activity-notify sweep
  // ═════════════════════════════════════════════════════════════════════════

  describe("F. notifications through the real sweep", () => {
    const mentionedYou = () => `${ann.displayName} mentioned you`;

    // Defends: the headline rules in one scenario. Ben, mentioned, hears ONCE
    // and as a mention — NOT a second time as "New comment" (the item-wide
    // fan-out skips whoever the comment mentions); the assignee and the plain
    // watcher hear about the comment; the author hears nothing; and a mention
    // is never fanned out — nobody else is told Ben was mentioned. Both
    // queue rows are consumed.
    it("a mention tells Ben once, as a mention; the others hear about the comment; the author hears nothing", async () => {
      const thing = await rawItem({ name: "leak", assignees: [cara] });
      await watch(thing, dan);
      await say(ann, thing.id, para("ping", chip(ben)));

      await sweep();

      expect(await inbox()).toEqual({
        [ben.username]: [mentionedYou()],
        [cara.username]: ["New comment"],
        [dan.username]: ["New comment"],
      });
      const body = `${thing.key} — ${thing.name}`;
      expect(await lines(ben)).toEqual([{ kind: "event", title: mentionedYou(), body }]);
      expect(await lines(cara)).toEqual([{ kind: "event", title: "New comment", body }]);
      expect(await claimStates(thing.id)).toEqual(["commented:sent", "mentioned:sent"]);
    });

    // Defends: the exclusion applying only to plain watchers — an ASSIGNEE who
    // is mentioned is also skipped by the "New comment" fan-out, so they get
    // exactly the mention (not a two-row digest).
    it("an assignee who is mentioned gets exactly one notification: the mention", async () => {
      const thing = await rawItem({ assignees: [ben, cara] });
      await say(ann, thing.id, para(chip(ben)));
      await sweep();
      expect(await inbox()).toEqual({
        [ben.username]: [mentionedYou()],
        [cara.username]: ["New comment"],
      });
    });

    // Defends: assignees and watchers being unioned without de-duplication —
    // somebody on both lists was told twice.
    it("a watcher who is also an assignee is told once", async () => {
      const thing = await rawItem({ assignees: [cara] });
      await watch(thing, cara, "ASSIGNEE");
      await say(ann, thing.id, para("hello"));
      await sweep();
      expect(await inbox()).toEqual({ [cara.username]: ["New comment"] });
    });

    // Defends: the department resolver and the watcher table not being
    // de-duplicated against each other.
    it("a person who is both a watcher and a department watcher is told once", async () => {
      const thing = await rawItem();
      await watch(thing, dan);
      await say(ann, thing.id, para("hello"));
      await sweep({ departmentWatchers: async () => new Map([[thing.id, [dan.id, ben.id]]]) });
      expect(await inbox()).toEqual({ [dan.username]: ["New comment"], [ben.username]: ["New comment"] });
    });

    // Defends: the eligibility filter on WATCHER rows. A guest who watches but
    // is not assigned, a deactivated person and a service principal are never
    // told — an item's activity must not reach somebody who cannot open it, or
    // somebody who cannot log in. A guest who IS assigned is an assignee, and
    // assignees are told unconditionally.
    it("drops watchers who are an unassigned guest, deactivated, or a service — keeps the rest", async () => {
      const thing = await rawItem({ assignees: [guestAssigned] });
      for (const who of [ben, guest, deact, svc, guestAssigned]) await watch(thing, who);
      await say(ann, thing.id, para("hello"));
      await sweep();
      expect(await inbox()).toEqual({
        [ben.username]: ["New comment"],
        [guestAssigned.username]: ["New comment"],
      });
    });

    // Defends: the same filter on DEPARTMENT watchers (WARP-3365 already had it
    // for guests; deactivated and service are new).
    it("applies the same eligibility to department watchers", async () => {
      const thing = await rawItem({ assignees: [guestAssigned] });
      await say(ann, thing.id, para("hello"));
      await sweep({
        departmentWatchers: async () => new Map([[thing.id, [ben.id, guest.id, deact.id, svc.id]]]),
      });
      expect(await inbox()).toEqual({
        [ben.username]: ["New comment"],
        [guestAssigned.username]: ["New comment"],
      });
    });

    // Defends: the guest rule on a MENTION target, end to end — an assigned
    // guest is mentionable and told; an unassigned one never got as far as a row.
    it("a guest assigned to the item is told of a mention; an unassigned one never was", async () => {
      const thing = await rawItem({ assignees: [guestAssigned] });
      await say(ann, thing.id, para(chip(guestAssigned), chip(guest)));
      await sweep();
      expect(await inbox()).toEqual({ [guestAssigned.username]: [mentionedYou()] });
    });

    // Defends: state changes reaching only assignees — watchers get them now,
    // once each, and the person who made the change never does even when they
    // are one of the watchers.
    it("a state change tells assignees and watchers once each — never the actor", async () => {
      const thing = await rawItem({ assignees: [cara], stateId: todo.id });
      await watch(thing, dan);
      await watch(thing, ann, "CREATOR");
      await pm.updateWorkItem(prisma, ann.id, thing.id, { stateId: doing.id });
      await sweep();
      expect(await inbox()).toEqual({
        [cara.username]: [`Moved to ${doing.name}`],
        [dan.username]: [`Moved to ${doing.name}`],
      });
    });

    // Defends: the copy. An assignee is told "Assigned to you"; a watcher who
    // is not the assignee is told the assignment CHANGED — telling them it was
    // assigned to THEM would be wrong.
    it("an assignment tells the new assignee 'Assigned to you' and a plain watcher 'Assignment changed'", async () => {
      const thing = await rawItem({ stateId: todo.id });
      await watch(thing, dan);
      await pm.updateWorkItem(prisma, ann.id, thing.id, { assignees: [ben.id] });
      await sweep();
      expect(await inbox()).toEqual({
        [ben.username]: ["Assigned to you"],
        [dan.username]: ["Assignment changed"],
      });
    });

    // Defends: an edit re-notifying everybody who was already told. Only the
    // person the edit ADDED hears, as a mention; `comment_edited` itself is not
    // a notifiable verb.
    it("a mention added by EDIT notifies only the newly mentioned person", async () => {
      const thing = await rawItem({ assignees: [cara] });
      await watch(thing, dan);
      const c = await say(ann, thing.id, para(chip(ben)));
      await sweep();
      const afterFirst = await inbox();
      expect(afterFirst).toEqual({
        [ben.username]: [mentionedYou()],
        [cara.username]: ["New comment"],
        [dan.username]: ["New comment"],
      });

      await collab.editComment(prisma, actor(ann), c.id, para(chip(ben), chip(eve)));
      await sweep();

      expect(await inbox()).toEqual({ ...afterFirst, [eve.username]: [mentionedYou()] });
    });

    // Defends: a comment that was deleted before anybody was told about it
    // still notifying — the rows are retracted at delete time, so the sweep
    // finds nothing to send and nothing left pending.
    it("deleting a comment before the sweep sends nothing for it", async () => {
      const thing = await rawItem({ assignees: [cara] });
      await watch(thing, dan);
      const c = await say(ann, thing.id, para(chip(ben)));
      await collab.deleteComment(prisma, actor(ann), c.id);

      await sweep();

      expect(await inbox()).toEqual({});
      expect(await claimStates(thing.id)).toEqual([
        "comment_deleted:not_needed",
        "commented:not_needed",
        "mentioned:not_needed",
      ]);
    });

    // Defends: exactly-once. The claim is a real `UPDATE ... WHERE
    // "notifyStatus" = 'pending'`; the second sweep matches nothing.
    it("a second sweep sends nothing", async () => {
      const thing = await rawItem({ assignees: [cara] });
      await watch(thing, dan);
      await say(ann, thing.id, para(chip(ben)));

      await sweep();
      const first = await inbox();
      expect(Object.keys(first)).toHaveLength(3);
      await sweep();

      expect(await inbox()).toEqual(first);
    });

    // Defends: a notification losing its place — a person with several rows in
    // one sweep gets ONE digest (the unchanged coalescing), and `mentioned`
    // is one of its words.
    it("several rows for one person in one sweep are one digest that names the mention", async () => {
      const thing = await rawItem({ assignees: [ben], stateId: todo.id });
      await say(ann, thing.id, para(chip(ben)));
      await pm.updateWorkItem(prisma, ann.id, thing.id, { stateId: doing.id });

      await sweep();

      expect(await inbox()).toEqual({ [ben.username]: ["2 updates on your work"] });
      const [only] = await lines(ben);
      expect(only.body).toContain("1 mentioned");
      expect(only.body).toContain("1 moved");
    });

    // Defends: the copy when there is no actor to name (an AI-authored comment).
    it("a mention with no actor reads 'You were mentioned'", async () => {
      const thing = await rawItem();
      await say(null, thing.id, para(chip(ben)));
      await sweep();
      expect(await inbox()).toEqual({ [ben.username]: ["You were mentioned"] });
    });

    // Defends: rows written BEFORE this feature. A `commented` row has no
    // comment id (newValue null) — it must still notify assignees and watchers
    // normally, and the mention lookup must not choke on it.
    it("a legacy `commented` row with no comment id still notifies assignees and watchers", async () => {
      const thing = await rawItem({ assignees: [cara] });
      await watch(thing, dan);
      await prisma.pmActivity.create({
        data: { workItemId: thing.id, actorId: ann.id, verb: "commented", createdAt: LONG_AGO },
      });
      await sweep();
      expect(await inbox()).toEqual({ [cara.username]: ["New comment"], [dan.username]: ["New comment"] });
    });

    describe("a row nobody can be told about ends not_needed — never left pending", () => {
      // Defends: the explicit terminal for "considered and correctly declined".
      it("a comment on an item nobody else is on", async () => {
        const thing = await rawItem();
        await say(ann, thing.id, para("talking to myself"));
        await sweep();
        expect(await inbox()).toEqual({});
        expect(await claimStates(thing.id)).toEqual(["commented:not_needed"]);
      });

      // Defends: a candidate whose every recipient is filtered out being left
      // pending (and rescanned every minute for ever).
      it("a comment whose only watchers are ineligible", async () => {
        const thing = await rawItem();
        for (const who of [deact, guest, svc]) await watch(thing, who);
        await say(ann, thing.id, para("hello"));
        await sweep();
        expect(await inbox()).toEqual({});
        expect(await claimStates(thing.id)).toEqual(["commented:not_needed"]);
      });

      // Defends: eligibility being decided at WRITE time only. Somebody mentioned
      // while active and deactivated before the sweep is not told.
      it("a mention whose target was deactivated after the comment was written", async () => {
        const leaver = await prisma.user.create({
          data: { username: `${PREFIX}leaver`, displayName: "Lou Leaver", role: "family" },
        });
        const thing = await rawItem();
        await say(ann, thing.id, para(chip({ id: leaver.id, displayName: leaver.displayName })));
        await prisma.user.update({ where: { id: leaver.id }, data: { directoryStatus: "DEACTIVATED" } });

        await sweep();

        expect(await inbox()).toEqual({});
        expect(await claimStates(thing.id)).toEqual(["commented:not_needed", "mentioned:not_needed"]);
      });

      // Defends: a `mentioned` row that names nobody deliverable — an unknown
      // user, an empty target, or the actor themself — fanning out to the
      // item's other people instead of going quiet. Cara is an assignee and
      // must hear nothing: a mention goes to its target and no one else.
      it("a `mentioned` row whose target is unknown, empty, or the actor — and it is never fanned out", async () => {
        const thing = await rawItem({ assignees: [cara] });
        await prisma.pmActivity.createMany({
          data: [
            { workItemId: thing.id, actorId: ann.id, verb: "mentioned", field: "comment", oldValue: "c1", newValue: GHOST.id },
            { workItemId: thing.id, actorId: ann.id, verb: "mentioned", field: "comment", oldValue: "c2", newValue: null },
            { workItemId: thing.id, actorId: ben.id, verb: "mentioned", field: "comment", oldValue: "c3", newValue: ben.id },
          ],
        });
        await sweep();
        expect(await inbox()).toEqual({});
        expect(await claimStates(thing.id)).toEqual([
          "mentioned:not_needed",
          "mentioned:not_needed",
          "mentioned:not_needed",
        ]);
      });
    });
  });

  // ═════════════════════════════════════════════════════════════════════════
  // G. WORK-ITEM ACTIVITY WRITERS (contract §1 table)
  // ═════════════════════════════════════════════════════════════════════════

  describe("G. work-item activity writers", () => {
    /** Every activity row of an item except the `created` one, in the contract's columns. */
    const changes = async (workItemId: string) =>
      (await activityRows(workItemId))
        .filter((r) => r.verb !== "created")
        .map(({ verb, actorId, field, oldValue, newValue }) => ({ verb, actorId, field, oldValue, newValue }));

    const fresh = (over: Partial<Parameters<typeof pm.createWorkItem>[3]> = {}) =>
      pm.createWorkItem(prisma, ann.id, project.id, { name: `${PREFIX}g-item`, priority: "low", ...over });

    // Defends: a priority change hiding inside the generic `updated` bucket
    // (the old shape was `updated` / `priority`).
    it("a priority change is `priority_changed` with old and new — not `updated`", async () => {
      const w = await fresh();
      await pm.updateWorkItem(prisma, ben.id, w.id, { priority: "high" });
      expect(await changes(w.id)).toEqual([
        { verb: "priority_changed", actorId: ben.id, field: "priority", oldValue: "low", newValue: "high" },
      ]);
    });

    // Defends: a rename hiding inside the generic `updated`/`fields` row.
    it("a rename is `title_changed` with the old and new name", async () => {
      const w = await fresh();
      await pm.updateWorkItem(prisma, ben.id, w.id, { name: `${PREFIX}g-renamed` });
      expect(await changes(w.id)).toEqual([
        { verb: "title_changed", actorId: ben.id, field: "name", oldValue: `${PREFIX}g-item`, newValue: `${PREFIX}g-renamed` },
      ]);
    });

    // Defends: a description change logging the (large, possibly sensitive)
    // body into the activity table — it records THAT it changed, with null values.
    it("a description change is `description_changed` with null values", async () => {
      const w = await fresh();
      await pm.updateWorkItem(prisma, ben.id, w.id, { descriptionHtml: "<p>now it says something</p>" });
      expect(await changes(w.id)).toEqual([
        { verb: "description_changed", actorId: ben.id, field: "description", oldValue: null, newValue: null },
      ]);
    });

    // Defends: label churn collapsing into one opaque row. One row PER label:
    // added carries the id as newValue, removed as oldValue; a label that stays
    // writes nothing.
    it("labels write one `label_added` / `label_removed` row per label", async () => {
      const [l1, l2, l3] = await Promise.all(
        ["one", "two", "three"].map((n) =>
          prisma.pmLabel.create({ data: { projectId: project.id, name: `${PREFIX}g-${n}` } }),
        ),
      );
      const w = await fresh();

      await pm.updateWorkItem(prisma, ben.id, w.id, { labelIds: [l1.id, l2.id] });
      expect(sorted((await changes(w.id)).map((r) => `${r.verb}/${r.oldValue}/${r.newValue}`))).toEqual(
        sorted([`label_added/null/${l1.id}`, `label_added/null/${l2.id}`]),
      );

      await pm.updateWorkItem(prisma, ben.id, w.id, { labelIds: [l2.id, l3.id] });
      const later = (await changes(w.id)).slice(2);
      expect(sorted(later.map((r) => `${r.verb}/${r.field}/${r.oldValue}/${r.newValue}`))).toEqual(
        sorted([`label_removed/labels/${l1.id}/null`, `label_added/labels/null/${l3.id}`]),
      );
    });

    // Defends: the start date being the only thing left under `updated`, with
    // ISO strings for old and new.
    it("a start-date change is `updated` / `startDate` with ISO old and new", async () => {
      const w = await fresh();
      const first = new Date("2026-05-01T00:00:00.000Z");
      const second = new Date("2026-05-09T00:00:00.000Z");
      await pm.updateWorkItem(prisma, ben.id, w.id, { startDate: first });
      await pm.updateWorkItem(prisma, ben.id, w.id, { startDate: second });
      expect(await changes(w.id)).toEqual([
        { verb: "updated", actorId: ben.id, field: "startDate", oldValue: null, newValue: first.toISOString() },
        { verb: "updated", actorId: ben.id, field: "startDate", oldValue: first.toISOString(), newValue: second.toISOString() },
      ]);
    });

    // Defends: the old residual rows coming back alongside the new ones —
    // `updated`/`fields` and `updated`/`priority` are GONE, so one PATCH that
    // changes five things writes five specific rows and no catch-all.
    it("one PATCH writes one specific row per change and no residual `updated` rows", async () => {
      const label = await prisma.pmLabel.create({ data: { projectId: project.id, name: `${PREFIX}g-combo` } });
      const w = await fresh();
      await pm.updateWorkItem(prisma, ben.id, w.id, {
        name: `${PREFIX}g-combo-renamed`,
        priority: "urgent",
        descriptionHtml: "<p>changed</p>",
        labelIds: [label.id],
        startDate: new Date("2026-06-01T00:00:00.000Z"),
      });

      const rows = await changes(w.id);
      expect(sorted(rows.map((r) => `${r.verb}/${r.field}`))).toEqual(
        sorted([
          "title_changed/name",
          "priority_changed/priority",
          "description_changed/description",
          "label_added/labels",
          "updated/startDate",
        ]),
      );
      expect(rows.some((r) => r.verb === "updated" && (r.field === "fields" || r.field === "priority"))).toBe(false);
    });

    // Defends: an identity PATCH (the dashboard re-sends the whole item on every
    // save) writing rows for changes that are not changes.
    it("re-sending the same values writes nothing", async () => {
      const label = await prisma.pmLabel.create({ data: { projectId: project.id, name: `${PREFIX}g-same` } });
      const w = await fresh({ labelIds: [label.id] });
      const afterCreate = await changes(w.id);
      await pm.updateWorkItem(prisma, ben.id, w.id, {
        name: `${PREFIX}g-item`,
        priority: "low",
        labelIds: [label.id],
      });
      expect(await changes(w.id)).toEqual(afterCreate);
    });
  });

  describe("service-desk boundary", () => {
    it("hides service-desk items and comments from collaboration APIs and relation refs", async () => {
      const desk = await prisma.pmProject.create({
        data: {
          workspaceId,
          name: `${PREFIX}desk`,
          identifier: "W19D",
          kind: "SERVICE_DESK",
        },
      });
      const ticket = await rawItem({ name: "ticket", project: { id: desk.id, identifier: desk.identifier } });
      const ticketComment = await prisma.pmComment.create({
        data: { workItemId: ticket.id, authorId: ann.id, commentHtml: para("private ticket text") },
      });

      await rejectsWith(collab.getTimeline(prisma, ticket.id), "work_item_not_found");
      await rejectsWith(collab.listWatchers(prisma, ticket.id), "work_item_not_found");
      await rejectsWith(collab.addWatcher(prisma, actor(ann), ticket.id), "work_item_not_found");
      await rejectsWith(collab.removeWatcher(prisma, actor(ann), ticket.id), "work_item_not_found");
      await rejectsWith(collab.editComment(prisma, actor(ann), ticketComment.id, para("edited")), "comment_not_found");
      await rejectsWith(collab.deleteComment(prisma, actor(ann), ticketComment.id), "comment_not_found");
      await rejectsWith(collab.addReaction(prisma, actor(ann), ticketComment.id, THUMBS_UP), "comment_not_found");
      await rejectsWith(collab.removeReaction(prisma, actor(ann), ticketComment.id, THUMBS_UP), "comment_not_found");

      await seedActivity(item.id, 999, "relation_added", {
        field: "relation",
        newValue: `RELATES:${ticket.id}`,
      });
      const timeline = await collab.getTimeline(prisma, item.id, { limit: 500 });
      expect(timeline.refs.workItems).not.toHaveProperty(ticket.id);
      expect(JSON.stringify(timeline)).not.toContain(ticket.id);
    });
  });
});
