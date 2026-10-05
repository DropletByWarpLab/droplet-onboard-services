/**
 * WARP-3520 (ADR-069 WS-4) — custom fields: per-project field DEFINITIONS
 * (`PmCustomProperty`) and the VALUES items hold for them
 * (`PmWorkItemPropertyValue`).
 *
 * Both models have existed since the ADR-026 foundation with no writer anywhere.
 * This module is the writer, and it is the only one: every value is validated
 * against its field's type before it is stored, never trusted from the client.
 *
 * Beside pm.service.ts rather than inside it, the way pm-relations.service.ts is:
 * its own error vocabulary, its own activity writer, and a surface (field
 * definitions, option lists, type-tagged values) that has nothing to do with the
 * work-item columns pm.service.ts owns.
 *
 * ── value shapes ───────────────────────────────────────────────────────────
 *
 * `PmWorkItemPropertyValue.value` is type-tagged JSON, one shape per field type,
 * the same on the wire and in the table (schema.prisma documents them):
 *
 *   text         {"text": "…"}              1..2000 chars after trim
 *   number       {"number": 3}              finite, |n| <= 1e12
 *   date         {"date": "YYYY-MM-DD"}     a real calendar date
 *   boolean      {"boolean": true}
 *   select       {"optionIds": ["…"]}       exactly one, an option of THIS field
 *   multi_select {"optionIds": ["…", …]}    1..50 distinct options of this field
 *   member       {"userIds": ["…"]}         exactly one, an ACTIVE user
 *
 * Anything else — an unknown key, the wrong shape for the field's type, a value
 * for a field that belongs to another project — is refused.
 *
 * ── options, and what deleting one does ────────────────────────────────────
 *
 * A select field's options are `{id, label, color}[]` in a Json column. `PATCH
 * {options}` is a FULL replacement: an existing option left out is deleted, and
 * the same transaction clears it from every item that held it (a `select` value
 * is deleted; a `multi_select` value loses the id and is deleted if that empties
 * it), writing one `property_changed` activity row per affected item. Nothing is
 * left dangling for a reader to guess about.
 *
 * ── concurrency ────────────────────────────────────────────────────────────
 *
 * A value write validates against the field's option list; an option-removing
 * patch rewrites that list. Interleaved, they would store a value that points at
 * a deleted option. So a value write takes `FOR SHARE` on the property row and
 * the patch / delete take `FOR UPDATE`: they queue behind each other, and each
 * re-reads the property after the lock — READ COMMITTED sees the committed list.
 * Locks, not SERIALIZABLE: this module needs no retry loop and does not put its
 * suites in the seam-adoption gate's scope (see pm-relations.service.ts).
 *
 * Errors are plain `Error(message)` with stable string codes, as everywhere in
 * this directory, so the route layer maps codes to HTTP status.
 */

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { PM_ERRORS, getWorkItem, isServiceDesk, type ApiWorkItem } from "./pm.service.js";

type Db = PrismaClient | Prisma.TransactionClient;

// ── Stable error codes ───────────────────────────────────────────────────────
export const PM_PROPERTY_ERRORS = {
  PROPERTY_NOT_FOUND: "property_not_found",
  PROPERTY_NAME_TAKEN: "property_name_taken",
  PROPERTY_LIMIT_REACHED: "property_limit_reached",
  INVALID_OPTIONS: "invalid_options",
  INVALID_VALUE: "invalid_value",
  // Shared with the rest of PM, re-exported so a catch site imports ONE object.
  PROJECT_NOT_FOUND: PM_ERRORS.PROJECT_NOT_FOUND,
  WORK_ITEM_NOT_FOUND: PM_ERRORS.WORK_ITEM_NOT_FOUND,
  INVALID_ORDER: PM_ERRORS.INVALID_ORDER,
} as const;

/** A rejected value, carrying the one plain-English sentence the dashboard shows
 *  under the editor (the route puts it in `details.fieldErrors.value`). */
export class PropertyValueError extends Error {
  constructor(readonly userMessage: string) {
    super(PM_PROPERTY_ERRORS.INVALID_VALUE);
    this.name = "PropertyValueError";
  }
}

