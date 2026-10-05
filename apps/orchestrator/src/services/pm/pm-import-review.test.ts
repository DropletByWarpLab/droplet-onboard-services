import { beforeEach, describe, expect, it, vi } from "vitest";

const kick = vi.hoisted(() => vi.fn());
vi.mock("./import/runner.js", () => ({ kickImportRunner: kick }));
vi.mock("./pm.service.js", async () => ({
  ...(await vi.importActual<typeof import("./pm.service.js")>("./pm.service.js")),
  getProject: vi.fn(async () => ({ id: "p1" })),
}));

import { startImportJob } from "./pm-import.service.js";

const reviewedAt = "2026-10-05T20:00:00.123Z";
function fixture(status: "PREVIEWED" | "FAILED" = "PREVIEWED") {
  const row = {
    id: "j1", projectId: "p1", source: "GENERIC_CSV", status,
    mapping: { createMissingStates: false }, stats: null, error: null,
    fileName: "board.csv", fileBytes: 8, createdById: "u1",
    createdAt: new Date(reviewedAt), updatedAt: new Date(reviewedAt), startedAt: null, finishedAt: null,
  };
  const prisma = {
    pmImportJob: {
      findUnique: vi.fn(async () => row),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    pmImportJobFile: { findUnique: vi.fn(async () => ({ bytes: Buffer.from("Title\nA\n") })) },
  };
  return { row, prisma };
}

beforeEach(() => vi.clearAllMocks());

describe("reviewed import run", () => {
  it("refuses an already changed review before loading bytes or updating the job", async () => {
    const { row, prisma } = fixture();
    row.updatedAt = new Date("2026-10-05T20:00:00.124Z");
    await expect(startImportJob(prisma as never, "j1", { expectedUpdatedAt: reviewedAt })).rejects.toThrow("import_changed");
    expect(prisma.pmImportJobFile.findUnique).not.toHaveBeenCalled();
    expect(prisma.pmImportJob.updateMany).not.toHaveBeenCalled();
    expect(kick).not.toHaveBeenCalled();
  });

  it.each(["PREVIEWED", "FAILED"] as const)("binds %s to the exact timestamp and rejects a concurrent edit before kicking", async (status) => {
    const { prisma } = fixture(status);
    prisma.pmImportJob.updateMany.mockResolvedValue({ count: 0 });
    await expect(startImportJob(prisma as never, "j1", { expectedUpdatedAt: reviewedAt })).rejects.toThrow("import_changed");
    expect(prisma.pmImportJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "j1", status, updatedAt: new Date(reviewedAt) },
    }));
    expect(kick).not.toHaveBeenCalled();
  });

  it("accepts a current reviewed job and keeps callers without a precondition compatible", async () => {
    const { prisma } = fixture();
    await startImportJob(prisma as never, "j1", { expectedUpdatedAt: reviewedAt });
    expect(kick).toHaveBeenCalledTimes(1);
    await startImportJob(prisma as never, "j1");
    expect(prisma.pmImportJob.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: "j1", status: "PREVIEWED" } }));
    expect(kick).toHaveBeenCalledTimes(2);
  });
});
