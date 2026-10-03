/**
 * WARP-3510 / WARP-3506 — real-Postgres proof of the two camera migrations.
 *
 * camera-adoption.schema.test.ts locks what the SQL says; only a real Postgres
 * shows what it DOES to rows:
 *
 *   - the adoption backfill promotes exactly the rows its rule names (enabled,
 *     or not auto-discovered), never demotes, and is a no-op the second time;
 *   - the Camera.name rewrite lands the Frigate key (the same string
 *     toFrigateKey() gives), moves the denormalised CameraPin.cameraName with it,
 *     keeps the Camera id and every link that points at it by id, leaves a
 *     colliding or unusable row ALONE instead of aborting, and renames nothing
 *     the second time.
 *
 * `prisma migrate deploy` has already applied both files by the time this suite
 * runs (the pg lane deploys the full set first), so each test re-executes the SQL
 * from disk against its own fixtures. Both files are idempotent, which is also
 * the property under test. The rename file is one DO block and runs whole through
 * $executeRawUnsafe; the backfill is lifted out of its file as the one
 * line-leading `UPDATE "Camera" ... ;` statement.
 *
 * Both statements act on the WHOLE Camera table, not on this suite's rows (that
 * is what a migration is). The suite is still safe next to the other pg suites,
 * which share the throwaway database: none of them writes a Camera row, every
 * fixture here is namespaced `w3510_` (lower-case on purpose: a prefix with a
 * hyphen or a capital would itself be renamed by the migration under test), and
 * cleanup is scoped to that namespace. Run via scripts/test-orchestrator-pg.sh;
 * in CI by the `pg-integration` job in .github/workflows/orchestrator-tests.yml.
 *
 * Gated behind RUN_PG_INTEGRATION=1 + DATABASE_URL, so the DB-less default lane
 * skips it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { MIGRATIONS_DIR } from "./helpers/test-paths.js";
import { toFrigateKey } from "../services/camera-key.js";

// The global unit setup (src/__tests__/setup.ts) mocks @prisma/client so the
// DB-less lane never needs Postgres. This file must talk to a REAL Postgres, so
// undo the mock and pull the real client in at runtime.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

const ADOPTION_MIGRATION = "20261003120000_warp_3510_camera_adoption";
const FRIGATE_KEY_MIGRATION = "20261003120100_warp_3506_camera_name_is_frigate_key";

/** Every fixture this suite mints (camera names, camera ids, user ids, group names) starts with it. */
const PREFIX = "w3510_";
const OURS = { startsWith: PREFIX } as const;

const readMigration = (folder: string): string => readFileSync(path.join(MIGRATIONS_DIR, folder, "migration.sql"), "utf8");

/** The backfill, lifted out of its file: the one line-leading UPDATE, through its `;`. */
function backfillStatement(): string {
  const sql = readMigration(ADOPTION_MIGRATION);
  const statement = /^UPDATE "Camera"[\s\S]*?;/m.exec(sql);
  if (!statement) throw new Error(`no standalone UPDATE "Camera" ... ; statement in ${ADOPTION_MIGRATION}`);
  expect(statement[0]).toContain(`"enabled" = true OR "autoDiscovered" = false`);
  expect(statement[0]).not.toContain("$$");
  return statement[0];
}

