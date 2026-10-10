/**
 * WARP-3962 — a map-backed stand-in for the one Prisma model the remote-tool
 * classification record uses, with just the query shapes the permission code
 * issues (findUnique, findMany by serverId/grade, upsert, updateMany by
 * serverId + toolName|{in} + grade + definitionStatus + inputSchemaHash).
 */
import type {
  ClassificationPrisma,
  RemoteToolClassificationRow,
} from "../../services/remote-tool-classification.service.js";

type Where = {
  serverId?: string;
  toolName?: string | { in: string[] };
  grade?: string;
  definitionStatus?: string;
  inputSchemaHash?: string | null;
};

export function fakeClassificationPrisma() {
  const rows = new Map<string, RemoteToolClassificationRow>();
  const key = (s: string, t: string) => `${s}|${t}`;
  const matches = (r: RemoteToolClassificationRow, w: Where): boolean =>
    (w.serverId === undefined || r.serverId === w.serverId) &&
    (w.toolName === undefined ||
      (typeof w.toolName === "string" ? r.toolName === w.toolName : w.toolName.in.includes(r.toolName))) &&
    (w.grade === undefined || r.grade === w.grade) &&
    (w.definitionStatus === undefined || (r.definitionStatus ?? "CURRENT") === w.definitionStatus) &&
    (!("inputSchemaHash" in w) || (r.inputSchemaHash ?? null) === w.inputSchemaHash);
  const model = {
    findUnique: async ({ where }: { where: { serverId_toolName: { serverId: string; toolName: string } } }) =>
      rows.get(key(where.serverId_toolName.serverId, where.serverId_toolName.toolName)) ?? null,
    findMany: async ({ where }: { where?: Where } = {}) => [...rows.values()].filter((r) => matches(r, where ?? {})),
    upsert: async ({
      where,
      create,
      update,
    }: {
      where: { serverId_toolName: { serverId: string; toolName: string } };
      create: Partial<RemoteToolClassificationRow>;
      update: Partial<RemoteToolClassificationRow>;
    }) => {
      const k = key(where.serverId_toolName.serverId, where.serverId_toolName.toolName);
      const next = (
        rows.has(k)
          ? { ...rows.get(k)!, ...update }
          : { reviewedBy: null, reviewedAt: null, definitionStatus: "CURRENT", grade: "WRITE", ...create }
      ) as RemoteToolClassificationRow;
      rows.set(k, next);
      return next;
    },
    update: async ({
      where,
      data,
    }: {
      where: { serverId_toolName: { serverId: string; toolName: string } };
      data: Partial<RemoteToolClassificationRow>;
    }) => {
      const k = key(where.serverId_toolName.serverId, where.serverId_toolName.toolName);
      const next = { ...rows.get(k)!, ...data };
      rows.set(k, next);
      return next;
    },
    updateMany: async ({ where, data }: { where: Where; data: Partial<RemoteToolClassificationRow> }) => {
      let count = 0;
      for (const [k, r] of rows) {
        if (!matches(r, where)) continue;
        rows.set(k, { ...r, ...data });
        count++;
      }
      return { count };
    },
  };
  return { prisma: { remoteToolClassification: model } as unknown as ClassificationPrisma, rows, key };
}