// ── Limits ───────────────────────────────────────────────────────────────────
// Named and exported so the unit test asserts THEM, not a restated copy. Every
// work item carries its values in every list response, so the field count is a
// payload bound as much as a UX one.
export const PROPERTIES_PER_PROJECT_LIMIT = 30;
export const OPTIONS_PER_PROPERTY_LIMIT = 50;
export const OPTION_LABEL_MAX = 60;
export const TEXT_VALUE_MAX = 2000;
export const NUMBER_VALUE_MAX = 1e12;

// ── Types ────────────────────────────────────────────────────────────────────

/** Read off the generated client so a schema rename is a compile error here. */
export type ApiPropertyType = Prisma.PmCustomPropertyCreateManyInput["type"];

export interface ApiPropertyOption {
  id: string;
  label: string;
  color: string | null;
}

export interface ApiProperty {
  id: string;
  projectId: string;
  name: string;
  type: ApiPropertyType;
  /** The choice list for select / multi_select; null for every other type. */
  options: ApiPropertyOption[] | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** An option as sent: an existing option keeps its `id`; a new one has none. */
export interface PropertyOptionInput {
  id?: string;
  label: string;
  color?: string | null;
}

/** The type-tagged value, as stored and as returned. */
export type PropertyValue =
  | { text: string }
  | { number: number }
  | { date: string }
  | { boolean: boolean }
  | { optionIds: string[] }
  | { userIds: string[] };

const OPTION_TYPES: ReadonlySet<ApiPropertyType> = new Set<ApiPropertyType>(["select", "multi_select"]);

/** True for the two types whose definition carries an option list. */
export function hasOptions(type: ApiPropertyType): boolean {
  return OPTION_TYPES.has(type);
}

// ── Option JSON <-> typed ────────────────────────────────────────────────────

/**
 * The stored options column, read through a type guard. The column is `Json`, so
 * a row written by anything other than this module could be any shape: entries
 * that are not `{id, label}` strings are dropped rather than cast through.
 */
export function readOptions(json: Prisma.JsonValue | null | undefined): ApiPropertyOption[] | null {
  if (!Array.isArray(json)) return null;
  const out: ApiPropertyOption[] = [];
  for (const entry of json) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { id, label, color } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string") continue;
    out.push({ id, label, color: typeof color === "string" ? color : null });
  }
  return out;
}

type PropertyRow = Prisma.PmCustomPropertyGetPayload<object>;

