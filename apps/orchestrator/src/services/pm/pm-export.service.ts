/**
 * WARP-3527 (ADR-069 WS-11) — project export, as streams.
 *
 * Both exports are async generators of string chunks, so the route writes each
 * chunk as it is produced and a 20,000-item project never exists in memory as
 * one string or one array: items are read a page at a time and everything a
 * page needs (people, parent keys, comments, relations) is fetched for the
 * PAGE in one batched query, never per item.
 *
 *   CSV  — what the board shows, narrowed by the SAME filters the work-item
 *          list takes (state, assignee, label, priority, department, text), via
 *          the same `listWorkItems`: the filters cannot drift from the list's.
 *          Archived items are not on the board and so not in the CSV. The
 *          columns are chosen so the file re-imports through the generic CSV
 *          preset: `key` is the id, `parent_key` the parent.
 *   JSON — the whole project, archived items included: states, labels, custom
 *          fields, items (with comments, attachment METADATA and field values)
 *          and relations. Never an attachment's bytes.
 *
 * People are written as display names, not emails: export is open to any
 * reader and the directory's emails are not.
 */

import type { PrismaClient } from "@prisma/client";
import { CSV_BOM, csvLine } from "./import/csv.js";
import * as pm from "./pm.service.js";

export const EXPORT_PAGE = 200;
/** A runaway guard, not a limit anyone should meet (1,000,000 items). */
const MAX_PAGES = 5000;

const day = (d: Date | string | null): string => (d ? new Date(d).toISOString().slice(0, 10) : "");
const stamp = (d: Date | string | null): string => (d ? new Date(d).toISOString() : "");

export const CSV_HEADERS = [
  "key",
  "title",
  "description",
  "state",
  "state_group",
  "priority",
  "assignees",
  "labels",
  "parent_key",
  "start_date",
  "due_date",
  "created_at",
  "updated_at",
  "completed_at",
  "department",
  "created_by",
  "external_system",
  "external_id",
] as const;

export interface ExportFilters {
  stateId?: string;
  assignee?: string;
  labelId?: string;
  priority?: pm.ApiWorkItem["priority"];
  departmentId?: string | null;
  q?: string;
}

/** Description HTML → readable plain text (paragraphs, breaks and list items kept). */
export function htmlToText(html: string | null): string {
  if (!html) return "";
  const text = html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|h[1-3]|blockquote|pre)>/gi, "\n\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** User id → display name, one batched read per page, remembered across pages. */
class PeopleNames {
  private readonly cache = new Map<string, string>();
  constructor(private readonly prisma: PrismaClient) {}

  async load(ids: Iterable<string>): Promise<void> {
    const missing = [...new Set(ids)].filter((id) => !this.cache.has(id));
    if (missing.length === 0) return;
    const rows = await this.prisma.user.findMany({
      where: { id: { in: missing } },
      select: { id: true, displayName: true },
    });
    for (const r of rows) this.cache.set(r.id, r.displayName);
    // an id with no user row is a former member, and is remembered as one
    for (const id of missing) if (!this.cache.has(id)) this.cache.set(id, "Former member");
  }

  name(id: string | null): string {
    return id ? (this.cache.get(id) ?? "Former member") : "";
  }
}