describe.skipIf(!RUN)("Camera adoption + Frigate-key migrations — real Postgres (WARP-3510, WARP-3506)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /**
   * FK-ordered cleanup, scoped to this suite's fixtures. Other pg-gated suites
   * share the throwaway DB, so never TRUNCATE ... CASCADE here. Cameras are
   * matched by id OR name: a fixture whose name has no prefix (`---`, `___`)
   * carries a prefixed id, and a renamed one keeps its prefix in the new name.
   */
  const cleanup = async (): Promise<void> => {
    await prisma.cameraNotificationPref.deleteMany({ where: { userId: OURS } });
    await prisma.cameraAccessGrant.deleteMany({ where: { userId: OURS } });
    await prisma.cameraGroup.deleteMany({ where: { name: OURS } }); // members cascade
    await prisma.cameraPin.deleteMany({ where: { userId: OURS } });
    await prisma.camera.deleteMany({ where: { OR: [{ id: OURS }, { name: OURS }] } }); // remaining links cascade
  };

  beforeEach(cleanup);
  afterEach(cleanup);

  type CameraInit = {
    name: string;
    id?: string;
    enabled?: boolean;
    autoDiscovered?: boolean;
    adoption?: "CANDIDATE" | "ADOPTED";
    createdAt?: Date;
  };

  /**
   * `adoption` is always written explicitly: the column default is CANDIDATE, so
   * leaving it out would let the default stand in for the state a test sets up.
   */
  const mkCamera = (init: CameraInit) =>
    prisma.camera.create({
      data: {
        id: init.id ?? `${PREFIX}${randomUUID()}`,
        name: init.name,
        displayName: init.name,
        ipAddress: "10.35.10.1",
        enabled: init.enabled ?? true,
        autoDiscovered: init.autoDiscovered ?? false,
        adoption: init.adoption ?? "CANDIDATE",
        ...(init.createdAt ? { createdAt: init.createdAt } : {}),
      },
    });

  const mkPin = (userId: string, cameraName: string) => prisma.cameraPin.create({ data: { userId, cameraName } });

  const nameOf = async (id: string): Promise<string> => (await prisma.camera.findUniqueOrThrow({ where: { id } })).name;
  const adoptionOf = async (id: string) => (await prisma.camera.findUniqueOrThrow({ where: { id } })).adoption;

  /** The pin names a user holds, sorted. */
  const pinsOf = async (userId: string): Promise<string[]> =>
    (await prisma.cameraPin.findMany({ where: { userId } })).map((p) => p.cameraName).sort();

  /** Re-runs the adoption backfill; resolves to the number of rows it changed. */
  const runBackfill = async (): Promise<number> => prisma.$executeRawUnsafe(backfillStatement());

  /** Re-runs the whole rename file (one DO block). It must never reject, whatever the rows hold. */
  const runRename = async (): Promise<number> => prisma.$executeRawUnsafe(readMigration(FRIGATE_KEY_MIGRATION));

  const OLDER = new Date("2026-01-01T00:00:00.000Z");
  const NEWER = new Date("2026-02-01T00:00:00.000Z");

  describe("adoption backfill (20261003120000_warp_3510_camera_adoption)", () => {
    it("a row inserted without an adoption takes the DB default, CANDIDATE", async () => {
      const id = `${PREFIX}${randomUUID()}`;
      await prisma.$executeRaw`
        INSERT INTO "Camera" ("id", "name", "displayName", "ipAddress", "updatedAt")
        VALUES (${id}, ${`${PREFIX}default_state`}, ${"Default state"}, ${"10.35.10.2"}, now())
      `;
      expect(await adoptionOf(id)).toBe("CANDIDATE");
    });

    it("adopts the rows the rule names, leaves a disabled auto-discovered placeholder a CANDIDATE, and never demotes", async () => {
      const enabledAuto = await mkCamera({ name: `${PREFIX}enabled_auto`, enabled: true, autoDiscovered: true });
      const enabledOperator = await mkCamera({ name: `${PREFIX}enabled_operator`, enabled: true, autoDiscovered: false });
      const disabledOperator = await mkCamera({ name: `${PREFIX}disabled_operator`, enabled: false, autoDiscovered: false });
      const placeholder = await mkCamera({ name: `${PREFIX}placeholder`, enabled: false, autoDiscovered: true });
      // Already ADOPTED and shaped like a placeholder (an operator disabled an
      // auto-discovered camera that was then adopted): only CANDIDATE rows are
      // ever touched, so it stays ADOPTED.
      const keptAdopted = await mkCamera({
        name: `${PREFIX}kept_adopted`,
        enabled: false,
        autoDiscovered: true,
        adoption: "ADOPTED",
      });

      const firstRun = await runBackfill();
      expect(firstRun).toBeGreaterThanOrEqual(3); // enabledAuto, enabledOperator, disabledOperator

      expect(await adoptionOf(enabledAuto.id)).toBe("ADOPTED"); // enabled = true, autoDiscovered = true
      expect(await adoptionOf(enabledOperator.id)).toBe("ADOPTED"); // enabled = true, autoDiscovered = false
      expect(await adoptionOf(disabledOperator.id)).toBe("ADOPTED"); // enabled = false, autoDiscovered = false
      expect(await adoptionOf(placeholder.id)).toBe("CANDIDATE"); // enabled = false, autoDiscovered = true
      expect(await adoptionOf(keptAdopted.id)).toBe("ADOPTED");
    });

    it("is idempotent: a second run changes nothing", async () => {
      const promoted = await mkCamera({ name: `${PREFIX}promoted`, enabled: true, autoDiscovered: true });
      const placeholder = await mkCamera({ name: `${PREFIX}still_placeholder`, enabled: false, autoDiscovered: true });

      await runBackfill();
      const before = {
        promoted: await adoptionOf(promoted.id),
        placeholder: await adoptionOf(placeholder.id),
      };
      expect(before).toEqual({ promoted: "ADOPTED", placeholder: "CANDIDATE" });

      // Zero rows updated: every row the rule names is ADOPTED after the first
      // run, and the WHERE only ever looks at CANDIDATE rows.
      expect(await runBackfill()).toBe(0);
      expect({
        promoted: await adoptionOf(promoted.id),
        placeholder: await adoptionOf(placeholder.id),
      }).toEqual(before);
    });
  });

  describe("Camera.name becomes the Frigate key (20261003120100_warp_3506_camera_name_is_frigate_key)", () => {
    it("rewrites Warp_Lab_Office and Front-Door to their keys, keeping the row, its id and its displayName", async () => {
      const office = await mkCamera({ name: `${PREFIX}Warp_Lab_Office` });
      const door = await mkCamera({ name: `${PREFIX}Front-Door` });
      const alreadyKey = await mkCamera({ name: `${PREFIX}ok_cam` });

      await expect(runRename()).resolves.toBeTypeOf("number");

      expect(await nameOf(office.id)).toBe(`${PREFIX}warp_lab_office`);
      expect(await nameOf(door.id)).toBe(`${PREFIX}front_door`);
      expect(await nameOf(alreadyKey.id)).toBe(`${PREFIX}ok_cam`);
      // What the operator typed lives in displayName, which the migration leaves alone.
      expect((await prisma.camera.findUniqueOrThrow({ where: { id: office.id } })).displayName).toBe(`${PREFIX}Warp_Lab_Office`);
      expect((await prisma.camera.findUniqueOrThrow({ where: { id: door.id } })).displayName).toBe(`${PREFIX}Front-Door`);
      expect(await prisma.camera.count({ where: { OR: [{ id: OURS }, { name: OURS }] } })).toBe(3); // nothing deleted
    });

    it("gives every name the string toFrigateKey gives (UTF-16 emoji, dotted capital I, Kelvin sign, punctuation)", async () => {
      const names = [
        `${PREFIX}Warp_Lab_Office`,
        `${PREFIX}Front-Door`,
        `${PREFIX}A--B`,
        `${PREFIX}cam.1`,
        `${PREFIX}Cam #1 (Garage)`,
        `${PREFIX}Ünïcödé Cam`,
        `${PREFIX}Garage \u{1F600} Door`, // two UTF-16 units in JS, one code point in Postgres
        `${PREFIX}İstanbul`, // JS lower-cases it to `i` + a combining dot
        `${PREFIX}Kelvin`, // Kelvin sign: lower-cases to ASCII `k`
        `${PREFIX}trailing  `,
      ];
      const created = [];
      for (const name of names) created.push(await mkCamera({ name }));
      // Distinct keys, or this would be a collision test in disguise.
      expect(new Set(names.map(toFrigateKey)).size).toBe(names.length);

      await runRename();

      for (const [i, camera] of created.entries()) {
        expect(await nameOf(camera.id), `key for ${JSON.stringify(names[i])}`).toBe(toFrigateKey(names[i]!));
      }
    });

    it("moves the denormalised CameraPin names with the rename; the id and every link by id survive", async () => {
      const office = await mkCamera({ name: `${PREFIX}Warp_Lab_Office` });
      const group = await prisma.cameraGroup.create({ data: { name: `${PREFIX}group` } });
      const member = await prisma.cameraGroupMember.create({ data: { groupId: group.id, cameraId: office.id } });
      const grant = await prisma.cameraAccessGrant.create({ data: { userId: `${PREFIX}user`, cameraId: office.id } });
      const notify = await prisma.cameraNotificationPref.create({ data: { userId: `${PREFIX}user`, cameraId: office.id } });
      await mkPin(`${PREFIX}user`, `${PREFIX}Warp_Lab_Office`);
      await mkPin(`${PREFIX}user2`, `${PREFIX}Warp_Lab_Office`);
      await mkPin(`${PREFIX}user`, `${PREFIX}some_other_camera`); // a different camera's pin

      await runRename();

      const renamed = await prisma.camera.findUniqueOrThrow({ where: { id: office.id } });
      expect(renamed.name).toBe(`${PREFIX}warp_lab_office`);
      expect(await pinsOf(`${PREFIX}user`)).toEqual([`${PREFIX}some_other_camera`, `${PREFIX}warp_lab_office`]);
      expect(await pinsOf(`${PREFIX}user2`)).toEqual([`${PREFIX}warp_lab_office`]);
      // Rows that reference the camera by id are the same rows pointing at the same camera.
      expect(await prisma.cameraGroupMember.findUniqueOrThrow({ where: { id: member.id } })).toMatchObject({
        groupId: group.id,
        cameraId: office.id,
      });
      expect(await prisma.cameraAccessGrant.findUniqueOrThrow({ where: { id: grant.id } })).toMatchObject({ cameraId: office.id });
      expect(await prisma.cameraNotificationPref.findUniqueOrThrow({ where: { id: notify.id } })).toMatchObject({ cameraId: office.id });
    });

    it("skips a pin whose user already pins the new name, moves the others, and never throws", async () => {
      await mkCamera({ name: `${PREFIX}Pin-Cam` });
      await mkPin(`${PREFIX}has_both`, `${PREFIX}Pin-Cam`);
      await mkPin(`${PREFIX}has_both`, `${PREFIX}pin_cam`); // already pins the new name
      await mkPin(`${PREFIX}only_old`, `${PREFIX}Pin-Cam`);

      await expect(runRename()).resolves.toBeTypeOf("number");

      // The unique (userId, cameraName) would have rejected the move: that pin stays.
      expect(await pinsOf(`${PREFIX}has_both`)).toEqual([`${PREFIX}Pin-Cam`, `${PREFIX}pin_cam`]);
      expect(await pinsOf(`${PREFIX}only_old`)).toEqual([`${PREFIX}pin_cam`]);
    });

    it("leaves a row alone, without throwing, when its key is already another camera's name", async () => {
      const older = await mkCamera({ name: `${PREFIX}Cam-One`, createdAt: OLDER });
      const owner = await mkCamera({ name: `${PREFIX}cam_one`, createdAt: NEWER });
      await mkPin(`${PREFIX}user`, `${PREFIX}Cam-One`);

      await expect(runRename()).resolves.toBeTypeOf("number");

      expect(await nameOf(older.id)).toBe(`${PREFIX}Cam-One`); // not renamed, not deleted, not merged
      expect(await nameOf(owner.id)).toBe(`${PREFIX}cam_one`);
      expect(await pinsOf(`${PREFIX}user`)).toEqual([`${PREFIX}Cam-One`]); // still points at the camera that kept its name
    });

    it("when two non-canonical names collapse to one key, the OLDER row takes it and the newer is left untouched", async () => {
      // The newer row is inserted FIRST, so insertion order cannot be what decides.
      const newer = await mkCamera({ name: `${PREFIX}HALL_WAY`, createdAt: NEWER });
      const older = await mkCamera({ name: `${PREFIX}Hall-Way`, createdAt: OLDER });

      await runRename();

      expect(await nameOf(older.id)).toBe(`${PREFIX}hall_way`);
      expect(await nameOf(newer.id)).toBe(`${PREFIX}HALL_WAY`);
    });

    it("when two names collapse to one key, an ADOPTED row beats an older CANDIDATE for it", async () => {
      // Age is only the tie-break: an adopted camera outranks it, as in a discovery
      // merge. The older placeholder is left as it is, not deleted or merged.
      const placeholder = await mkCamera({ name: `${PREFIX}Lobby-Cam`, createdAt: OLDER, adoption: "CANDIDATE" });
      const live = await mkCamera({ name: `${PREFIX}LOBBY_CAM`, createdAt: NEWER, adoption: "ADOPTED" });

      await runRename();

      expect(await nameOf(live.id)).toBe(`${PREFIX}lobby_cam`);
      expect(await nameOf(placeholder.id)).toBe(`${PREFIX}Lobby-Cam`);
    });

    it("breaks a createdAt tie by id", async () => {
      const sameInstant = new Date("2026-03-01T00:00:00.000Z");
      const higher = await mkCamera({ id: `${PREFIX}tie_b`, name: `${PREFIX}Tie-X`, createdAt: sameInstant });
      const lower = await mkCamera({ id: `${PREFIX}tie_a`, name: `${PREFIX}TIE_X`, createdAt: sameInstant });

      await runRename();

      expect(await nameOf(lower.id)).toBe(`${PREFIX}tie_x`);
      expect(await nameOf(higher.id)).toBe(`${PREFIX}Tie-X`);
    });

    it("leaves a name with no usable key (---, ___, 日本) untouched, and keeps going with the rows after it", async () => {
      // Oldest first, so the unusable rows are met before the one that must still be renamed.
      const dashes = await mkCamera({ id: `${PREFIX}unusable_dashes`, name: "---", createdAt: new Date("2025-12-01T00:00:00.000Z") });
      const underscores = await mkCamera({ id: `${PREFIX}unusable_underscores`, name: "___", createdAt: new Date("2025-12-02T00:00:00.000Z") });
      const cjk = await mkCamera({ id: `${PREFIX}unusable_cjk`, name: "日本", createdAt: new Date("2025-12-03T00:00:00.000Z") });
      const usable = await mkCamera({ name: `${PREFIX}Ok-Cam`, createdAt: OLDER });

      await expect(runRename()).resolves.toBeTypeOf("number");

      expect(await nameOf(dashes.id)).toBe("---");
      expect(await nameOf(underscores.id)).toBe("___");
      expect(await nameOf(cjk.id)).toBe("日本");
      expect(await nameOf(usable.id)).toBe(`${PREFIX}ok_cam`);
    });

    it("is idempotent: a second run renames nothing more, collisions and unusable names included", async () => {
      await mkCamera({ name: `${PREFIX}Idem-A`, createdAt: OLDER });
      await mkCamera({ name: `${PREFIX}Idem-B`, createdAt: OLDER });
      await mkCamera({ name: `${PREFIX}idem_b`, createdAt: NEWER }); // makes Idem-B a collision
      await mkCamera({ id: `${PREFIX}idem_unusable`, name: "---", createdAt: OLDER });
      await mkPin(`${PREFIX}user`, `${PREFIX}Idem-A`);
      await mkPin(`${PREFIX}user`, `${PREFIX}Idem-B`);

      const snapshot = async () => ({
        cameras: (await prisma.camera.findMany({ where: { OR: [{ id: OURS }, { name: OURS }] }, orderBy: { id: "asc" } })).map((c) => [c.id, c.name]),
        pins: await pinsOf(`${PREFIX}user`),
      });

      const initial = await snapshot();
      await runRename();
      const afterFirst = await snapshot();
      expect(afterFirst).not.toEqual(initial); // the first run did something...
      expect(afterFirst.pins).toEqual([`${PREFIX}Idem-B`, `${PREFIX}idem_a`]);

      await expect(runRename()).resolves.toBeTypeOf("number");
      expect(await snapshot()).toEqual(afterFirst); // ...and the second did not
    });
  });
});
