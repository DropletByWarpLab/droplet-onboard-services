/**
 * WARP-3520 (ADR-069 WS-4) — custom fields against a REAL database.
 *
 * What a mocked Prisma cannot show, and what makes the feature trustworthy:
 *
 *   * Deleting a select option CLEARS it from every item that held it, in the
 *     same transaction, with one `property_changed` row per affected item — a
 *     `select` value is deleted, a `multi_select` value loses the id and is
 *     deleted if that empties it.
 *   * Deleting a whole field audits every affected item BEFORE the cascade takes
 *     the values (the WARP-885 discipline for every cascade in PM).
 *   * A value write and an option-removing patch serialise on the property row
 *     (`FOR SHARE` / `FOR UPDATE`): however they interleave, no value row is left
 *     pointing at an option that no longer exists.
 *   * Values round-trip through the JSON column in the type-tagged shapes, and
 *     come back on the work item's `properties`.
 *   * `(projectId, name)` uniqueness and the 30-field cap hold under the real
 *     constraint.
 *
 * Gated like every other `*.pg.test.ts`: real Postgres, RUN_PG_INTEGRATION=1.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import * as pm from "../services/pm/pm.service.js";
import * as props from "../services/pm/pm-properties.service.js";

// The global unit setup mocks @prisma/client so the DB-less lane never needs
// Postgres. This file must talk to a REAL one.
vi.unmock("@prisma/client");

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("PM custom fields — the database's own guarantees (WARP-3520)", () => {
  let prisma: PrismaClient;

  // Every fixture is namespaced `warp3520b-`: the pg-gated suites share one
  // throwaway database and run in the same lane.
  const OURS = { startsWith: "warp3520b-" } as const;
  const WS = `warp3520b-ws-${process.pid}`;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } = await vi.importActual<typeof import("@prisma/client")>(
      "@prisma/client",
    );
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.user.deleteMany({ where: { username: OURS } });
    await prisma.$disconnect();
  });

  let projectId = "";
  let otherProjectId = "";
  let nth = 0;
  let activeUserId = "";
  let inactiveUserId = "";

  beforeEach(async () => {
    await prisma.pmProject.deleteMany({ where: { name: OURS } });
    await prisma.pmWorkspace.deleteMany({ where: { slug: OURS } });
    await prisma.user.deleteMany({ where: { username: OURS } });
    nth += 1;
    projectId = (
      await pm.createProject(prisma, null, { workspaceSlug: WS, name: `warp3520b-alpha-${nth}`, identifier: `W35B${nth}` })
    ).id;
    otherProjectId = (
      await pm.createProject(prisma, null, { workspaceSlug: WS, name: `warp3520b-other-${nth}`, identifier: `W35X${nth}` })
    ).id;
    activeUserId = (
      await prisma.user.create({ data: { username: `warp3520b-active-${nth}`, displayName: "Active Person" } })
    ).id;
    inactiveUserId = (
      await prisma.user.create({
        data: { username: `warp3520b-gone-${nth}`, displayName: "Gone Person", directoryStatus: "DEACTIVATED" },
      })
    ).id;
  });

  const item = (name: string, project = projectId) =>
    pm.createWorkItem(prisma, null, project, { name: `warp3520b-${name}` });
  const field = (
    name: string,
    type: props.ApiPropertyType,
    options?: props.PropertyOptionInput[],
    project = projectId,
  ) => props.createProperty(prisma, project, { name, type, options });
  const rows = (workItemId: string) =>
    prisma.pmActivity.findMany({ where: { workItemId, verb: "property_changed" }, orderBy: { createdAt: "asc" } });
  const stored = (workItemId: string, propertyId: string) =>
    prisma.pmWorkItemPropertyValue.findUnique({
      where: { workItemId_propertyId: { workItemId, propertyId } },
    });
  const optionId = (p: props.ApiProperty, label: string) => p.options!.find((o) => o.label === label)!.id;

  // ── definitions ──────────────────────────────────────────────────────────

  describe("definitions", () => {
    it("appends new fields in order and lists them by sortOrder", async () => {
      const a = await field("warp3520b-a", "text");
      const b = await field("warp3520b-b", "number");
      const c = await field("warp3520b-c", "date");
      expect([a.sortOrder, b.sortOrder, c.sortOrder]).toEqual([0, 1, 2]);
      expect((await props.listProperties(prisma, projectId)).map((p) => p.name)).toEqual([
        "warp3520b-a",
        "warp3520b-b",
        "warp3520b-c",
      ]);
    });

    it("keeps a project's fields to that project", async () => {
      await field("warp3520b-mine", "text");
      expect(await props.listProperties(prisma, otherProjectId)).toEqual([]);
      await expect(props.listProperties(prisma, "nope")).rejects.toThrow("project_not_found");
    });

    it("refuses a duplicate name in a project (the real unique constraint) but allows it in another", async () => {
      await field("warp3520b-dup", "text");
      await expect(field("warp3520b-dup", "number")).rejects.toThrow("property_name_taken");
      await expect(field("warp3520b-dup", "text", undefined, otherProjectId)).resolves.toBeTruthy();
    });

    it("renaming onto an existing name is property_name_taken, not a 500", async () => {
      await field("warp3520b-one", "text");
      const two = await field("warp3520b-two", "text");
      await expect(props.updateProperty(prisma, null, two.id, { name: "warp3520b-one" })).rejects.toThrow(
        "property_name_taken",
      );
    });

    it("caps a project at 30 fields", async () => {
      for (let i = 0; i < props.PROPERTIES_PER_PROJECT_LIMIT; i += 1) await field(`warp3520b-f${i}`, "text");
      await expect(field("warp3520b-one-too-many", "text")).rejects.toThrow("property_limit_reached");
    });

    it("serializes concurrent creates at the 30-field limit", async () => {
      for (let i = 0; i < props.PROPERTIES_PER_PROJECT_LIMIT - 1; i += 1) await field(`warp3520b-c${i}`, "text");

      const results = await Promise.allSettled([
        field("warp3520b-concurrent-a", "text"),
        field("warp3520b-concurrent-b", "text"),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: "property_limit_reached" }) });
      const all = await props.listProperties(prisma, projectId);
      expect(all).toHaveLength(props.PROPERTIES_PER_PROJECT_LIMIT);
      expect(all.filter((property) => property.sortOrder === props.PROPERTIES_PER_PROJECT_LIMIT - 1)).toHaveLength(1);
    });

    it("stores options with server-minted ids and round-trips them", async () => {
      const created = await field("warp3520b-sev", "select", [{ label: "Low" }, { label: "High", color: "#ef4444" }]);
      expect(created.options).toHaveLength(2);
      for (const o of created.options!) expect(o.id).toMatch(/^[0-9a-f-]{36}$/);
      const [reread] = await props.listProperties(prisma, projectId);
      expect(reread.options).toEqual(created.options);
    });

    it("gives option-less types a null option list, and refuses options on them", async () => {
      expect((await field("warp3520b-t", "text")).options).toBeNull();
      await expect(field("warp3520b-bad", "number", [{ label: "x" }])).rejects.toThrow("invalid_options");
      await expect(field("warp3520b-bad2", "select")).rejects.toThrow("invalid_options");
    });

    it("replaces options in full: keeps ids, adds new ones, and refuses an id it never issued", async () => {
      const created = await field("warp3520b-sev", "select", [{ label: "Low" }, { label: "High" }]);
      const low = optionId(created, "Low");
      const updated = await props.updateProperty(prisma, null, created.id, {
        options: [{ id: low, label: "Minor" }, { label: "Critical" }],
      });
      expect(updated.options!.map((o) => o.label)).toEqual(["Minor", "Critical"]);
      expect(updated.options![0].id).toBe(low);
      await expect(
        props.updateProperty(prisma, null, created.id, { options: [{ id: "made-up", label: "x" }] }),
      ).rejects.toThrow("invalid_options");
      await expect(props.updateProperty(prisma, null, (await field("warp3520b-t", "text")).id, { options: [] })).rejects.toThrow(
        "invalid_options",
      );
    });

    it("reorders with every field exactly once, and refuses anything else without writing", async () => {
      const a = await field("warp3520b-a", "text");
      const b = await field("warp3520b-b", "text");
      const c = await field("warp3520b-c", "text");
      const out = await props.reorderProperties(prisma, projectId, [c.id, a.id, b.id]);
      expect(out.map((p) => p.name)).toEqual(["warp3520b-c", "warp3520b-a", "warp3520b-b"]);
      for (const bad of [[a.id, b.id], [a.id, a.id, b.id, c.id], [a.id, b.id, "nope"], []]) {
        await expect(props.reorderProperties(prisma, projectId, bad)).rejects.toThrow("invalid_order");
      }
      expect((await props.listProperties(prisma, projectId)).map((p) => p.name)).toEqual([
        "warp3520b-c",
        "warp3520b-a",
        "warp3520b-b",
      ]);
    });
  });

  // ── values ───────────────────────────────────────────────────────────────

  describe("values", () => {
    it("stores and returns a value of every type in its tagged shape", async () => {
      const w = await item("w");
      const text = await field("warp3520b-text", "text");
      const num = await field("warp3520b-num", "number");
      const date = await field("warp3520b-date", "date");
      const flag = await field("warp3520b-flag", "boolean");
      const one = await field("warp3520b-one", "select", [{ label: "A" }, { label: "B" }]);
      const many = await field("warp3520b-many", "multi_select", [{ label: "A" }, { label: "B" }]);
      const who = await field("warp3520b-who", "member");

      await props.setPropertyValue(prisma, "u1", w.id, text.id, { text: "  hello  " });
      await props.setPropertyValue(prisma, "u1", w.id, num.id, { number: 2.5 });
      await props.setPropertyValue(prisma, "u1", w.id, date.id, { date: "2026-10-04" });
      await props.setPropertyValue(prisma, "u1", w.id, flag.id, { boolean: false });
      await props.setPropertyValue(prisma, "u1", w.id, one.id, { optionIds: [optionId(one, "B")] });
      await props.setPropertyValue(prisma, "u1", w.id, many.id, {
        optionIds: [optionId(many, "A"), optionId(many, "B")],
      });
      const result = await props.setPropertyValue(prisma, "u1", w.id, who.id, { userIds: [activeUserId] });

      expect(result.properties).toEqual({
        [text.id]: { text: "hello" },
        [num.id]: { number: 2.5 },
        [date.id]: { date: "2026-10-04" },
        [flag.id]: { boolean: false },
        [one.id]: { optionIds: [optionId(one, "B")] },
        [many.id]: { optionIds: [optionId(many, "A"), optionId(many, "B")] },
        [who.id]: { userIds: [activeUserId] },
      });
      const page = await pm.listWorkItems(prisma, projectId);
      expect(page).toMatchObject({ total: 1, nextCursor: null });
      expect(page.items[0].properties).toEqual(result.properties);
    });

    it("writes one activity row per real change, with labels for selects", async () => {
      const w = await item("w");
      const sev = await field("warp3520b-sev", "select", [{ label: "Low" }, { label: "High" }]);
      await props.setPropertyValue(prisma, "u1", w.id, sev.id, { optionIds: [optionId(sev, "Low")] });
      await props.setPropertyValue(prisma, "u1", w.id, sev.id, { optionIds: [optionId(sev, "Low")] }); // identity
      await props.setPropertyValue(prisma, "u1", w.id, sev.id, { optionIds: [optionId(sev, "High")] });
      await props.clearPropertyValue(prisma, "u1", w.id, sev.id);
      await props.clearPropertyValue(prisma, "u1", w.id, sev.id); // nothing to clear

      expect((await rows(w.id)).map((r) => [r.field, r.oldValue, r.newValue, r.actorId])).toEqual([
        ["warp3520b-sev", null, "Low", "u1"],
        ["warp3520b-sev", "Low", "High", "u1"],
        ["warp3520b-sev", "High", null, "u1"],
      ]);
      expect(await stored(w.id, sev.id)).toBeNull();
    });

    it("treats a multi_select re-sent in another order as an identity write", async () => {
      const w = await item("w");
      const many = await field("warp3520b-many", "multi_select", [{ label: "A" }, { label: "B" }]);
      const [a, b] = [optionId(many, "A"), optionId(many, "B")];
      await props.setPropertyValue(prisma, null, w.id, many.id, { optionIds: [a, b] });
      await props.setPropertyValue(prisma, null, w.id, many.id, { optionIds: [b, a] });
      expect(await rows(w.id)).toHaveLength(1);
    });

    it("records the other scalar types as plain text", async () => {
      const w = await item("w");
      const num = await field("warp3520b-num", "number");
      const flag = await field("warp3520b-flag", "boolean");
      await props.setPropertyValue(prisma, null, w.id, num.id, { number: 3 });
      await props.setPropertyValue(prisma, null, w.id, num.id, { number: 4 });
      await props.setPropertyValue(prisma, null, w.id, flag.id, { boolean: true });
      expect((await rows(w.id)).map((r) => [r.field, r.oldValue, r.newValue])).toEqual([
        ["warp3520b-num", null, "3"],
        ["warp3520b-num", "3", "4"],
        ["warp3520b-flag", null, "true"],
      ]);
    });

    it("refuses a bad value with a sentence and stores nothing", async () => {
      const w = await item("w");
      const num = await field("warp3520b-num", "number");
      const sev = await field("warp3520b-sev", "select", [{ label: "Low" }]);
      await expect(props.setPropertyValue(prisma, null, w.id, num.id, { number: 1e15 })).rejects.toBeInstanceOf(
        props.PropertyValueError,
      );
      await expect(props.setPropertyValue(prisma, null, w.id, num.id, { text: "3" })).rejects.toBeInstanceOf(
        props.PropertyValueError,
      );
      await expect(
        props.setPropertyValue(prisma, null, w.id, sev.id, { optionIds: ["nope"] }),
      ).rejects.toBeInstanceOf(props.PropertyValueError);
      expect(await prisma.pmWorkItemPropertyValue.count({ where: { workItemId: w.id } })).toBe(0);
      expect(await rows(w.id)).toHaveLength(0);
    });

    it("accepts a member only if they are an ACTIVE user", async () => {
      const w = await item("w");
      const who = await field("warp3520b-who", "member");
      await expect(
        props.setPropertyValue(prisma, null, w.id, who.id, { userIds: [inactiveUserId] }),
      ).rejects.toBeInstanceOf(props.PropertyValueError);
      await expect(
        props.setPropertyValue(prisma, null, w.id, who.id, { userIds: ["no-such-user"] }),
      ).rejects.toBeInstanceOf(props.PropertyValueError);
      await expect(props.setPropertyValue(prisma, null, w.id, who.id, { userIds: [activeUserId] })).resolves.toBeTruthy();
    });

    it("answers property_not_found for a field of ANOTHER project — the same as one that does not exist", async () => {
      const w = await item("w");
      const foreign = await field("warp3520b-foreign", "text", undefined, otherProjectId);
      await expect(props.setPropertyValue(prisma, null, w.id, foreign.id, { text: "x" })).rejects.toThrow(
        "property_not_found",
      );
      await expect(props.setPropertyValue(prisma, null, w.id, "nope", { text: "x" })).rejects.toThrow(
        "property_not_found",
      );
      await expect(props.clearPropertyValue(prisma, null, w.id, foreign.id)).rejects.toThrow("property_not_found");
      await expect(props.setPropertyValue(prisma, null, "nope", foreign.id, { text: "x" })).rejects.toThrow(
        "work_item_not_found",
      );
    });
  });

  // ── option removal and field deletion ────────────────────────────────────

  describe("removing an option", () => {
    it("clears a select value from every item that held it, one row per item, and leaves the others", async () => {
      const [low, high, none] = [await item("low"), await item("high"), await item("none")];
      const sev = await field("warp3520b-sev", "select", [{ label: "Low" }, { label: "High" }]);
      await props.setPropertyValue(prisma, null, low.id, sev.id, { optionIds: [optionId(sev, "Low")] });
      await props.setPropertyValue(prisma, null, high.id, sev.id, { optionIds: [optionId(sev, "High")] });
      const before = (await rows(low.id)).length;

      await props.updateProperty(prisma, "u9", sev.id, { options: [{ id: optionId(sev, "Low"), label: "Low" }] });

      expect(await stored(high.id, sev.id)).toBeNull();
      expect(await stored(low.id, sev.id)).not.toBeNull();
      // Its own set, then the clear that the option removal wrote.
      const cleared = await rows(high.id);
      expect(cleared).toHaveLength(2);
      expect(cleared.at(-1)).toMatchObject({ field: "warp3520b-sev", oldValue: "High", newValue: null, actorId: "u9" });
      expect((await rows(low.id)).length).toBe(before);
      expect(await rows(none.id)).toHaveLength(0);
    });

    it("trims a multi_select value, deleting it only when nothing is left", async () => {
      const [both, onlyB] = [await item("both"), await item("only-b")];
      const many = await field("warp3520b-many", "multi_select", [{ label: "A" }, { label: "B" }, { label: "C" }]);
      const [a, b] = [optionId(many, "A"), optionId(many, "B")];
      await props.setPropertyValue(prisma, null, both.id, many.id, { optionIds: [a, b] });
      await props.setPropertyValue(prisma, null, onlyB.id, many.id, { optionIds: [b] });

      await props.updateProperty(prisma, null, many.id, {
        options: [{ id: a, label: "A" }, { id: optionId(many, "C"), label: "C" }],
      });

      expect((await stored(both.id, many.id))?.value).toEqual({ optionIds: [a] });
      expect(await stored(onlyB.id, many.id)).toBeNull();
      const trimmed = await rows(both.id);
      expect(trimmed.at(-1)).toMatchObject({ oldValue: "A, B", newValue: "A" });
      expect((await rows(onlyB.id)).at(-1)).toMatchObject({ oldValue: "B", newValue: null });
    });

    it("never leaves a dangling option id, however a value write and the removal interleave", async () => {
      const w = await item("raced");
      const sev = await field("warp3520b-sev", "select", [{ label: "Low" }, { label: "High" }]);
      const low = optionId(sev, "Low");
      const outcomes = await Promise.allSettled([
        props.setPropertyValue(prisma, null, w.id, sev.id, { optionIds: [optionId(sev, "High")] }),
        props.updateProperty(prisma, null, sev.id, { options: [{ id: low, label: "Low" }] }),
      ]);
      // The patch always wins or loses cleanly; the invariant is the end state.
      expect(outcomes[1].status).toBe("fulfilled");
      const value = await stored(w.id, sev.id);
      const live = new Set((await props.listProperties(prisma, projectId))[0].options!.map((o) => o.id));
      if (value) {
        for (const id of (value.value as { optionIds: string[] }).optionIds) expect(live.has(id)).toBe(true);
      }
    });

    it("refuses a value that names an option a previous patch removed", async () => {
      const w = await item("w");
      const sev = await field("warp3520b-sev", "select", [{ label: "Low" }, { label: "High" }]);
      const high = optionId(sev, "High");
      await props.updateProperty(prisma, null, sev.id, { options: [{ id: optionId(sev, "Low"), label: "Low" }] });
      await expect(props.setPropertyValue(prisma, null, w.id, sev.id, { optionIds: [high] })).rejects.toBeInstanceOf(
        props.PropertyValueError,
      );
    });
  });

  describe("deleting a field", () => {
    it("audits every affected item, then removes the values with the field", async () => {
      const [a, b, c] = [await item("a"), await item("b"), await item("c")];
      const num = await field("warp3520b-num", "number");
      const keep = await field("warp3520b-keep", "text");
      await props.setPropertyValue(prisma, null, a.id, num.id, { number: 1 });
      await props.setPropertyValue(prisma, null, b.id, num.id, { number: 2 });
      await props.setPropertyValue(prisma, null, c.id, keep.id, { text: "stays" });

      await props.deleteProperty(prisma, "u9", num.id);

      expect(await prisma.pmCustomProperty.findUnique({ where: { id: num.id } })).toBeNull();
      expect(await prisma.pmWorkItemPropertyValue.count({ where: { propertyId: num.id } })).toBe(0);
      expect((await rows(a.id)).at(-1)).toMatchObject({ field: "warp3520b-num", oldValue: "1", newValue: null, actorId: "u9" });
      expect((await rows(b.id)).at(-1)).toMatchObject({ oldValue: "2", newValue: null });
      expect(await rows(c.id)).toHaveLength(1); // only its own set
      expect((await stored(c.id, keep.id))?.value).toEqual({ text: "stays" });
    });

    it("is property_not_found for a field that is already gone", async () => {
      await expect(props.deleteProperty(prisma, null, "nope")).rejects.toThrow("property_not_found");
    });
  });
});
