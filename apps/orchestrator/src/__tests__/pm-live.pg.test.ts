/**
 * WARP-3536 — the privacy rule of live updates, against a real database.
 *
 * "A user who cannot read an item receives no event for it." The unit suites
 * (pm-live-audience.test.ts, pm-live.test.ts) prove the logic with stand-ins; what
 * only Postgres can prove is that the rule holds over the REAL rows it reads:
 * `User.role` and `directoryStatus`, the Projects workspace switch, and
 * `PmWorkItemAssignee`. Then the same audience is driven
 * through the real outbox framework, so the cursor, the settle window and the
 * `(createdAt, id)` read are the ones production runs.
 *
 * Fixtures are namespaced `warp3536-` and every cleanup is scoped to them: the
 * pg-gated suites share one throwaway database.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { deleteWorkItem } from "../services/pm/pm.service.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

/**
 * Every module the registry makes available in this process, so the workspace
 * module check does not drop Projects for want of config.
 */
const CFG = {
  AI_GATEWAY_URL: "http://ai-gateway:8000",
  FILE_INDEXER_URL: "http://file-indexer:8000",
  NEXTCLOUD_URL: "http://nextcloud",
  DOCS_ENABLED: "1",
  DOCS_INTERNAL_URL: "http://docserver",
  SERVICE_TOKEN_EMAIL: "x",
  SERVICE_TOKEN_VOICE: "x",
  FRIGATE_URL: "http://frigate:5000",
  DROPLET_MATTER_SERVICE_URL: "http://matter",
  ROUTING_SERVICE_URL: "http://routing",
  SWITCH_SERVICE_URL: "http://switch",
};