export async function* exportCsvChunks(
  prisma: PrismaClient,
  projectId: string,
  filters: ExportFilters = {},
): AsyncGenerator<string> {
  const project = await pm.getProject(prisma, projectId);
  const people = new PeopleNames(prisma);
  const keyById = new Map<string, string>();

  yield CSV_BOM + csvLine(CSV_HEADERS);

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const items = await pm.listWorkItems(prisma, projectId, { ...filters, perPage: EXPORT_PAGE, page });
    if (items.length === 0) return;
    for (const it of items) keyById.set(it.id, it.key);

    // parents that sit on another page: one query for the whole page
    const unknownParents = [...new Set(items.flatMap((i) => (i.parentId && !keyById.has(i.parentId) ? [i.parentId] : [])))];
    if (unknownParents.length > 0) {
      const rows = await prisma.pmWorkItem.findMany({
        where: { id: { in: unknownParents } },
        select: { id: true, sequenceId: true },
      });
      for (const r of rows) keyById.set(r.id, `${project.identifier}-${r.sequenceId}`);
    }
    await people.load(items.flatMap((i) => [...i.assignees, ...(i.createdById ? [i.createdById] : [])]));
    // provenance of imported items: not on the API shape, so one batched read per page
    const provenance = new Map(
      (
        await prisma.pmWorkItem.findMany({
          where: { id: { in: items.map((i) => i.id) } },
          select: { id: true, externalSystem: true, externalId: true },
        })
      ).map((r) => [r.id, r]),
    );

    let out = "";
    for (const it of items) {
      out += csvLine([
        it.key,
        it.name,
        htmlToText(it.descriptionHtml),
        it.state?.name ?? "",
        it.state?.group ?? "",
        it.priority,
        it.assignees.map((a) => people.name(a)).join(", "),
        it.labels.map((l) => l.name).join(", "),
        it.parentId ? (keyById.get(it.parentId) ?? "") : "",
        day(it.startDate),
        day(it.dueDate),
        stamp(it.createdAt),
        stamp(it.updatedAt),
        stamp(it.completedAt),
        it.department?.name ?? "",
        people.name(it.createdById),
        provenance.get(it.id)?.externalSystem ?? "",
        provenance.get(it.id)?.externalId ?? "",
      ]);
    }
    yield out;
    if (items.length < EXPORT_PAGE) return;
  }
}

