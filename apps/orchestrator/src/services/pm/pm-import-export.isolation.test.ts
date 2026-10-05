/** A Projects grant cannot read, queue, cancel, or export a Service Desk container. */
import { describe, expect, it, vi } from "vitest";
import type { PmImportJob } from "@prisma/client";
import { cancelImportJob, createImportJob, getImportJob, listImportJobs, startImportJob, updateImportJob } from "./pm-import.service.js";
import { exportCsvChunks, exportJsonChunks } from "./pm-export.service.js";
import { loadPlanContext } from "./import/context.js";
import { claimJob, executeImportJob } from "./import/runner.js";

function desk() {
  const forbidden = vi.fn(() => { throw new Error("desk child data was touched"); });
  const job = { id: "desk-job", projectId: "desk", status: "PREVIEWED", source: "CSV" } as PmImportJob;
  const prisma = {
    pmProject: { findUnique: vi.fn(async () => ({ id: "desk", kind: "SERVICE_DESK" })) },
    pmImportJob: { findUnique: vi.fn(async () => job), findMany: forbidden, updateMany: forbidden },
    pmImportJobFile: { findUnique: forbidden, deleteMany: forbidden },
    pmState: { findMany: forbidden }, pmLabel: { findMany: forbidden },
    pmCustomProperty: { findMany: forbidden }, pmWorkItem: { findMany: forbidden },
    user: { findMany: forbidden }, $transaction: forbidden,
  };
  return { prisma: prisma as never, forbidden, job };
}

describe("native project boundary", () => {
  it.each(["csv", "json"] as const)("%s export rejects before yielding a byte or reading children", async (format) => {
    const f = desk();
    const stream = format === "csv" ? exportCsvChunks(f.prisma, "desk") : exportJsonChunks(f.prisma, "desk");
    await expect(stream.next()).rejects.toThrow("project_not_found");
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it("upload, list and plan context reject a desk before parsing files or resolving people", async () => {
    const f = desk();
    await expect(createImportJob(f.prisma, "owner", "desk", { fileName: "private.csv", buffer: Buffer.from("invalid") })).rejects.toThrow("project_not_found");
    await expect(listImportJobs(f.prisma, "desk")).rejects.toThrow("project_not_found");
    await expect(loadPlanContext(f.prisma, "desk")).rejects.toThrow("project_not_found");
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it.each(["read", "update", "start", "cancel"] as const)("%s treats a desk job like a missing job without any write or file read", async (op) => {
    const f = desk();
    const operations = {
      read: () => getImportJob(f.prisma, f.job.id), update: () => updateImportJob(f.prisma, f.job.id, {}),
      start: () => startImportJob(f.prisma, f.job.id, {}, { kick: false }), cancel: () => cancelImportJob(f.prisma, f.job.id),
    };
    await expect(operations[op]()).rejects.toThrow("import_job_not_found");
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it("a directly invoked stale runner refuses a desk before file reads, job writes or audit events", async () => {
    const f = desk();
    await expect(executeImportJob(f.prisma, f.job)).rejects.toThrow("project_not_found");
    expect(f.forbidden).not.toHaveBeenCalled();
  });

  it("the queue only claims native Project jobs", async () => {
    const writes = vi.fn(async () => ({ count: 1 }));
    const hidden = { id: "desk-job", projectId: "desk", status: "PENDING" };
    const prisma = { pmImportJob: {
      findFirst: vi.fn(async ({ where }: { where: { project?: { kind?: string } } }) => where.project?.kind === "PROJECT" ? null : hidden),
      updateMany: writes,
    } };
    expect(await claimJob(prisma as never)).toBeNull();
    expect(writes).not.toHaveBeenCalled();
  });

  it("a native Project JSON export includes native relations but neither direction of a desk escalation", async () => {
    const now = new Date("2026-10-04T10:00:00Z");
    const item = (id: string, kind: string, identifier: string) => ({ id, projectId: id === "native" ? "p" : "other", sequenceId: 1, project: { kind, identifier } });
    const native = item("native", "PROJECT", "ENG");
    const other = item("other", "PROJECT", "OPS");
    const ticket = item("ticket", "SERVICE_DESK", "PRIVATE-DESK");
    const rels = [
      { id: "r1", from: native, to: other }, { id: "r2", from: native, to: ticket }, { id: "r3", from: ticket, to: native },
    ].map((r) => ({ ...r, kind: "relates_to", createdAt: now }));
    const prisma = {
      pmProject: { findUnique: async () => ({ id: "p", kind: "PROJECT", identifier: "ENG", createdAt: now }) },
      pmState: { findMany: async () => [] }, pmLabel: { findMany: async () => [] },
      pmCustomProperty: { findMany: async () => [] }, pmWorkItem: { findMany: async () => [] },
      pmWorkItemRelation: { findMany: async ({ where }: { where: { from?: { project: { kind: string } }; to?: { project: { kind: string } } } }) =>
        rels.filter((r) => (!where.from || r.from.project.kind === where.from.project.kind) && (!where.to || r.to.project.kind === where.to.project.kind)),
      },
    };
    let text = "";
    for await (const chunk of exportJsonChunks(prisma as never, "p")) text += chunk;
    const exported = JSON.parse(text);
    expect(exported.relations.map((r: { id: string }) => r.id)).toEqual(["r1"]);
    expect(text).not.toContain("PRIVATE-DESK");
    expect(text).not.toContain("ticket");
  });
});
