/** In-memory stand-in for the two tables the MCP sign-in touches, with the migration's CHECKs enforced. */
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

type Row = any;
const matches = (r: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([k, v]) =>
    v !== null && typeof v === "object" && "not" in v ? r[k] !== v.not : r[k] === v);

export function fakeMcpOAuthDb(integration: Row | null = null) {
  const rows: Row[] = [];
  const check = (r: Row) => {
    if ((r.scope === "MEMBER") !== (r.memberId !== null)) throw new Error("owner_check");
    if (r.scope === "WORKSPACE" && (!r.workspaceAckAt || !r.workspaceAckBy)) throw new Error("workspace_ack_check");
    if (r.state === "CONNECTED" && !r.tokensEnc) throw new Error("connected_token_check");
  };
  const t = {
    findFirst: async ({ where }: { where?: Row }) => rows.find((r) => matches(r, where)) ?? null,
    findUnique: async ({ where }: { where: Row }) => rows.find((r) => matches(r, where)) ?? null,
    findMany: async ({ where }: { where?: Row }) => rows.filter((r) => matches(r, where)),
    create: async ({ data }: { data: Row }) => {
      const r: Row = {
        id: randomUUID(), state: "DISCONNECTED", memberId: null, clientId: null, clientSecretEnc: null, tokensEnc: null,
        workspaceAckAt: null, workspaceAckBy: null, connectedAt: null, lastRefreshOkAt: null, tokenExpiresAt: null,
        lastError: null, createdAt: new Date(), ...data,
      };
      check(r);
      if (rows.some((x) => x.provider === r.provider && x.scope === "WORKSPACE" && r.scope === "WORKSPACE")) throw new Error("unique");
      if (r.scope === "MEMBER" && rows.some((x) => x.provider === r.provider && x.memberId === r.memberId)) throw new Error("unique");
      rows.push(r);
      return r;
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const r = rows.find((x) => matches(x, where));
      if (!r) throw new Error("not_found");
      const next = { ...r, ...data };
      check(next);
      Object.assign(r, next);
      return r;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((x) => matches(x, where));
      for (const r of hit) { const next = { ...r, ...data }; check(next); Object.assign(r, next); }
      return { count: hit.length };
    },
  };
  const prisma = {
    mcpOAuthConnection: t,
    integrationConnection: { findFirst: async () => integration },
  } as unknown as PrismaClient;
  return { prisma, rows, seed: (r: Row) => t.create({ data: r }) };
}