function mapProperty(row: PropertyRow): ApiProperty {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    type: row.type,
    options: hasOptions(row.type) ? (readOptions(row.options) ?? []) : null,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ── Validators (pure) ────────────────────────────────────────────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isRealCalendarDate(s: string): boolean {
  if (!DATE_ONLY.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Validate and normalise an options list.
 *
 * `existing` is the field's current options (empty on create). An entry that
 * names an `id` must match one of them — the server mints ids, so an id the
 * server never issued is an error, not a hint. Ids are assigned here, so the
 * returned list is exactly what gets stored.
 */
export function validateOptions(
  raw: readonly PropertyOptionInput[],
  existing: readonly ApiPropertyOption[] = [],
): ApiPropertyOption[] {
  if (raw.length > OPTIONS_PER_PROPERTY_LIMIT) throw new Error(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
  const known = new Set(existing.map((o) => o.id));
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  const out: ApiPropertyOption[] = [];
  for (const entry of raw) {
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (label.length === 0 || label.length > OPTION_LABEL_MAX) {
      throw new Error(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
    }
    const folded = label.toLowerCase();
    if (seenLabels.has(folded)) throw new Error(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
    seenLabels.add(folded);

    let id = entry.id;
    if (id !== undefined) {
      if (!known.has(id) || seenIds.has(id)) throw new Error(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
    } else {
      id = randomUUID();
    }
    seenIds.add(id);

    const color = entry.color === undefined || entry.color === null ? null : entry.color;
    if (color !== null && (typeof color !== "string" || color.length === 0 || color.length > 32)) {
      throw new Error(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
    }
    out.push({ id, label, color });
  }
  return out;
}

const SHAPE_HINT: Record<ApiPropertyType, string> = {
  text: "Enter some text.",
  number: "Enter a number.",
  date: "Pick a date.",
  boolean: "Choose yes or no.",
  select: "Pick one of this field's options.",
  multi_select: "Pick from this field's options.",
  member: "Pick a person.",
};

/** The one key of a tagged value, or null when `raw` is not `{key: …}` alone. */
function taggedValue(raw: unknown, key: string): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const keys = Object.keys(raw);
  return keys.length === 1 && keys[0] === key ? (raw as Record<string, unknown>)[key] : undefined;
}

function idList(v: unknown): string[] | null {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)) {
    return null;
  }
  return v as string[];
}

/**
 * Validate `raw` against the field and return the value to store. Synchronous
 * and DB-free; the one check that needs a lookup (a member must be an ACTIVE
 * user) is `setPropertyValue`'s, after this.
 */
export function validateValue(
  property: { type: ApiPropertyType; options: readonly ApiPropertyOption[] | null },
  raw: unknown,
): PropertyValue {
  const wrongShape = () => new PropertyValueError(SHAPE_HINT[property.type]);
  switch (property.type) {
    case "text": {
      const v = taggedValue(raw, "text");
      if (typeof v !== "string") throw wrongShape();
      const text = v.trim();
      if (text.length === 0 || text.length > TEXT_VALUE_MAX) {
        throw new PropertyValueError(
          `Enter some text (up to ${TEXT_VALUE_MAX} characters), or clear the field.`,
        );
      }
      return { text };
    }
    case "number": {
      const v = taggedValue(raw, "number");
      if (typeof v !== "number") throw wrongShape();
      if (!Number.isFinite(v) || Math.abs(v) > NUMBER_VALUE_MAX) {
        throw new PropertyValueError("Enter a number between -1,000,000,000,000 and 1,000,000,000,000.");
      }
      return { number: v };
    }
    case "date": {
      const v = taggedValue(raw, "date");
      if (typeof v !== "string") throw wrongShape();
      if (!isRealCalendarDate(v)) throw new PropertyValueError("Enter a real date, like 2026-10-04.");
      return { date: v };
    }
    case "boolean": {
      const v = taggedValue(raw, "boolean");
      if (typeof v !== "boolean") throw wrongShape();
      return { boolean: v };
    }
    case "select":
    case "multi_select": {
      const ids = idList(taggedValue(raw, "optionIds"));
      if (!ids) throw wrongShape();
      const single = property.type === "select";
      if (single ? ids.length !== 1 : ids.length < 1 || ids.length > OPTIONS_PER_PROPERTY_LIMIT) {
        throw wrongShape();
      }
      if (new Set(ids).size !== ids.length) throw wrongShape();
      const have = new Set((property.options ?? []).map((o) => o.id));
      if (ids.some((id) => !have.has(id))) {
        throw new PropertyValueError("That option isn't available for this field.");
      }
      return { optionIds: ids };
    }
    case "member": {
      const ids = idList(taggedValue(raw, "userIds"));
      if (!ids || ids.length !== 1) throw wrongShape();
      return { userIds: ids };
    }
  }
}

/**
 * The text the activity feed shows for a value: option LABELS for selects (an
 * option id means nothing to a reader), user ids for members (the dashboard
 * resolves names), the plain value otherwise. Text is cut at 200 characters so a
 * pasted essay does not become an activity row.
 */
export function displayValue(
  property: { type: ApiPropertyType; options: readonly ApiPropertyOption[] | null },
  value: Prisma.JsonValue,
): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.text === "string") return v.text.slice(0, 200);
  if (typeof v.number === "number") return String(v.number);
  if (typeof v.date === "string") return v.date;
  if (typeof v.boolean === "boolean") return String(v.boolean);
  if (Array.isArray(v.optionIds)) {
    const labels = new Map((property.options ?? []).map((o) => [o.id, o.label]));
    return v.optionIds.map((id) => labels.get(String(id)) ?? String(id)).join(", ");
  }
  if (Array.isArray(v.userIds)) return v.userIds.map(String).join(",");
  return null;
}

/** Order-insensitive equality for two tagged values, so re-sending the same
 *  multi_select in another order is an identity write. */
function sameValue(a: Prisma.JsonValue, b: PropertyValue): boolean {
  const norm = (x: unknown): string =>
    JSON.stringify(x, (_k, v) => (Array.isArray(v) ? [...v].map(String).sort() : v));
  return norm(a) === norm(b);
}

// ── Activity ─────────────────────────────────────────────────────────────────

/** One `property_changed` row per entry, in ONE statement (this runs inside the
 *  lock-holding transaction, where every extra round trip lengthens the wait). */
async function writePropertyActivity(
  db: Db,
  actorId: string | null,
  rows: Array<{ workItemId: string; field: string; oldValue: string | null; newValue: string | null }>,
): Promise<void> {
  if (rows.length === 0) return;
  await db.pmActivity.createMany({
    data: rows.map((r) => ({
      workItemId: r.workItemId,
      actorId,
      verb: "property_changed" as const,
      field: r.field,
      oldValue: r.oldValue,
      newValue: r.newValue,
    })),
  });
}

// ── Locks ────────────────────────────────────────────────────────────────────

/** Row-lock the property and return it, or null when it does not exist. */
async function lockProperty(
  tx: Prisma.TransactionClient,
  propertyId: string,
  mode: "SHARE" | "UPDATE",
): Promise<ApiProperty | null> {
  const locked =
    mode === "UPDATE"
      ? await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "PmCustomProperty" WHERE "id" = ${propertyId} FOR UPDATE`
      : await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "PmCustomProperty" WHERE "id" = ${propertyId} FOR SHARE`;
  if (locked.length === 0) return null;
  // Re-read AFTER the lock: under READ COMMITTED this sees whatever the
  // transaction that held the lock before us committed.
  const row = await tx.pmCustomProperty.findUnique({
    where: { id: propertyId },
    include: { project: { select: { kind: true } } },
  });
  return row && !isServiceDesk(row.project) ? mapProperty(row) : null;
}

// ── Definitions ──────────────────────────────────────────────────────────────

export async function listProperties(prisma: PrismaClient, projectId: string): Promise<ApiProperty[]> {
  const project = await prisma.pmProject.findUnique({ where: { id: projectId }, select: { id: true, kind: true } });
  if (!project || isServiceDesk(project)) throw new Error(PM_PROPERTY_ERRORS.PROJECT_NOT_FOUND);
  const rows = await prisma.pmCustomProperty.findMany({
    where: { projectId },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(mapProperty);
}

export async function createProperty(
  prisma: PrismaClient,
  projectId: string,
  input: { name: string; type: ApiPropertyType; options?: readonly PropertyOptionInput[] | null },
): Promise<ApiProperty> {
  // Options belong to select fields and ONLY to them; a select field must say
  // its (possibly empty) list. Both are checked before any write.
  let options: ApiPropertyOption[] | null = null;
  if (hasOptions(input.type)) {
    if (input.options === undefined || input.options === null) {
      throw new Error(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
    }
    options = validateOptions(input.options);
  } else if (input.options !== undefined && input.options !== null) {
    throw new Error(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Serialize definition creation for this project. Without the parent-row
      // lock, two requests at 29 fields can both pass the cap check and choose
      // the same next sortOrder before either insert commits.
      const project = await tx.$queryRaw<Array<{ id: string; kind: "PROJECT" | "SERVICE_DESK" }>>`
        SELECT "id", "kind" FROM "PmProject" WHERE "id" = ${projectId} FOR UPDATE
      `;
      if (project.length === 0 || isServiceDesk(project[0])) throw new Error(PM_PROPERTY_ERRORS.PROJECT_NOT_FOUND);

      const count = await tx.pmCustomProperty.count({ where: { projectId } });
      if (count >= PROPERTIES_PER_PROJECT_LIMIT) throw new Error(PM_PROPERTY_ERRORS.PROPERTY_LIMIT_REACHED);
      const last = await tx.pmCustomProperty.aggregate({ where: { projectId }, _max: { sortOrder: true } });
      const row = await tx.pmCustomProperty.create({
        data: {
          projectId,
          name: input.name,
          type: input.type,
          options: options === null ? Prisma.DbNull : (options as unknown as Prisma.InputJsonValue),
          sortOrder: (last._max.sortOrder ?? -1) + 1,
        },
      });
      return mapProperty(row);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new Error(PM_PROPERTY_ERRORS.PROPERTY_NAME_TAKEN);
    throw err;
  }
}

/** Structural P2002 check (matches the real error and the repo's test stand-ins). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "P2002";
}

export async function updateProperty(
  prisma: PrismaClient,
  actorId: string | null,
  propertyId: string,
  patch: { name?: string; options?: readonly PropertyOptionInput[]; sortOrder?: number },
): Promise<ApiProperty> {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await lockProperty(tx, propertyId, "UPDATE");
      if (!existing) throw new Error(PM_PROPERTY_ERRORS.PROPERTY_NOT_FOUND);

      let replacementOptions: ApiPropertyOption[] | null = null;
      let removed: ApiPropertyOption[] = [];
      if (patch.options !== undefined) {
        if (!hasOptions(existing.type)) throw new Error(PM_PROPERTY_ERRORS.INVALID_OPTIONS);
        replacementOptions = validateOptions(patch.options, existing.options ?? []);
        const keep = new Set(replacementOptions.map((o) => o.id));
        removed = (existing.options ?? []).filter((o) => !keep.has(o.id));
      }

      const row = await tx.pmCustomProperty.update({
        where: { id: propertyId },
        data: {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.sortOrder !== undefined ? { sortOrder: patch.sortOrder } : {}),
          ...(replacementOptions !== null ? { options: replacementOptions as unknown as Prisma.InputJsonValue } : {}),
        },
      });

      if (removed.length > 0) {
        await clearRemovedOptions(tx, actorId, existing, replacementOptions ?? [], removed);
      }
      return mapProperty(row);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new Error(PM_PROPERTY_ERRORS.PROPERTY_NAME_TAKEN);
    throw err;
  }
}

/**
 * Take `removed` out of every value that holds one, in the caller's transaction.
 * A value that ends up with no options is DELETED (a select with nothing chosen
 * is "no value", never an empty tag); the rest are rewritten without the removed
 * ids. One activity row per affected item, naming the field and the labels.
 */
async function clearRemovedOptions(
  tx: Prisma.TransactionClient,
  actorId: string | null,
  property: ApiProperty,
  remaining: readonly ApiPropertyOption[],
  removed: readonly ApiPropertyOption[],
): Promise<void> {
  const gone = new Set(removed.map((o) => o.id));
  const rows = await tx.pmWorkItemPropertyValue.findMany({
    where: { propertyId: property.id },
    select: { id: true, workItemId: true, value: true },
  });
  const deleteIds: string[] = [];
  const activity: Array<{ workItemId: string; field: string; oldValue: string | null; newValue: string | null }> = [];
  for (const row of rows) {
    const v = row.value;
    const ids =
      v !== null && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as Record<string, unknown>).optionIds)
        ? ((v as Record<string, unknown>).optionIds as unknown[]).map(String)
        : [];
    const kept = ids.filter((id) => !gone.has(id));
    if (kept.length === ids.length) continue;
    const trimmedValue: PropertyValue = { optionIds: kept };
    if (kept.length === 0) {
      deleteIds.push(row.id);
    } else {
      await tx.pmWorkItemPropertyValue.update({ where: { id: row.id }, data: { value: trimmedValue } });
    }
    activity.push({
      workItemId: row.workItemId,
      field: property.name,
      // Old labels come from the options as they WERE; new from what remains.
      oldValue: displayValue(property, v),
      newValue: kept.length === 0 ? null : displayValue({ type: property.type, options: remaining }, trimmedValue),
    });
  }
  if (deleteIds.length > 0) await tx.pmWorkItemPropertyValue.deleteMany({ where: { id: { in: deleteIds } } });
  await writePropertyActivity(tx, actorId, activity);
}

export async function deleteProperty(
  prisma: PrismaClient,
  actorId: string | null,
  propertyId: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existing = await lockProperty(tx, propertyId, "UPDATE");
    if (!existing) throw new Error(PM_PROPERTY_ERRORS.PROPERTY_NOT_FOUND);
    // The values cascade with the property, and their items' own histories must
    // still explain the disappearance: the audit rows go in BEFORE the delete,
    // in the same transaction (the WARP-885 discipline for every cascade).
    const values = await tx.pmWorkItemPropertyValue.findMany({
      where: { propertyId },
      select: { workItemId: true, value: true },
    });
    await writePropertyActivity(
      tx,
      actorId,
      values.map((v) => ({
        workItemId: v.workItemId,
        field: existing.name,
        oldValue: displayValue(existing, v.value),
        newValue: null,
      })),
    );
    await tx.pmCustomProperty.delete({ where: { id: propertyId } });
  });
}

/** Set the field order in ONE request — every field exactly once, as states do. */
export async function reorderProperties(
  prisma: PrismaClient,
  projectId: string,
  propertyIds: readonly string[],
): Promise<ApiProperty[]> {
  const project = await prisma.pmProject.findUnique({ where: { id: projectId }, select: { id: true, kind: true } });
  if (!project || isServiceDesk(project)) throw new Error(PM_PROPERTY_ERRORS.PROJECT_NOT_FOUND);
  const current = await prisma.pmCustomProperty.findMany({ where: { projectId }, select: { id: true } });
  const have = new Set(current.map((p) => p.id));
  if (
    propertyIds.length !== have.size ||
    new Set(propertyIds).size !== propertyIds.length ||
    propertyIds.some((id) => !have.has(id))
  ) {
    throw new Error(PM_PROPERTY_ERRORS.INVALID_ORDER);
  }
  await prisma.$transaction(async (tx) => {
    for (const [index, id] of propertyIds.entries()) {
      await tx.pmCustomProperty.update({ where: { id }, data: { sortOrder: index } });
    }
  });
  return listProperties(prisma, projectId);
}

// ── Values ───────────────────────────────────────────────────────────────────

/** The project of a work item, or WORK_ITEM_NOT_FOUND. */
async function itemProject(db: Db, itemId: string): Promise<string> {
  const item = await db.pmWorkItem.findUnique({
    where: { id: itemId },
    select: { projectId: true, project: { select: { kind: true } } },
  });
  if (!item || isServiceDesk(item.project)) throw new Error(PM_PROPERTY_ERRORS.WORK_ITEM_NOT_FOUND);
  return item.projectId;
}

/**
 * Set (create or replace) an item's value for one field.
 *
 * A field of ANOTHER project is `property_not_found` — the same answer as a
 * field that does not exist, so a caller cannot probe other projects' fields by
 * id. An identical value writes nothing, including no activity row.
 */
export async function setPropertyValue(
  prisma: PrismaClient,
  actorId: string | null,
  itemId: string,
  propertyId: string,
  raw: unknown,
): Promise<ApiWorkItem> {
  const projectId = await itemProject(prisma, itemId);
  await prisma.$transaction(async (tx) => {
    const property = await lockProperty(tx, propertyId, "SHARE");
    if (!property || property.projectId !== projectId) {
      throw new Error(PM_PROPERTY_ERRORS.PROPERTY_NOT_FOUND);
    }
    const value = validateValue(property, raw);
    if (property.type === "member") {
      const userId = (value as { userIds: string[] }).userIds[0];
      const user = await tx.user.findFirst({
        where: { id: userId, directoryStatus: "ACTIVE" },
        select: { id: true },
      });
      if (!user) throw new PropertyValueError("That person isn't an active member.");
    }

    const existing = await tx.pmWorkItemPropertyValue.findUnique({
      where: { workItemId_propertyId: { workItemId: itemId, propertyId } },
      select: { value: true },
    });
    if (existing && sameValue(existing.value, value)) return;

    await tx.pmWorkItemPropertyValue.upsert({
      where: { workItemId_propertyId: { workItemId: itemId, propertyId } },
      create: { workItemId: itemId, propertyId, value: value as unknown as Prisma.InputJsonValue },
      update: { value: value as unknown as Prisma.InputJsonValue },
    });
    await writePropertyActivity(tx, actorId, [
      {
        workItemId: itemId,
        field: property.name,
        oldValue: existing ? displayValue(property, existing.value) : null,
        newValue: displayValue(property, value as unknown as Prisma.JsonValue),
      },
    ]);
  });
  return getWorkItem(prisma, itemId);
}

/** Clear an item's value for one field. Clearing what is not set is a no-op. */
export async function clearPropertyValue(
  prisma: PrismaClient,
  actorId: string | null,
  itemId: string,
  propertyId: string,
): Promise<ApiWorkItem> {
  const projectId = await itemProject(prisma, itemId);
  await prisma.$transaction(async (tx) => {
    const property = await lockProperty(tx, propertyId, "SHARE");
    if (!property || property.projectId !== projectId) {
      throw new Error(PM_PROPERTY_ERRORS.PROPERTY_NOT_FOUND);
    }
    const existing = await tx.pmWorkItemPropertyValue.findUnique({
      where: { workItemId_propertyId: { workItemId: itemId, propertyId } },
      select: { id: true, value: true },
    });
    if (!existing) return;
    await tx.pmWorkItemPropertyValue.delete({ where: { id: existing.id } });
    await writePropertyActivity(tx, actorId, [
      { workItemId: itemId, field: property.name, oldValue: displayValue(property, existing.value), newValue: null },
    ]);
  });
  return getWorkItem(prisma, itemId);
}