export async function* exportJsonChunks(prisma: PrismaClient, projectId: string): AsyncGenerator<string> {
  const project = await prisma.pmProject.findUnique({
    where: { id: projectId },
    include: { department: { select: { name: true } } },
  });
  if (!project) throw new Error(pm.PM_ERRORS.PROJECT_NOT_FOUND);

  const [states, labels, fields] = await Promise.all([
    prisma.pmState.findMany({ where: { projectId }, orderBy: { sortOrder: "asc" } }),
    prisma.pmLabel.findMany({ where: { projectId }, orderBy: { name: "asc" } }),
    prisma.pmCustomProperty.findMany({ where: { projectId }, orderBy: { sortOrder: "asc" } }),
  ]);
  const people = new PeopleNames(prisma);

  yield (
    `{"format":"droplet.pm.export","version":1,"exportedAt":${JSON.stringify(new Date().toISOString())},` +
    `"project":${JSON.stringify({
      id: project.id,
      name: project.name,
      identifier: project.identifier,
      description: project.description,
      icon: project.icon,
      color: project.color,
      leadId: project.leadId,
      department: project.department?.name ?? null,
      archived: project.isArchived,
      createdAt: stamp(project.createdAt),
    })},` +
    `"states":${JSON.stringify(
      states.map((s) => ({ id: s.id, name: s.name, group: s.group, color: s.color, sortOrder: s.sortOrder, isDefault: s.isDefault })),
    )},` +
    `"labels":${JSON.stringify(labels.map((l) => ({ id: l.id, name: l.name, color: l.color })))},` +
    `"fields":${JSON.stringify(fields.map((f) => ({ id: f.id, name: f.name, type: f.type, options: f.options, sortOrder: f.sortOrder })))},` +
    `"items":[`
  );

  const keyById = new Map<string, string>();
  let lastSeq = 0;
  let first = true;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = await prisma.pmWorkItem.findMany({
      where: { projectId, sequenceId: { gt: lastSeq } },
      orderBy: { sequenceId: "asc" },
      take: EXPORT_PAGE,
      include: {
        state: true,
        assignees: true,
        labels: { include: { label: true } },
        department: { select: { name: true } },
        comments: { orderBy: { createdAt: "asc" } },
        attachments: { select: { id: true, fileName: true, mimeType: true, sizeBytes: true, uploadedById: true, createdAt: true } },
        propertyValues: true,
      },
    });
    if (rows.length === 0) break;
    lastSeq = rows[rows.length - 1].sequenceId;
    for (const r of rows) keyById.set(r.id, `${project.identifier}-${r.sequenceId}`);
    const unknownParents = [...new Set(rows.flatMap((r) => (r.parentId && !keyById.has(r.parentId) ? [r.parentId] : [])))];
    if (unknownParents.length > 0) {
      const parents = await prisma.pmWorkItem.findMany({
        where: { id: { in: unknownParents } },
        select: { id: true, sequenceId: true },
      });
      for (const p of parents) keyById.set(p.id, `${project.identifier}-${p.sequenceId}`);
    }
    await people.load(
      rows.flatMap((r) => [
        ...r.assignees.map((a) => a.userId),
        ...(r.createdById ? [r.createdById] : []),
        ...r.comments.flatMap((c) => (c.authorId ? [c.authorId] : [])),
      ]),
    );

    const parts = rows.map((r) =>
      JSON.stringify({
        id: r.id,
        key: keyById.get(r.id),
        sequenceId: r.sequenceId,
        name: r.name,
        descriptionHtml: r.descriptionHtml,
        state: r.state ? { id: r.state.id, name: r.state.name, group: r.state.group } : null,
        priority: r.priority,
        parentKey: r.parentId ? (keyById.get(r.parentId) ?? null) : null,
        assignees: r.assignees.map((a) => ({ id: a.userId, name: people.name(a.userId) })),
        labels: r.labels.map((l) => l.label.name),
        department: r.department?.name ?? null,
        startDate: day(r.startDate) || null,
        dueDate: day(r.dueDate) || null,
        createdAt: stamp(r.createdAt),
        updatedAt: stamp(r.updatedAt),
        completedAt: r.completedAt ? stamp(r.completedAt) : null,
        archived: r.isArchived,
        createdBy: r.createdById ? { id: r.createdById, name: people.name(r.createdById) } : null,
        externalSystem: r.externalSystem,
        externalId: r.externalId,
        comments: r.comments.map((c) => ({
          id: c.id,
          authorId: c.authorId,
          authorName: c.authorId ? people.name(c.authorId) : null,
          commentHtml: c.commentHtml,
          createdAt: stamp(c.createdAt),
        })),
        // metadata only — never the bytes
        attachments: r.attachments.map((a) => ({
          id: a.id,
          fileName: a.fileName,
          mimeType: a.mimeType,
          sizeBytes: Number(a.sizeBytes),
          createdAt: stamp(a.createdAt),
        })),
        fieldValues: Object.fromEntries(r.propertyValues.map((v) => [v.propertyId, v.value])),
      }),
    );
    yield (first ? "" : ",") + parts.join(",");
    first = false;
    if (rows.length < EXPORT_PAGE) break;
  }

  yield `],"relations":[`;
  let afterId = "";
  let firstRel = true;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rels = await prisma.pmWorkItemRelation.findMany({
      where: {
        OR: [{ from: { projectId } }, { to: { projectId } }],
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: "asc" },
      take: 500,
      include: {
        from: { select: { id: true, sequenceId: true, project: { select: { identifier: true } } } },
        to: { select: { id: true, sequenceId: true, project: { select: { identifier: true } } } },
      },
    });
    if (rels.length === 0) break;
    afterId = rels[rels.length - 1].id;
    const parts = rels.map((r) =>
      JSON.stringify({
        id: r.id,
        kind: r.kind,
        from: { id: r.from.id, key: `${r.from.project.identifier}-${r.from.sequenceId}` },
        to: { id: r.to.id, key: `${r.to.project.identifier}-${r.to.sequenceId}` },
        createdAt: stamp(r.createdAt),
      }),
    );
    yield (firstRel ? "" : ",") + parts.join(",");
    firstRel = false;
    if (rels.length < 500) break;
  }
  yield "]}";
}