describe.skipIf(!RUN)("pm-live — who hears about a change, over real rows (WARP-3536)", () => {
  let prisma: PrismaClient;
  let createPmLiveAudience: typeof import("../services/pm/pm-live-audience.js").createPmLiveAudience;
  let createPmLiveConsumer: typeof import("../services/pm/pm-live.js").createPmLiveConsumer;
  let runOutboxSweep: typeof import("../services/pm/pm-outbox.js").runOutboxSweep;
  let outboxFlagKey: typeof import("../services/pm/pm-outbox.js").outboxFlagKey;

  const OURS = { startsWith: "warp3536-" } as const;

  /** Projects was off until this suite switched it on; put it back as found. */
  let moduleBefore: { enabled: boolean } | null = null;

  const ids: Record<string, string> = {};
  let projectId = "";
  let sharedItem = "";
  let plainItem = "";
  let otherProjectItem = "";

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();

    ({ createPmLiveAudience } = await import("../services/pm/pm-live-audience.js"));
    ({ createPmLiveConsumer } = await import("../services/pm/pm-live.js"));
    ({ runOutboxSweep, outboxFlagKey } = await import("../services/pm/pm-outbox.js"));
    moduleBefore = await prisma.moduleSetting.findUnique({ where: { moduleId: "projects" }, select: { enabled: true } });
    await prisma.moduleSetting.upsert({
      where: { moduleId: "projects" },
      create: { moduleId: "projects", enabled: true },
      update: { enabled: true },
    });
  });

  afterAll(async () => {
    await cleanup();
    if (moduleBefore === null) await prisma.moduleSetting.deleteMany({ where: { moduleId: "projects" } });
    else await prisma.moduleSetting.update({ where: { moduleId: "projects" }, data: { enabled: moduleBefore.enabled } });
    await prisma.$disconnect();
  });

  async function cleanup(): Promise<void> {
    await prisma.systemFlag.deleteMany({ where: { key: "pm-outbox:pm-live" } });
    await prisma.pmProject.deleteMany({ where: { name: OURS } }); // items, assignees, activity cascade
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.user.deleteMany({ where: { username: OURS } });
  }

  const mkUser = async (key: string, role: "owner" | "admin" | "family" | "guest", extra: object = {}) => {
    const u = await prisma.user.create({
      data: { username: `warp3536-${key}`, displayName: key, role, ...extra },
    });
    ids[key] = u.id;
    return u;
  };

  beforeEach(async () => {
    await cleanup();

    await mkUser("owner", "owner");
    await mkUser("admin", "admin");
    await mkUser("family", "family");
    await mkUser("gone", "family", { directoryStatus: "DEACTIVATED" });
    await mkUser("denied", "family");
    await mkUser("narrow", "family");
    await mkUser("guest-shared", "guest");
    await mkUser("guest-other", "guest");

    const ws = await prisma.pmWorkspace.create({ data: { slug: `warp3536-ws-${Date.now()}`, name: "warp3536-ws" } });
    const project = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3536-project", identifier: "W36" },
    });
    projectId = project.id;
    const a = await prisma.pmWorkItem.create({ data: { projectId, sequenceId: 1, name: "warp3536-shared" } });
    const b = await prisma.pmWorkItem.create({ data: { projectId, sequenceId: 2, name: "warp3536-plain" } });
    sharedItem = a.id;
    plainItem = b.id;
    const otherProject = await prisma.pmProject.create({
      data: { workspaceId: ws.id, name: "warp3536-other-project", identifier: "W37" },
    });
    const c = await prisma.pmWorkItem.create({
      data: { projectId: otherProject.id, sequenceId: 1, name: "warp3536-other-project-item" },
    });
    otherProjectItem = c.id;
    await prisma.pmWorkItemAssignee.create({ data: { workItemId: sharedItem, userId: ids["guest-shared"]! } });
    await prisma.pmWorkItemAssignee.create({ data: { workItemId: otherProjectItem, userId: ids["guest-other"]! } });
  });

  const audience = () =>
    createPmLiveAudience({
      prisma,
      boxModuleIds: async () => {
        const { getEffectiveModuleIds } = await import("../services/modules.service.js");
        return getEffectiveModuleIds(prisma, CFG);
      },
    });

  /** Our fixtures only: other suites' users share this database. */
  const ours = (names: string[]) => names.filter((n) => n.startsWith("warp3536-")).sort();

  it("an unassigned item is heard by active owner, admin and family readers, but not a deactivated person or guest", async () => {
    const names = ours(await audience().usernamesFor(plainItem));
    expect(names).toEqual(["warp3536-admin", "warp3536-denied", "warp3536-family", "warp3536-narrow", "warp3536-owner"]);
  });

  it("refreshes the audience after a current role change removes the PM tier", async () => {
    await prisma.user.update({ where: { id: ids.narrow }, data: { role: "guest" } });
    expect(await audience().usernamesFor(plainItem)).not.toContain("warp3536-narrow");
  });

  it("a deactivated person is not told", async () => {
    expect(await audience().usernamesFor(plainItem)).not.toContain("warp3536-gone");
  });

  it("an external guest hears about the item assigned to them, and about no other", async () => {
    const live = audience();
    const shared = ours(await live.usernamesFor(sharedItem));
    expect(shared).toEqual(["warp3536-admin", "warp3536-family", "warp3536-guest-shared", "warp3536-owner"]);
    const plain = await live.usernamesFor(plainItem);
    expect(plain).not.toContain("warp3536-guest-shared");
    expect(plain).not.toContain("warp3536-guest-other");
  });

  it("is nobody while Projects is switched off on the box", async () => {
    await prisma.moduleSetting.update({ where: { moduleId: "projects" }, data: { enabled: false } });
    try {
      expect(ours(await audience().usernamesFor(sharedItem))).toEqual([]);
    } finally {
      await prisma.moduleSetting.update({ where: { moduleId: "projects" }, data: { enabled: true } });
    }
  });

  describe("through the real outbox framework", () => {
    // A synthetic timeline, far from the real clock, so neither the database's clock
    // nor another suite's rows can land inside it: the consumer's cursor starts at T,
    // The rows below are written at T + 1 s; T + 10 s is beyond the
    // transaction ceiling and the consumer's six-second settlement window.
    const T = Date.parse("2031-01-01T00:00:00.000Z");
    const FRESH = () => new Date(T + 10_000);
    const rowAt = (ms: number) => new Date(T + ms);

    function consumer(sent: Array<{ topic: string; payload: Record<string, unknown> }>) {
      const live = createPmLiveConsumer({
        prisma,
        audience: audience(),
        connected: () => true,
        send: (topic, payload) => void sent.push({ topic, payload }),
      });
      // Its own cursor, so this suite never moves the real `pm-live` one.
      return live;
    }

    it("tells exactly the readers, once per row, with ids and a kind only, and moves its own cursor", async () => {
      const sent: Array<{ topic: string; payload: Record<string, unknown> }> = [];
      const c = consumer(sent);
      // A brand-new consumer starts at "now" and replays nothing: create its cursor
      // at T, then write the rows after it.
      await runOutboxSweep(prisma, c, { now: () => rowAt(0) });

      await prisma.pmActivity.create({
        data: { workItemId: plainItem, actorId: ids.family!, verb: "state_changed", field: "state", oldValue: "a", newValue: "b", createdAt: rowAt(1_000) },
      });
      await prisma.pmActivity.create({
        data: { workItemId: sharedItem, actorId: ids.family!, verb: "commented", createdAt: rowAt(1_001) },
      });

      const result = await runOutboxSweep(prisma, c, { now: FRESH });
      expect(result).toEqual({ handled: 2, deadLettered: 0 });

      const by = (item: string) =>
        sent
          .filter((s) => s.payload.workItemId === item)
          .map((s) => s.topic)
          .filter((t) => t.startsWith("droplet/pm/warp3536-"))
          .sort();
      expect(by(plainItem)).toEqual(["droplet/pm/warp3536-admin", "droplet/pm/warp3536-family", "droplet/pm/warp3536-owner"]);
      expect(by(sharedItem)).toEqual([
        "droplet/pm/warp3536-admin",
        "droplet/pm/warp3536-family",
        "droplet/pm/warp3536-guest-shared",
        "droplet/pm/warp3536-owner",
      ]);
      for (const { payload } of sent) {
        expect(Object.keys(payload).sort()).toEqual(["projectId", "type", "verb", "workItemId"]);
        expect(payload.type).toBe("pm.changed");
        expect(payload.projectId).toBe(projectId);
      }
      const verbs = new Set(sent.map((s) => `${s.payload.workItemId}:${s.payload.verb}`));
      expect(verbs).toEqual(new Set([`${plainItem}:state_changed`, `${sharedItem}:commented`]));

      const cursor = await prisma.systemFlag.findUnique({ where: { key: outboxFlagKey("pm-live") } });
      expect(cursor).not.toBeNull();

      // Nothing is replayed.
      sent.length = 0;
      expect(await runOutboxSweep(prisma, c, { now: FRESH })).toEqual({ handled: 0, deadLettered: 0 });
      expect(sent).toEqual([]);
    });

    it("leaves a row alone until it has settled past the transaction ceiling", async () => {
      const sent: Array<{ topic: string; payload: Record<string, unknown> }> = [];
      const c = consumer(sent);
      expect(c.settleMs).toBe(6_000);
      await runOutboxSweep(prisma, c, { now: () => rowAt(0) });

      const row = await prisma.pmActivity.create({
        data: { workItemId: plainItem, actorId: ids.family!, verb: "updated", createdAt: rowAt(1_000) },
      });

      // Just inside the window: not read.
      const inside = new Date(row.createdAt.getTime() + (c.settleMs ?? 0) - 1);
      expect((await runOutboxSweep(prisma, c, { now: () => inside })).handled).toBe(0);
      // Once it has been still for the window: read.
      const after = new Date(row.createdAt.getTime() + (c.settleMs ?? 0));
      expect((await runOutboxSweep(prisma, c, { now: () => after })).handled).toBe(1);
    });

    it("an item deleted before its row is read is skipped without an error", async () => {
      const sent: Array<{ topic: string; payload: Record<string, unknown> }> = [];
      const c = consumer(sent);
      await runOutboxSweep(prisma, c, { now: () => rowAt(0) });
      await prisma.pmActivity.create({
        data: { workItemId: plainItem, actorId: ids.family!, verb: "updated", createdAt: rowAt(1_000) },
      });
      // The activity row cascades with the item: there is nothing to read, and nothing to fail.
      await prisma.pmWorkItem.delete({ where: { id: plainItem } });

      expect(await runOutboxSweep(prisma, c, { now: FRESH })).toEqual({ handled: 0, deadLettered: 0 });
      expect(sent).toEqual([]);
    });

    it("delivers a surviving leaf tombstone after delete, only to current readers and its assigned active guest", async () => {
      const sent: Array<{ topic: string; payload: Record<string, unknown> }> = [];
      const c = consumer(sent);
      // Start just before this test's rows, excluding shared DB history.
      const cursorKey = outboxFlagKey("pm-live");
      const cursor = { createdAt: new Date(Date.now() - 1_000).toISOString(), id: "" };
      await prisma.systemFlag.upsert({
        where: { key: cursorKey },
        create: { key: cursorKey, valueJson: cursor },
        update: { valueJson: cursor },
      });

      await deleteWorkItem(prisma, ids.family!, sharedItem);
      expect(await prisma.pmWorkItem.findUnique({ where: { id: sharedItem } })).toBeNull();
      const tombstone = await prisma.pmActivity.findFirstOrThrow({ where: { deletedWorkItemId: sharedItem } });
      expect(tombstone.workItemId).toBeNull();
      expect(tombstone.deletedProjectId).toBe(projectId);
      expect(tombstone.deletedGuestUserIds).toEqual([ids["guest-shared"]]);

      const result = await runOutboxSweep(prisma, c, { now: FRESH });
      expect(result).toEqual({ handled: 1, deadLettered: 0 });
      // Other PG suites may leave legitimate workspace readers in this shared
      // database. Assert this suite's complete audience, as the live-row case
      // above does, without deleting or denying those unrelated readers.
      const topics = sent.map(({ topic }) => topic)
        .filter((topic) => topic.startsWith("droplet/pm/warp3536-"))
        .sort();
      expect(topics).toEqual([
        "droplet/pm/warp3536-admin",
        "droplet/pm/warp3536-denied",
        "droplet/pm/warp3536-family",
        "droplet/pm/warp3536-guest-shared",
        "droplet/pm/warp3536-narrow",
        "droplet/pm/warp3536-owner",
      ]);
      expect(topics).not.toContain("droplet/pm/warp3536-gone");
      expect(topics).not.toContain("droplet/pm/warp3536-guest-other");
      expect(sent[0]?.payload).toEqual({
        type: "pm.changed",
        projectId,
        workItemId: sharedItem,
        verb: "deleted",
      });
      for (const { payload } of sent) {
        expect(Object.keys(payload).sort()).toEqual(["projectId", "type", "verb", "workItemId"]);
      }
    });
  });
});
