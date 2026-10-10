/**
 * In-memory stand-in for the tables the MCP sign-in touches (connections, users and
 * the admin-owned integration row), with the migration's CHECKs enforced.
 */
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

type Row = any;

/** Evaluates the subset of Prisma `where` the sign-in code uses: equality, not, lt, in, OR, and `member: { is }`. */
const matches = (r: Row, where: Row = {}, users: Row[] = []): boolean =>
  Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as Row[]).some((w) => matches(r, w, users));
    if (k === "member") {
      const u = users.find((x) => x.id === r.memberId);
      return !!u && matches(u, v.is, users);
    }
    if (v !== null && typeof v === "object" && "not" in v) return r[k] !== v.not;
    if (v !== null && typeof v === "object" && "lt" in v) return r[k] instanceof Date && r[k] < v.lt;
    if (v !== null && typeof v === "object" && "in" in v) return (v.in as unknown[]).includes(r[k]);
    return r[k] === v;
  });

const snap = (r: Row | undefined): Row | null => (r ? { ...r } : null);

export function fakeMcpOAuthDb(integration: Row | null = null) {
  const rows: Row[] = [];
  const users: Row[] = [];
  const check = (r: Row) => {
    if ((r.scope === "MEMBER") !== (r.memberId !== null)) throw new Error("owner_check");
    if (r.scope === "WORKSPACE" && (!r.workspaceAckAt || !r.workspaceAckBy)) throw new Error("workspace_ack_check");
    if (r.state === "CONNECTED" && !r.tokensEnc) throw new Error("connected_token_check");
  };
  const t = {
    // Reads return snapshots, as a database does: a row read earlier does not change under the reader.
    findFirst: async ({ where }: { where?: Row }) => snap(rows.find((r) => matches(r, where, users))),
    findUnique: async ({ where }: { where: Row }) => snap(rows.find((r) => matches(r, where, users))),
    count: async ({ where }: { where?: Row } = {}) => rows.filter((r) => matches(r, where, users)).length,
    findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Row; take?: number }) => {
      let hit = rows.filter((r) => matches(r, where, users)).map((r) => ({ ...r }));
      if (orderBy) {
        const [key, dir] = Object.entries(orderBy)[0] as [string, "asc" | "desc"];
        hit = hit.sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (dir === "desc" ? -1 : 1));
      }
      return take === undefined ? hit : hit.slice(0, take);
    },
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
      const r = rows.find((x) => matches(x, where, users));
      if (!r) throw new Error("not_found");
      const next = { ...r, ...data };
      check(next);
      Object.assign(r, next);
      return r;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const hit = rows.filter((x) => matches(x, where, users));
      for (const r of hit) { const next = { ...r, ...data }; check(next); Object.assign(r, next); }
      return { count: hit.length };
    },
  };
  const setUser = (u: Row): void => {
    const full = { role: "family", directoryStatus: "ACTIVE", deletionStatus: "NONE", username: u.id, ...u };
    const i = users.findIndex((x) => x.id === full.id);
    if (i >= 0) users[i] = full;
    else users.push(full);
  };
  const user = {
    // A lookup BY ID of a user nobody registered answers a permissive default (an active owner), so
    // tests that do not care about people need no setup. A lookup by username never invents anyone.
    findFirst: async ({ where }: { where?: Row }) => {
      const hit = users.find((u) => matches(u, where, users));
      if (hit) return { ...hit };
      if (where?.id && !users.some((u) => u.id === where.id)) {
        return { id: where.id, username: where.id, role: "owner", directoryStatus: "ACTIVE", deletionStatus: "NONE" };
      }
      return null;
    },
  };
  const prisma = {
    mcpOAuthConnection: t,
    user,
    integrationConnection: { findFirst: async () => integration },
  } as unknown as PrismaClient;
  return { prisma, rows, users, setUser, seed: (r: Row) => t.create({ data: r }) };
}
